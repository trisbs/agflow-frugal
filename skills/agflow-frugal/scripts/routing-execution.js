'use strict'

const child_process = require('node:child_process')
const external_runner = require('./external-runner.js')
const contract = require('./routing-contract.js')
const brief_builder = require('./routing-brief.js')
const read_only = require('./routing-read-only.js')

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const clone = value => JSON.parse(JSON.stringify(value))
const changed_paths = root => child_process.execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean).map(line => line.slice(3)).filter(Boolean)
const safe_relative_path = value => text(value) && !value.startsWith('/') && !value.split('/').includes('..')
const unknown_source_identity = () => ({ source_kind: 'unknown', value: 'unknown' })
const observed_source_identity = runner => /^[0-9a-f]{40}$/u.test(runner?.clone?.head)
	? { source_kind: 'git', value: runner.clone.head }
	: unknown_source_identity()
const observed_text = value => text(value) && value !== 'unknown' ? value : 'unknown'
const observed_actual = observation => ({
	model: observed_text(observation?.model),
	effort: observed_text(observation?.effort),
	...(observation?.fresh_context === true ? { fresh_context: true } : {}),
})
const settled_state = (runner, acceptance) => {
	if (acceptance.accepted) return 'completed'
	if (runner.status === 'spawn_error') return 'unavailable'
	if (runner.status === 'cancelled') return runner.process_group_timeout?.terminated === true ? 'cancelled' : 'uncertain'
	if (['timed_out', 'stalled', 'nested_worker_violation'].includes(runner.status) || runner.process?.ownership === 'lost') return 'uncertain'
	return 'task-failed'
}
const same_source_identity = (left, right) => left?.source_kind === right?.source_kind && left?.value === right?.value
const attribution_error = ({ context, runner, actual, source_identity }) => {
	if (runner.process?.ownership === 'lost') return 'external process ownership was lost'
	if (['timed_out', 'stalled', 'nested_worker_violation'].includes(runner.status)) return 'external process settlement is uncertain'
	if (source_identity.source_kind !== 'git') return 'external execution did not expose an observed clone HEAD'
	if (!same_source_identity(source_identity, context.facts.source_identity)) return 'external clone HEAD does not match the frozen source identity'
	const requested = context.selection.requested || {}
	if (requested.exact_model && actual.model !== requested.exact_model) return `actual provider model does not satisfy exact model ${requested.exact_model}`
	if (requested.exact_effort && actual.effort !== requested.exact_effort) return `actual provider effort does not satisfy exact effort ${requested.exact_effort}`
	if (context.task.require_fresh_context === true && actual.fresh_context !== true) return 'required fresh context was not observed from the transport'
	return null
}
const within_boundary = (changed_path, boundary) => safe_relative_path(changed_path) && Array.isArray(boundary) && boundary.some(allowed_path => {
	if (!safe_relative_path(allowed_path)) return false
	const normalized = allowed_path.replace(/\/+$/u, '')
	return changed_path === normalized || changed_path.startsWith(`${normalized}/`)
})
const verification_error = (commands, verification) => {
	if (!is_object(verification) || verification.coordinator_inspected !== true || !Array.isArray(verification.results)) {
		return 'coordinator acceptance evidence is required'
	}
	if (!Array.isArray(commands) || verification.results.length !== commands.length) {
		return 'coordinator verification results must match named verification commands'
	}
	for (let index = 0; index < commands.length; index += 1) {
		const result = verification.results[index]
		if (!is_object(result) || result.passed !== true || JSON.stringify(result.command) !== JSON.stringify(commands[index])) {
			return 'coordinator verification did not pass every named command'
		}
	}
	return null
}

const observed_process = process => {
	if (!is_object(process)) return undefined
	const result = {}
	if (Number.isInteger(process.pid)) result.pid = process.pid
	if (Number.isInteger(process.exit_code) || process.exit_code === null) result.exit_code = process.exit_code
	if (text(process.signal) || process.signal === null) result.signal = process.signal
	if (text(process.error) || process.error === null) result.error = process.error
	return Object.keys(result).length > 0 ? result : undefined
}

const execution_record = ({ context, runner, paths, brief, outputs = {}, acceptance, reason, read_only_proof, transport_observation }) => {
	const checked_read_only = read_only.validate_dispatch_proof(read_only_proof)
	const process = observed_process(runner.process)
	return {
	record_version: 1,
	task_id: context.task.task_id,
	attempt_id: `${context.task.task_id}:external`,
	candidate_id: context.selection.candidate_id,
	kind: 'external',
	role: context.task.role,
		source_identity: observed_source_identity(runner),
		requested: clone(context.selection.requested || {}),
		actual: observed_actual(transport_observation),
		state: settled_state(runner, acceptance),
	outputs,
	changed_paths: paths,
	acceptance,
	limitations: [...(runner.limitations || [])],
	transport: {
		runner_id: 'external-runner-v1',
		recipe_checked: true,
		read_only: checked_read_only.valid,
		...(runner.status === 'spawn_error' ? { worker_started: false } : {}),
		...(Number.isInteger(runner.process?.pid) ? { worker_started: true } : {}),
		...(runner.status === 'cancelled' && runner.process_group_timeout?.terminated === true ? { stop_verified: true } : {}),
		...(checked_read_only.valid ? { read_only_proof: checked_read_only.proof } : {}),
			...(process ? { process: clone(process) } : {}),
			...(text(runner.clone?.root) ? { clone: { path: runner.clone.root, ...(text(runner.clone?.head) ? { head: runner.clone.head } : {}) } } : {}),
			...(transport_observation?.fresh_context === true ? { fresh_context: true } : {}),
	},
	brief_digest: brief.digest,
	...(reason ? { reason } : {}),
	}
}

