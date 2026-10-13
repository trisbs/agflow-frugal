#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const coordinator = require('./routing-coordinator.js')
const lifecycle = require('./routing-lifecycle.js')
const execution = require('./routing-execution.js')
const state = require('./routing-state.js')
const resume = require('./routing-resume.js')
const ag_settings = require('./ag-settings.js')
const provider_adapters = require('./provider-adapters.js')

const read_json = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
const workspace_for = facts => facts.workspace_dir || '.agentflow'
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const profile_capabilities = (config, options = {}) => {
	if (!is_object(config) || !Array.isArray(config['external-workers'])) throw new Error('routing requires a valid ag.json external-workers configuration')
	const recipes = options.provider_recipes === undefined ? {} : options.provider_recipes
	if (!is_object(recipes)) throw new Error('provider_recipes must be an object keyed by configured profile id')
	const ids = new Set(config['external-workers'].map(profile => profile.id))
	for (const id of Object.keys(recipes)) if (!ids.has(id)) throw new Error(`provider recipe references unknown configured profile ${id}`)
	const available = typeof options.executable_available === 'function'
		? options.executable_available
		: command => ag_settings.executable_available(command, options)
	return config['external-workers'].map(profile => ({
		...profile,
		candidate_id: profile.id,
		available: available(profile.command[0]) === true,
		recipe_checked: recipes[profile.id]?.checked === true,
	}))
}

const configured_facts = (facts, options = {}) => {
	if (!is_object(facts)) throw new Error('route facts must be an object')
	const cwd = path.resolve(options.cwd || process.cwd())
	const config_path = options.config_path || ag_settings.active_config_path(cwd)
	const config = options.config || ag_settings.read_json_config(config_path, { repo_root: cwd, active_host: options.active_host })
	const profiles = profile_capabilities(config, options)
	return {
		...facts,
		config,
		config_path,
		workspace_dir: path.resolve(cwd, config.switches['workspace-dir']),
		policy: config.switches,
		capabilities: { ...(facts.capabilities || {}), external: profiles },
	}
}

