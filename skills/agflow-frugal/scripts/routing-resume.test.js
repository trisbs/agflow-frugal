'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const resume = require('./routing-resume.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const accepted_record = {
	acceptance: { accepted: true },
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