const accepted_record = ({ context, runner, output, paths, brief, verification, verification_commands = [], read_only_proof, transport_observation }) => {
	const source_identity = context.facts.source_identity
	if (!is_object(source_identity)) throw new Error('routing execution requires source_identity')
	if (!Array.isArray(paths)) throw new Error('routing execution requires observed changed paths')
	const failure = reason => execution_record({
		context,
		runner,
		paths,
		brief,
		acceptance: {
			checks_run: false,
			coordinator_inspected: verification?.coordinator_inspected === true,
			accepted: false,
		},
		reason,
		read_only_proof,
		transport_observation,
	})
	if (runner.status !== 'completed') return failure(`external runner ${runner.status}`)
	const attribution = attribution_error({
		context,
		runner,
		actual: observed_actual(transport_observation),
		source_identity: observed_source_identity(runner),
	})
	if (attribution) return failure(attribution)
	const inspection_error = verification_error(verification_commands, verification)
	if (inspection_error) return failure(inspection_error)
	if (context.task.require_read_only === true && !read_only.validate_dispatch_proof(read_only_proof).valid) {
		return failure('required read-only control has no validated dispatch proof')
	}
	if (context.stage !== 'assessment' && paths.some(changed_path => !within_boundary(changed_path, context.task.work_boundary))) {
		return failure('worker changed a path outside the frozen work boundary')
	}
	let outputs
	if (context.stage === 'assessment') {
		const checked = contract.validate_assessment(output, { task_id: context.task.task_id, source_identity })
		if (!checked.valid) return failure(checked.error)
		if (paths.length > 0) return failure('assessment changed source paths')
		outputs = { routing_assessment_envelope: checked.envelope }
	} else if (context.stage === 'review') {
		const checked = contract.validate_review(output, { task_id: context.task.task_id, source_identity, review_accepted: true })
		if (!checked.valid) return failure(checked.error)
		outputs = { review_envelope: checked.envelope }
	} else {
		if (output === null || output === undefined || output === '') return failure('worker returned no structured output')
		outputs = { result: output }
	}
	return execution_record({
		context,
		runner,
		paths,
		brief,
		outputs,
		acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
		read_only_proof,
		transport_observation,
	})
}

const external_adapter = options => async context => {
	if (!is_object(options) || typeof options.arguments_for_stage !== 'function' || !text(options.source_directory)) throw new Error('external adapter requires source_directory and arguments_for_stage')
	let read_only_recipe
	if (context.task.require_read_only === true) {
		const checked = read_only.validate_recipe(options.read_only_recipe_for_stage?.(context))
		if (!checked.valid) throw new Error(checked.error)
		if (checked.recipe.validation === 'fixture' && options.allow_fixture_recipe !== true) {
			throw new Error('fixture read-only recipes are test-only; live-provider validation remains required')
		}
		read_only_recipe = checked.recipe
	}
	const verification_commands = options.verification_for_stage?.(context) || []
	if (!Array.isArray(verification_commands)) throw new Error('stage verification commands must be an array')
	const brief = brief_builder.build({ stage: context.stage, task: context.task, source_identity: context.facts.source_identity, tier: context.tier, verification: verification_commands })
	const args = options.arguments_for_stage(context, brief.brief)
	if (!Array.isArray(args) || args.some(arg => !text(arg))) throw new Error('provider recipe must return a literal non-empty argument array')
	const command = [
		...context.selection.action.command,
		...(read_only_recipe?.arguments || []),
		...args,
	]
	const read_only_result = read_only_recipe
		? read_only.create_dispatch_proof(read_only_recipe, command)
		: { valid: true, proof: undefined }
	if (!read_only_result.valid) throw new Error(read_only_result.error)
	const result_format = options.result_format_for_stage?.(context) || 'json'
	const runner = await (options.run_external_command || external_runner.run_external_command)({ ...options.runner_options, source_directory: options.source_directory, command, result_format })
	const parsed = typeof options.parse_output === 'function'
		? await options.parse_output({ context, runner, command: clone(command) })
		: { value: runner.result.value }
	const transport_observation = typeof options.observe_transport === 'function'
		? await options.observe_transport({ context, runner, command: clone(command) })
		: parsed?.observation
	const paths = runner.status === 'completed' && text(runner.clone?.root) ? changed_paths(runner.clone.root) : []
	const verification = typeof options.verify_stage === 'function'
		? await options.verify_stage({ context, runner, root: runner.clone?.root, commands: clone(verification_commands) })
		: verification_commands.length === 0
			? { coordinator_inspected: true, results: [] }
			: { coordinator_inspected: false, results: [] }
	return accepted_record({ context, runner, output: parsed?.value, paths, brief, verification, verification_commands, read_only_proof: read_only_result.proof, transport_observation })
}

module.exports = { changed_paths, safe_relative_path, within_boundary, unknown_source_identity, observed_source_identity, observed_actual, settled_state, attribution_error, observed_process, execution_record, accepted_record, external_adapter }
