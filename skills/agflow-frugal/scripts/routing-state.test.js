'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const state = require('./routing-state.js')

test('routing state is atomically persisted and integrity checked', () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-state-'))
	const saved = state.save(workspace, 'task-1:assessment', { task: { task_id: 'task-1' }, records: {} })
	assert.ok(fs.existsSync(saved.path))
	assert.equal(saved.revision, 1)
	assert.equal(saved.prior_digest, null)
	assert.deepEqual(state.load(workspace, 'task-1:assessment').state.records, {})
	assert.throws(() => state.state_path(workspace, '../escape'))
})

test('routing state rejects stale revisions and retains the prior digest chain', () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-state-revision-'))
	const first = state.save(workspace, 'task-1', { task: { task_id: 'task-1' }, records: {} })
	assert.throws(
		() => state.save(workspace, 'task-1', { task: { task_id: 'task-1' }, records: { primary: {} } }),
		/stale/,
	)
	const second = state.save(
		workspace,
		'task-1',
		{ task: { task_id: 'task-1' }, records: { primary: {} } },
		{ expected_revision: first.revision },
	)
	assert.equal(second.revision, 2)
	assert.equal(second.prior_digest, first.digest)
})

test('routing state preserves the last valid revision when replacement is interrupted', () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-state-interrupted-'))
	const first = state.save(workspace, 'task-1', { task: { task_id: 'task-1' }, records: {} })
	const rename = fs.renameSync
	fs.renameSync = () => { throw new Error('simulated interruption before atomic replacement') }
	try {
		assert.throws(
			() => state.save(workspace, 'task-1', { task: { task_id: 'task-1' }, records: { primary: {} } }, { expected_revision: first.revision }),
			/simulated interruption/,
		)
	} finally {
		fs.renameSync = rename
	}
	const loaded = state.load(workspace, 'task-1')
	assert.equal(loaded.revision, first.revision)
	assert.equal(loaded.digest, first.digest)
	assert.deepEqual(loaded.state.records, {})
	assert.deepEqual(fs.readdirSync(path.dirname(first.path)), ['state.json'])
})

test('routing state rejects symbolic-link traversal', t => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-state-link-'))
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-state-outside-'))
	try {
		fs.symlinkSync(outside, path.join(workspace, 'routing'), 'dir')
	} catch (error) {
		if (['EPERM', 'EACCES'].includes(error.code)) {
			t.skip('sandbox does not permit symlink fixtures')
			return
		}
		throw error
	}
	assert.throws(
		() => state.save(workspace, 'task-1', { task: { task_id: 'task-1' }, records: {} }),
		/symbolic link/,
	)
	assert.equal(fs.existsSync(path.join(outside, 'task-1', 'state.json')), false)
})

test('routing state persists only redacted allowlisted fields', () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-state-redaction-'))
	const saved = state.save(workspace, 'task-1', {
		task: {
			task_id: 'task-1',
			prompt: 'private task prompt',
			work_boundary: ['src/a.js'],
		},
		briefs: {
			primary: { goal: 'safe stage goal', prompt: 'private brief prompt', command: ['private-command'] },
		},
		launched_candidates: ['fixture-profile'],
		config: {
			switches: { 'allowed-worker': ['external'] },
			token: 'private-token',
			command: ['provider', '--secret'],
		},
		records: {},
		external_execution: {
			runner_options: {
				env: { API_TOKEN: 'private-environment-value' },
			},
			arguments_by_stage: {
				primary: ['private provider argument'],
			},
		},
		unrecognised: 'must not persist',
	})
	const serialized = fs.readFileSync(saved.path, 'utf8')
	for (const forbidden of [
		'private task prompt',
		'private brief prompt',
		'private-token',
		'--secret',
		'private-command',
		'private-environment-value',
		'private provider argument',
		'must not persist',
	]) assert.equal(serialized.includes(forbidden), false)
	const loaded = state.load(workspace, 'task-1')
	assert.deepEqual(loaded.state.task.work_boundary, ['src/a.js'])
	assert.deepEqual(loaded.state.briefs, { primary: { goal: 'safe stage goal' } })
	assert.deepEqual(loaded.state.launched_candidates, ['fixture-profile'])
	assert.equal(Object.hasOwn(loaded.state, 'external_execution'), false)
})

test('routing state removes nested credential keys regardless of key naming style', () => {
	const projected = state.persistable_state({
		task: {
			task_id: 'task-credential-redaction',
			access_token: 'private-access-token',
			client_secret: 'private-client-secret',
			environmentVariables: { fixture_value: 'private-environment-value' },
			auth: { refreshToken: 'private-refresh-token', safe_label: 'keep this' },
		},
		records: {
			primary: {
				outputs: {
					provider: { clientSecret: 'private-nested-secret', apiKey: 'private-api-key', privateKeyPem: 'private-key-material' },
					result: 'accepted result',
				},
			},
		},
	})
	const serialized = JSON.stringify(projected)
	for (const secret of ['private-access-token', 'private-client-secret', 'private-refresh-token', 'private-environment-value', 'private-nested-secret', 'private-api-key', 'private-key-material']) {
		assert.equal(serialized.includes(secret), false)
	}
	assert.equal(projected.task.auth.safe_label, 'keep this')
	assert.equal(projected.records.primary.outputs.result, 'accepted result')
})
