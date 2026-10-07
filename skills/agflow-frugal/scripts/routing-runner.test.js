'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const runner = require('./routing-runner.js')
const state = require('./routing-state.js')
const resume = require('./routing-resume.js')

const route_config = root => {
	const config = require('./ag-settings.js').make_template('codex')
	config.switches['allowed-worker'] = ['external']
	config.switches['cli-provider'] = 'on'
	fs.writeFileSync(path.join(root, 'ag.json'), `${JSON.stringify(config)}\n`)
	return config
}

test('routing runner does not invent an external adapter without an explicit provider recipe', async () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-runner-no-adapter-'))
	const result = await runner.run({
		workspace_dir: workspace,
		task: { task_id: 'task-1' },
		admission_facts: { material_uncertainty: true },
		records: {},
	})
	assert.equal(result.status, 'unsatisfied')
})

test('routing runner refuses an external execution source that differs from the frozen source', async () => {
	const result = await runner.run({
		source_root: '/frozen/source',
		external_execution: { source_directory: '/different/source', arguments_by_stage: { primary: ['--fixture'] } },
		task: { task_id: 'task-source-mismatch' },
	})
	assert.equal(result.status, 'invalid')
	assert.match(result.requirement, /does not match the frozen routing source/)
})

test('routing inspect exposes only the redacted public state projection', async () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-runner-inspect-'))
	state.save(workspace, 'task-inspect', {
		task: { task_id: 'task-inspect', prompt: 'private prompt' },
		records: {},
		external_execution: {
			runner_options: {
				env: { API_TOKEN: 'private-token' },
			},
		},
	})
	const result = await runner.main(['inspect', 'task-inspect', workspace])
	assert.equal(result.status, 'loaded')
	const serialized = JSON.stringify(result.facts)
	assert.equal(serialized.includes('private prompt'), false)
	assert.equal(serialized.includes('private-token'), false)
	assert.equal(Object.hasOwn(result.facts, 'external_execution'), false)
})

test('routing resume rejects freshly observed identity changes before execution', async () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-runner-resume-'))
	const source_identity = { source_kind: 'git', value: '0'.repeat(40) }
	const facts = {
		task: { task_id: 'task-resume' },
		source_identity,
		config: { switches: { 'allowed-worker': ['external'] } },
		records: {},
	}
	const identity = resume.create_snapshot(facts)
	state.save(workspace, 'task-resume', {
		...facts,
		source_root: '/fixture',
		config_path: '/fixture/ag.json',
		resume_identity: identity.snapshot,
	})
	const result = await runner.main(['resume', 'task-resume', workspace], {
		observe_source_identity: () => ({
			valid: true,
			source_identity: { source_kind: 'git', value: 'f'.repeat(40) },
		}),
		read_current_config: () => ({ valid: true, config: facts.config }),
	})
	assert.equal(result.status, 'invalid')
	assert.match(result.requirement, /source identity changed/)
	assert.equal(state.load(workspace, 'task-resume').revision, 1)
})

test('configured profiles exclusively supply route selection model and effort', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-cli-profile-'))
	const config = route_config(root)
	const profile = config['external-workers'][0]
	const result = await runner.cli({
		command: 'plan',
		cwd: root,
		active_host: 'codex',
		executable_available: () => true,
		facts: {
			provider_recipes: { [profile.id]: { checked: true } },
			admission_facts: { mechanical: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true },
			task: { task_id: 'configured-profile', brief: { goal: 'bounded task' }, work_boundary: ['src/a.js'] },
		},
	})
	assert.equal(result.status, 'selected')
	assert.equal(result.selection.candidate_id, profile.id)
	assert.equal(result.selection.actual.model, profile.tiers.cheap.split('/')[0])
	assert.equal(result.selection.actual.effort, profile.tiers.cheap.split('/')[1])
})

test('live provider adapter builds configured tier arguments and keeps unobserved identity unknown', async () => {
	const config = require('./ag-settings.js').make_template('codex')
	const profile = config['external-workers'][0]
	const [model, effort] = profile.tiers.cheap.split('/')
	const source_identity = { source_kind: 'git', value: 'a'.repeat(40) }
	let launched
	const facts = {
		config,
		provider_recipes: { [profile.id]: { schema_version: 1, family: 'codex', tier: 'cheap', model, effort, checked: true, validation: 'live-provider' } },
		external_execution: {
			source_directory: process.cwd(),
			run_external_command: async options => {
				launched = options.command
				return {
					status: 'failed',
					stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'result' } }),
					result: { value: null },
					process: { pid: 123, exit_code: 1 },
					clone: { head: source_identity.value },
					limitations: [],
				}
			},
		},
	}
	const context = {
		stage: 'primary',
		tier: 'cheap',
		task: { task_id: 'provider-adapter', role: 'implementation', brief: { goal: 'test' }, work_boundary: ['src/a.js'] },
		facts: { source_identity },
		selection: { candidate_id: profile.id, actual: { model: profile.tiers.cheap.split('/')[0], effort: profile.tiers.cheap.split('/')[1] }, requested: {}, action: { command: profile.command } },
	}
	const record = await runner.adapters_for(facts).external(context)
	assert.ok(launched.includes('--json'))
	assert.ok(launched.includes(profile.tiers.cheap.split('/')[0]))
	assert.ok(launched.includes(`model_reasoning_effort=${profile.tiers.cheap.split('/')[1]}`))
	assert.equal(record.actual.model, 'unknown')
	assert.equal(record.actual.effort, 'unknown')
})

test('route CLI rejects unknown provider recipes and has deterministic status codes', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-cli-invalid-'))
	route_config(root)
	const result = await runner.cli({ command: 'plan', cwd: root, active_host: 'codex', facts: { provider_recipes: { unknown: { checked: true } } } })
	assert.equal(result.status, 'invalid')
	assert.match(result.requirement, /unknown configured profile/)
	assert.equal(runner.exit_code_for('complete'), 0)
	assert.equal(runner.exit_code_for('awaiting-executor'), 2)
	assert.equal(runner.exit_code_for('task-failed'), 4)
	assert.equal(runner.exit_code_for('invalid'), 5)
})