const exit_code_for = status => ({
	complete: 0,
	loaded: 0,
	selected: 0,
	'awaiting-executor': 2,
	'awaiting-host': 2,
	'selection-required': 2,
	stopped: 3,
	unavailable: 3,
	'task-failed': 4,
	cancelled: 4,
	uncertain: 4,
	invalid: 5,
	unsatisfied: 5,
}[status] ?? 5)
const adapters_for = facts => {
	if (!facts.external_execution) return {}
	const configured = facts.external_execution
	const profiles = facts.config?.['external-workers'] || []
	const live_recipe_for = context => {
		const profile = profiles.find(candidate => candidate.id === context.selection.candidate_id)
		const recipe = facts.provider_recipes?.[context.selection.candidate_id]
		return recipe?.validation === 'live-provider' ? { profile, recipe } : null
	}
	return { external: execution.external_adapter({
		source_directory: configured.source_directory,
		runner_options: configured.runner_options || {},
		arguments_for_stage: (context, brief) => {
			const live = live_recipe_for(context)
			if (live) return provider_adapters.build_invocation({ profile: live.profile, recipe: live.recipe, context, brief }).arguments
			return configured.arguments_by_stage?.[context.stage]
		},
		result_format_for_stage: context => live_recipe_for(context) ? 'text' : 'json',
		parse_output: ({ context, runner }) => {
			const live = live_recipe_for(context)
			return live ? provider_adapters.parse_output(live.profile.family, runner.stdout) : { value: runner.result.value }
		},
		read_only_recipe_for_stage: context => configured.read_only_recipes_by_stage?.[context.stage],
		verification_for_stage: context => configured.verification_by_stage?.[context.stage] || [],
		verify_stage: configured.verify_stage,
		observe_transport: configured.observe_transport,
		run_external_command: configured.run_external_command,
		enforce_read_only: (context, args) => context.stage !== 'assessment' || configured.read_only_stages?.includes('assessment') === true && args.length > 0,
	}) }
}
const run = async (facts, options = {}) => {
	const expected_source = facts.source_root || facts.repository_root
	if (facts.external_execution?.source_directory && expected_source && path.resolve(facts.external_execution.source_directory) !== path.resolve(expected_source)) {
		return { status: 'invalid', requirement: 'external execution source does not match the frozen routing source' }
	}
	const result = await lifecycle.run_lifecycle(facts, options.adapters || adapters_for(facts), { max_actions: options.max_actions })
	if (result.facts?.task?.task_id) {
		const source_root = facts.source_root || facts.repository_root || facts.external_execution?.source_directory
		const config_path = facts.config_path || (source_root ? path.join(source_root, 'ag.json') : undefined)
		const identity = resume.create_snapshot({
			...result.facts,
			source_identity: facts.source_identity || result.facts.source_identity,
			config: facts.config || result.facts.config,
		})
		state.save(
			workspace_for(facts),
			result.facts.task.task_id,
			{
				...result.facts,
				...(source_root ? { source_root } : {}),
				...(config_path ? { config_path } : {}),
				...(identity.valid ? { resume_identity: identity.snapshot } : {}),
			},
			{ expected_revision: options.expected_revision ?? 0 },
		)
	}
	return result
}
const inspect = (task_id, workspace) => {
	const loaded = state.load(workspace, task_id)
	return loaded
		? { status: 'loaded', revision: loaded.revision, digest: loaded.digest, facts: state.public_projection(loaded.state) }
		: { status: 'invalid', requirement: 'routing state does not exist' }
}
const resume_with_config = async (task_id, workspace, config_path, options = {}) => {
	const loaded = state.load(workspace, task_id)
	if (!loaded) return { status: 'invalid', requirement: 'routing state does not exist' }
	if (loaded.state.config_path && path.resolve(loaded.state.config_path) !== path.resolve(config_path)) {
		return { status: 'invalid', requirement: 'routing state belongs to a different ag.json configuration' }
	}
	if (options.external_execution?.source_directory && path.resolve(options.external_execution.source_directory) !== path.resolve(loaded.state.source_root)) {
		return { status: 'invalid', requirement: 'external execution source does not match the frozen routing source' }
	}
	let config
	try {
		config = ag_settings.read_json_config(config_path, { repo_root: loaded.state.source_root, active_host: options.active_host })
	} catch (error) {
		return { status: 'invalid', requirement: `current routing configuration is invalid: ${error instanceof Error ? error.message : String(error)}` }
	}
	const identity = resume.validate_loaded_state(loaded.state, {
		...(options.identity_dependencies || {}),
		read_current_config: () => ({ valid: true, config }),
	})
	if (!identity.valid) return { status: 'invalid', requirement: identity.error }
	const prepared = configured_facts({
		...loaded.state,
		...(options.external_execution ? { external_execution: options.external_execution } : {}),
		workspace_dir: workspace,
	}, {
		cwd: loaded.state.source_root,
		config_path,
		config,
		active_host: options.active_host,
		provider_recipes: options.provider_recipes || {},
		executable_available: options.executable_available,
	})
	prepared.workspace_dir = workspace
	return run(prepared, { ...options, expected_revision: loaded.revision })
}
const cli = async ({ command, cwd, facts, task_id, ...options }) => {
	try {
		const root = path.resolve(cwd || process.cwd())
		const config_path = ag_settings.active_config_path(root)
		const config = ag_settings.read_json_config(config_path, { repo_root: root, active_host: options.active_host })
		const workspace = path.resolve(root, config.switches['workspace-dir'])
		if (command === 'plan' || command === 'run') {
			const prepared = configured_facts(facts, {
				...options,
				cwd: root,
				config,
				config_path,
				provider_recipes: facts.provider_recipes,
			})
			return command === 'plan' ? coordinator.plan_next_action(prepared) : run(prepared)
		}
		if (command === 'inspect') return inspect(task_id, workspace)
		if (command === 'resume') return resume_with_config(task_id, workspace, config_path, options)
		return { status: 'invalid', requirement: 'unsupported route command' }
	} catch (error) {
		return { status: 'invalid', requirement: error instanceof Error ? error.message : String(error) }
	}
}
const main = async (argv, dependencies = {}) => {
	const [command, argument, workspace] = argv
	if (command === 'plan' && argument) return coordinator.plan_next_action(read_json(argument))
	if (command === 'run' && argument) return run(read_json(argument))
	if (command === 'resume' && argument) {
		const loaded = state.load(workspace || '.agentflow', argument)
		if (!loaded) return { status: 'invalid', requirement: 'routing state does not exist' }
		const identity = resume.validate_loaded_state(loaded.state, dependencies)
		if (!identity.valid) return { status: 'invalid', requirement: identity.error }
		return run(
			{ ...loaded.state, workspace_dir: workspace || '.agentflow' },
			{ expected_revision: loaded.revision },
		)
	}
	if (command === 'inspect' && argument) {
		return inspect(argument, workspace || '.agentflow')
	}
	throw new Error('usage: node routing-runner.js <plan|run> <facts.json> | <resume|inspect> <task-id> [workspace]')
}

module.exports = { adapters_for, profile_capabilities, configured_facts, exit_code_for, run, inspect, resume_with_config, cli, main }

if (require.main === module) main(process.argv.slice(2)).then(result => {
	process.stdout.write(`${JSON.stringify(result)}\n`)
	if (!['complete', 'loaded', 'selected'].includes(result.status)) process.exitCode = 1
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
