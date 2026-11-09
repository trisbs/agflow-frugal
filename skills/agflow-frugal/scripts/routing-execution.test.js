'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const child_process = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const execution = require('./routing-execution.js')
const read_only = require('./routing-read-only.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const context = { stage: 'assessment', task: { task_id: 'task:assessment', role: 'explore', requested_tier: 'basic', require_read_only: true, brief: { goal: 'Assess' }, work_boundary: [] }, facts: { source_identity }, selection: { candidate_id: 'worker', requested: {}, actual: { model: 'basic', effort: 'medium' } } }
const envelope = { schema_version: 1, task_id: 'task:assessment', source_identity, facts: { material_uncertainty: true, substantial_mechanical_execution: false, high_consequence: false, difficult_rollback: false, material_disagreement: false, material_risk: false, deterministic_verification_sufficient: true, risk_flags: [], missing_information: [] }, evidence: [{ fact: 'material_uncertainty', source: 'a.js', observation: 'uncertain' }, { fact: 'deterministic_verification_sufficient', source: 'test', observation: 'exists' }] }
const inspected = { coordinator_inspected: true, results: [] }
const accepted = options => execution.accepted_record({ transport_observation: context.selection.actual, ...options })
const fixture_recipe = {
	schema_version: 1,
	provider: 'fixture-cli',
	source_access: 'read-only',
	arguments: ['--fixture-read-only'],
	validation: 'fixture',
}
const fixture_proof = read_only.create_dispatch_proof(fixture_recipe, ['fixture-cli', '--fixture-read-only']).proof

test('acceptance builds a coordinator-owned assessment record only for valid no-write output', () => {
	const runner = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }
	const result = accepted({ context, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(result.state, 'completed')
	assert.equal(result.acceptance.accepted, true)
	assert.equal(result.transport.read_only, true)
	assert.equal(result.transport.read_only_proof.validation, 'fixture')
	assert.equal(result.outputs.routing_assessment_envelope.task_id, 'task:assessment')
	assert.equal(accepted({ context, runner, output: envelope, paths: ['a.js'], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof }).state, 'task-failed')
	const missing_proof = accepted({ context, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected })
	assert.equal(missing_proof.state, 'task-failed')
	assert.equal(missing_proof.transport.read_only, false)
	assert.match(missing_proof.reason, /no validated dispatch proof/)
})

test('acceptance fails closed without coordinator inspection or within-boundary changes', () => {
	const runner = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }
	const primary_context = {
		...context,
		stage: 'primary',
		task: { ...context.task, task_id: 'task:primary', role: 'implementation', require_read_only: false, work_boundary: ['src'] },
	}
	const missing_inspection = accepted({
		context: primary_context,
		runner,
		output: { result: 'done' },
		paths: ['src/a.js'],
		brief: { digest: 'digest' },
	})
	assert.equal(missing_inspection.state, 'task-failed')
	assert.equal(missing_inspection.acceptance.accepted, false)
	assert.match(missing_inspection.reason, /coordinator acceptance evidence/)

	const escaped = accepted({
		context: primary_context,
		runner,
		output: { result: 'done' },
		paths: ['outside.txt'],
		brief: { digest: 'digest' },
		verification: inspected,
	})
	assert.equal(escaped.state, 'task-failed')
	assert.equal(escaped.acceptance.accepted, false)
	assert.match(escaped.reason, /frozen work boundary/)
})

test('external adapter runs a real child process in an independent clone', async t => {
	const source = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-execution-source-'))
	try { child_process.execFileSync('git', ['init', '-q', source]) } catch (error) {
		if (error.code === 'EPERM') t.skip('sandbox blocks child-process Git fixtures')
		else throw error
		return
	}
	fs.writeFileSync(path.join(source, 'a.txt'), 'fixture\n')
	child_process.execFileSync('git', ['-C', source, 'add', 'a.txt'])
	child_process.execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
	const source_head = child_process.execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
	const actual_source = { source_kind: 'git', value: source_head }
	const actual_envelope = { ...envelope, source_identity: actual_source }
	const node_fixture_recipe = { ...fixture_recipe, provider: 'fixture-node', arguments: ['--input-type=commonjs'] }
	const adapter = execution.external_adapter({
		source_directory: source,
		arguments_for_stage: () => ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(actual_envelope))})`],
		read_only_recipe_for_stage: () => node_fixture_recipe,
		allow_fixture_recipe: true,
		verify_stage: async () => inspected,
		observe_transport: () => ({ model: 'basic', effort: 'medium' }),
	})
	const record = await adapter({
		...context,
		facts: { source_identity: actual_source },
		selection: { ...context.selection, action: { command: [process.execPath] } },
		tier: 'basic',
		task: { ...context.task, task_id: actual_envelope.task_id },
	})
	assert.equal(record.state, 'completed')
	assert.equal(record.changed_paths.length, 0)
	assert.equal(record.transport.runner_id, 'external-runner-v1')
	assert.equal(record.transport.read_only_proof.validation, 'fixture')
	assert.equal(record.source_identity.value, source_head)
	assert.equal(record.actual.model, 'basic')
})

test('failed external process returns a safe diagnostic without invoking result callbacks', async () => {
	let parse_calls = 0
	let observation_calls = 0
	let verification_calls = 0
	const adapter = execution.external_adapter({
		source_directory: process.cwd(),
		arguments_for_stage: () => ['--fixture'],
		read_only_recipe_for_stage: () => fixture_recipe,
		allow_fixture_recipe: true,
		parse_output: async () => { parse_calls += 1; return { value: 'parsed secret' } },
		observe_transport: async () => { observation_calls += 1; return { model: 'basic', effort: 'medium' } },
		verify_stage: async () => { verification_calls += 1; return inspected },
		run_external_command: async () => ({
			status: 'failed',
			stdout: 'private prompt and token=output-secret',
			stderr: 'EROFS: read-only file system at /private/runtime; token=stderr-secret',
			stderr_bytes: 71,
			stderr_truncated: false,
			result: { value: 'untrusted output' },
			process: { pid: 101, exit_code: 1, error: 'private process error /private/runtime' },
			clone: { head: source_identity.value },
			limitations: [],
		}),
	})
	const result = await adapter({
		...context,
		selection: { ...context.selection, action: { command: ['fixture-cli'] } },
		tier: 'basic',
	})
	assert.equal(result.state, 'task-failed')
	assert.equal(result.acceptance.accepted, false)
	assert.equal(parse_calls, 0)
	assert.equal(observation_calls, 0)
	assert.equal(verification_calls, 0)
	assert.deepEqual(result.transport.failure, {
		version: 1,
		outcome: 'nonzero_exit',
		clue: 'read_only_filesystem',
		clue_source: 'stderr_indicator',
		stderr_bytes: 71,
		stderr_truncated: false,
		recovery_hint: 'Use an executor runtime with writable state, then authorize a new attempt.',
	})
	const saved_view = JSON.stringify(result)
	for (const secret of ['output-secret', 'stderr-secret', 'private/runtime', 'private process error', 'parsed secret', 'untrusted output']) {
		assert.equal(saved_view.includes(secret), false)
	}
	assert.equal(Object.hasOwn(result.transport.process, 'error'), false)
})

test('failure diagnostics normalize lifecycle outcomes and unknown captured causes', () => {
	const cases = [
		[{ status: 'spawn_error', process: { error: 'private executable path' } }, 'spawn_error'],
		[{ status: 'failed', process: { exit_code: 1 } }, 'nonzero_exit'],
		[{ status: 'failed', process: { exit_code: null, signal: 'SIGTERM' } }, 'signaled'],
		[{ status: 'failed', process: { exit_code: null } }, 'unknown'],
		[{ status: 'failed', process: { exit_code: 0 } }, 'unknown'],
		[{ status: 'timed_out', process: { pid: 101, exit_code: null } }, 'timed_out'],
		[{ status: 'stalled', process: { pid: 101, exit_code: null } }, 'stalled'],
		[{ status: 'cancelled', process: { pid: 101, exit_code: null } }, 'cancelled'],
		[{ status: 'nested_worker_violation', process: { pid: 101, exit_code: 1 } }, 'nested_worker_violation'],
		[{ status: 'future-status', process: { pid: 101, exit_code: 1 } }, 'unknown'],
	]
	for (const [runner, outcome] of cases) {
		const record = accepted({ context, runner: { ...runner, stderr: 'unrecognized token=private-value', stderr_truncated: true }, paths: [], brief: { digest: 'digest' } })
		assert.equal(record.transport.failure.outcome, outcome)
		assert.equal(record.transport.failure.clue, 'unknown')
		assert.equal(record.transport.failure.clue_source, 'none')
		assert.equal(record.transport.failure.stderr_truncated, true)
		assert.equal(JSON.stringify(record).includes('private-value'), false)
	}
	const permission = accepted({
		context,
		runner: { status: 'failed', stderr: 'EACCES permission denied', process: { exit_code: 1 }, limitations: [] },
		paths: [], brief: { digest: 'digest' },
	})
	assert.equal(permission.transport.failure.clue, 'permission_denied')
	assert.equal(permission.transport.failure.clue_source, 'stderr_indicator')

	const shared = ['codex-profile', 'claude-profile'].map(candidate_id => accepted({
		context: { ...context, selection: { ...context.selection, candidate_id } },
		runner: { status: 'failed', stderr: 'ordinary failure', process: { exit_code: 1 }, limitations: [] },
		paths: [], brief: { digest: 'digest' },
	}).transport.failure)
	assert.deepEqual(shared[0], shared[1])
})

test('acceptance never copies requested model identity into actual attribution', () => {
	const runner = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }
	const selected = { ...context, selection: { ...context.selection, requested: { model: 'requested-model', effort: 'high' } } }
	const result = accepted({ context: selected, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof, transport_observation: { model: 'observed-model', effort: 'low' } })
	assert.equal(result.actual.model, 'observed-model')
	assert.equal(result.actual.effort, 'low')
	assert.equal(result.requested.model, 'requested-model')
})

test('clone mismatch, exact requirements, and uncertain settlement fail closed', () => {
	const completed = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: 'f'.repeat(40) }, limitations: [] }
	const mismatch = accepted({ context, runner: completed, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(mismatch.state, 'task-failed')
	assert.match(mismatch.reason, /clone HEAD/)
	const exact = accepted({ context: { ...context, selection: { ...context.selection, requested: { exact_model: 'required-model' } } }, runner: { ...completed, clone: { root: '/tmp/clone', head: source_identity.value } }, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(exact.state, 'task-failed')
	assert.match(exact.reason, /exact model/)
	const uncertain = accepted({ context, runner: { status: 'timed_out', process: { pid: 101, exit_code: null }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }, output: null, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(uncertain.state, 'uncertain')
})

test('unavailable provider metadata remains explicitly unknown', () => {
	const record = accepted({ transport_observation: undefined, context, runner: { status: 'spawn_error', process: { error: 'missing executable' }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }, output: null, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(record.state, 'unavailable')
	assert.equal(record.actual.model, 'unknown')
	assert.equal(record.actual.effort, 'unknown')
	assert.equal(record.transport.worker_started, false)
})

test('external adapter rejects fixture recipes outside explicit fixture mode', async () => {
	const adapter = execution.external_adapter({
		source_directory: process.cwd(),
		arguments_for_stage: () => ['inspect'],
		read_only_recipe_for_stage: () => fixture_recipe,
	})
	await assert.rejects(
		adapter({ ...context, selection: { ...context.selection, action: { command: ['fixture-cli'] } }, tier: 'basic' }),
		/fixture read-only recipes are test-only/,
	)
})

test('completed external work needs dispatch identity and a real process start, with optional observation', () => {
	const runner = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { head: source_identity.value }, limitations: [] }
	for (const observation of [undefined, { model: 'basic', effort: 'unknown' }]) {
		const result = accepted({ context, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof, transport_observation: observation })
		assert.equal(result.state, 'completed', result.reason)
	}
	const unstarted = accepted({ context, runner: { ...runner, process: { exit_code: 0 } }, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(unstarted.state, 'task-failed')
	assert.equal(unstarted.transport.worker_started, false)
	assert.match(unstarted.reason, /start evidence/)
	const failed = accepted({ context, runner: { ...runner, status: 'spawn_error', process: { error: 'ENOENT' } }, output: null, paths: [], brief: { digest: 'digest' }, verification: inspected })
	assert.equal(failed.transport.worker_started, false)
	const bad_output = accepted({ context, runner, output: null, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(bad_output.transport.worker_started, true)
	assert.equal(bad_output.acceptance.accepted, false)
})

test('provider message JSON is decoded by the assessment and review contracts before acceptance', async () => {
	const providers = require('./provider-adapters.js')
	const contract = require('./routing-contract.js')
	for (const family of ['codex', 'claude']) {
		for (const stage of ['assessment', 'review']) {
			const stage_context = { ...context, stage, task: { ...context.task, task_id: `task:${stage}`, require_read_only: stage === 'assessment' } }
			const output = stage === 'assessment' ? envelope : {
				schema_version: 1, task_id: 'task:review', source_identity,
				facts: Object.fromEntries([...contract.definitions.review.boolean.map(key => [key, false]), ...contract.definitions.review.scores.map(key => [key, 0])]), evidence: [],
			}
			for (const message of [JSON.stringify(output), 'not JSON', JSON.stringify({ ...output, task_id: 'wrong-stage' })]) {
				const stdout = family === 'codex' ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }) : JSON.stringify({ result: message, modelUsage: { basic: {} } })
				const result = await execution.external_adapter({
					source_directory: process.cwd(), arguments_for_stage: () => ['fixture'],
					allow_fixture_recipe: true, read_only_recipe_for_stage: () => fixture_recipe,
					parse_output: ({ runner }) => providers.parse_output(family, runner.stdout),
					observe_transport: ({ runner }) => runner.transport_observation,
					run_external_command: async () => ({ status: 'completed', stdout, result: { value: null }, process: { pid: 101, exit_code: 0 }, clone: { head: source_identity.value }, limitations: [], transport_observation: { model: 'basic', effort: 'medium' } }),
				})({ ...stage_context, tier: 'basic', selection: { ...context.selection, action: { command: ['fixture-cli'] } } })
				assert.equal(result.acceptance.accepted, message === JSON.stringify(output), `${family} ${stage}: ${result.reason}`)
			}
		}
	}
})

test('plan quality JSON is normalized before persistence and read-only receipts reject even in-boundary changes', () => {
	const runner = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }
	for (const stage of ['plan-review', 'resolution']) {
		const plan_context = { ...context, stage, task: { ...context.task, task_id: `task:${stage}`, work_boundary: ['src'] } }
		const output = stage === 'plan-review' ? { findings: [] } : { plan: 'Final plan '.repeat(600), findings: [] }
		const options = { context: plan_context, runner, output: JSON.stringify(output), paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof }
		assert.deepEqual(accepted(options).outputs.result, output)
		assert.equal(accepted({ ...options, paths: ['src/a.js'] }).state, 'task-failed')
	}
})
