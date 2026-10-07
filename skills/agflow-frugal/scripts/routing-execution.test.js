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
	const result = execution.accepted_record({ context, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(result.state, 'completed')
	assert.equal(result.acceptance.accepted, true)
	assert.equal(result.transport.read_only, true)
	assert.equal(result.transport.read_only_proof.validation, 'fixture')
	assert.equal(result.outputs.routing_assessment_envelope.task_id, 'task:assessment')
	assert.equal(execution.accepted_record({ context, runner, output: envelope, paths: ['a.js'], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof }).state, 'task-failed')
	const missing_proof = execution.accepted_record({ context, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected })
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
	const missing_inspection = execution.accepted_record({
		context: primary_context,
		runner,
		output: { result: 'done' },
		paths: ['src/a.js'],
		brief: { digest: 'digest' },
	})
	assert.equal(missing_inspection.state, 'task-failed')
	assert.equal(missing_inspection.acceptance.accepted, false)
	assert.match(missing_inspection.reason, /coordinator acceptance evidence/)

	const escaped = execution.accepted_record({
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
	assert.equal(record.actual.model, 'unknown')
})

test('acceptance never copies requested model identity into actual attribution', () => {
	const runner = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }
	const selected = { ...context, selection: { ...context.selection, requested: { model: 'requested-model', effort: 'high' } } }
	const result = execution.accepted_record({ context: selected, runner, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof, transport_observation: { model: 'observed-model', effort: 'low' } })
	assert.equal(result.actual.model, 'observed-model')
	assert.equal(result.actual.effort, 'low')
	assert.equal(result.requested.model, 'requested-model')
})

test('clone mismatch, exact requirements, and uncertain settlement fail closed', () => {
	const completed = { status: 'completed', process: { pid: 101, exit_code: 0 }, clone: { root: '/tmp/clone', head: 'f'.repeat(40) }, limitations: [] }
	const mismatch = execution.accepted_record({ context, runner: completed, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(mismatch.state, 'task-failed')
	assert.match(mismatch.reason, /clone HEAD/)
	const exact = execution.accepted_record({ context: { ...context, selection: { ...context.selection, requested: { exact_model: 'required-model' } } }, runner: { ...completed, clone: { root: '/tmp/clone', head: source_identity.value } }, output: envelope, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(exact.state, 'task-failed')
	assert.match(exact.reason, /exact model/)
	const uncertain = execution.accepted_record({ context, runner: { status: 'timed_out', process: { pid: 101, exit_code: null }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }, output: null, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
	assert.equal(uncertain.state, 'uncertain')
})

test('unavailable provider metadata remains explicitly unknown', () => {
	const record = execution.accepted_record({ context, runner: { status: 'spawn_error', process: { error: 'missing executable' }, clone: { root: '/tmp/clone', head: source_identity.value }, limitations: [] }, output: null, paths: [], brief: { digest: 'digest' }, verification: inspected, read_only_proof: fixture_proof })
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
