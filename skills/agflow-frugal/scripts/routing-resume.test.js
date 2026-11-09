'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const resume = require('./routing-resume.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const accepted_record = {
	record_version: 1, task_id: 'task-1:primary', attempt_id: 'attempt-1', role: 'implementation',
	actual: { model: 'basic', effort: 'medium' }, state: 'completed', outputs: { result: 'done' }, changed_paths: [], limitations: [],
	transport: { runner_id: 'external-runner-v1', process: { pid: 1, exit_code: 0 }, worker_started: true },
	stage_input_digest: 'b'.repeat(64),
	acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
	brief_digest: 'a'.repeat(64),
	source_identity,
	requested: { tier: 'basic' },
	candidate_id: 'worker',
	kind: 'external',
}
const facts = () => ({
	task: { task_id: 'task-1' },
	source_identity,
	config: { switches: { 'allowed-worker': ['external'] } },
	records: { primary: accepted_record },
})

test('resume snapshot binds source, configuration, brief and requested controls', () => {
	const created = resume.create_snapshot(facts())
	assert.equal(created.valid, true)
	const current = {
		task_id: 'task-1',
		source_identity,
		config_digest: resume.digest(facts().config),
		input_identity: require('./routing-state.js').input_identities(facts()).identities,
		records: resume.record_identities(facts().records).identities,
	}
	assert.equal(resume.validate_snapshot(created.snapshot, current).valid, true)
	assert.match(resume.validate_snapshot(created.snapshot, {
		...current,
		source_identity: { source_kind: 'git', value: 'f'.repeat(40) },
	}).error, /source identity changed/)
	assert.match(resume.validate_snapshot(created.snapshot, {
		...current,
		config_digest: 'f'.repeat(64),
	}).error, /configuration identity changed/)
	assert.match(resume.validate_snapshot(created.snapshot, {
		...current,
		records: {
			primary: { ...current.records.primary, brief_digest: 'b'.repeat(64) },
		},
	}).error, /brief or requested-control identity changed/)
})

test('accepted records require a valid brief digest before persistence', () => {
	const invalid = facts()
	invalid.records.primary = { ...accepted_record, brief_digest: 'not-a-digest' }
	assert.match(resume.create_snapshot(invalid).error, /brief digest/)
})

test('loaded state validation uses freshly observed source and configuration', () => {
	const created = resume.create_snapshot(facts())
	const state = {
		...facts(),
		source_root: '/fixture',
		config_path: '/fixture/ag.json',
		resume_identity: created.snapshot,
	}
	const valid = resume.validate_loaded_state(state, {
		observe_source_identity: () => ({ valid: true, source_identity }),
		read_current_config: () => ({ valid: true, config: facts().config }),
	})
	assert.equal(valid.valid, true)
	const stale = resume.validate_loaded_state(state, {
		observe_source_identity: () => ({ valid: true, source_identity: { source_kind: 'git', value: 'f'.repeat(40) } }),
		read_current_config: () => ({ valid: true, config: facts().config }),
	})
	assert.match(stale.error, /source identity changed/)
})

test('resume binds actual identity, start evidence and accepted output', () => {
	const original = facts()
	const created = resume.create_snapshot(original)
	for (const change of [
		{ actual: { model: 'cheap', effort: 'low' } },
		{ transport: { ...accepted_record.transport, worker_started: false } },
		{ outputs: { result: 'changed after acceptance' } },
		{ task_id: 'wrong:primary' },
	]) {
		const altered = { ...original, records: { primary: { ...accepted_record, ...change } }, resume_identity: created.snapshot }
		const result = resume.validate_loaded_state(altered, {
			observe_source_identity: () => ({ valid: true, source_identity }),
			read_current_config: () => ({ valid: true, config: original.config }),
		})
		assert.equal(result.valid, false)
	}
})

test('resume execution identity covers complete long and omitted-key output across redaction', () => {
	const state = require('./routing-state.js')
	const original = facts()
	original.records.primary = { ...accepted_record, outputs: { result: 'A'.repeat(5000), prompt: 'private upstream value' } }
	const expected = resume.record_identities(original.records).identities.primary.execution_digest
	for (const outputs of [{ result: 'B'.repeat(5000), prompt: 'private upstream value' }, { result: 'A'.repeat(5000), prompt: 'changed upstream value' }]) {
		assert.notEqual(resume.record_identities({ primary: { ...original.records.primary, outputs } }).identities.primary.execution_digest, expected)
	}
	const projected = state.persistable_state(original)
	assert.equal(JSON.stringify(projected).includes('private upstream value'), false)
	assert.equal(resume.record_identities(projected.records).identities.primary.execution_digest, expected)
	projected.records.primary.outputs.result = 'changed persisted projection'
	assert.equal(resume.record_identities(projected.records).valid, false)
})
