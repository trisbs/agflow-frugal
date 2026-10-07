'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const live = require('./routing-live-provider.js')
const settings = require('./ag-settings.js')

const facts_fixture = t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agflow-live-provider-'))
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
	const config = settings.make_template('codex')
	fs.writeFileSync(path.join(directory, 'ag.json'), `${JSON.stringify(config)}\n`)
	const profile = config['external-workers'][0]
	const [model, effort] = profile.tiers.cheap.split('/')
	return {
		directory,
		facts_path: path.join(directory, 'facts.json'),
		profile,
		profile_id: profile.id,
		recipe: { schema_version: 1, family: profile.family, tier: 'cheap', model, effort, checked: true, validation: 'live-provider' },
	}
}

test('live-provider routing is unavailable without explicit authorization and never runs by default', async () => {
	const result = await live.main([])
	assert.equal(result.status, 'unavailable')
	assert.match(result.requirement, /explicit --run/)
})


test('live-provider routing refuses empty and non-live checked recipe sets', async t => {
	const { directory, facts_path, profile_id } = facts_fixture(t)
	for (const provider_recipes of [{}, { [profile_id]: { checked: true, validation: 'fixture' } }]) {
		fs.writeFileSync(facts_path, JSON.stringify({ provider_recipes }))
		const result = await live.main(['--run', '--facts', facts_path], { cwd: directory, active_host: 'codex', run_cli: () => { throw new Error('must not launch') } })
		assert.equal(result.status, 'unavailable')
		assert.match(result.requirement, /checked recipe validated as live-provider|refuses fixture/)
	}
})

test('live-provider routing rejects recipes that are not keyed to configured profiles', async t => {
	const { directory, facts_path } = facts_fixture(t)
	fs.writeFileSync(facts_path, JSON.stringify({ provider_recipes: { 'not-configured': { checked: true, validation: 'live-provider' } } }))
	const result = await live.main(['--run', '--facts', facts_path], { cwd: directory, active_host: 'codex', run_cli: () => { throw new Error('must not launch') } })
	assert.equal(result.status, 'unavailable')
	assert.match(result.requirement, /unconfigured worker profile/)
})

test('live-provider warning is emitted before the authorized runner call after cheap-tier planning', async t => {
	const { directory, facts_path, profile_id, recipe, profile } = facts_fixture(t)
	const facts = {
		provider_recipes: { [profile_id]: recipe },
		external_execution: { source_directory: directory },
		task: { requested_tier: 'cheap' },
	}
	fs.writeFileSync(facts_path, JSON.stringify(facts))
	const events = []
	const result = await live.main(['--run', '--facts', facts_path], {
		cwd: directory,
		active_host: 'codex',
		stderr: message => events.push(['stderr', message]),
		plan_cli: async request => {
			events.push(['plan', request])
			return { status: 'selected', tier: 'cheap', selection: { kind: 'external', candidate_id: profile_id, actual: { model: profile.tiers.cheap.split('/')[0], effort: profile.tiers.cheap.split('/')[1] } } }
		},
		run_cli: async request => { events.push(['run', request]); return { status: 'complete' } },
	})
	assert.equal(result.status, 'complete')
	assert.equal(events[0][0], 'plan')
	assert.equal(events[1][0], 'stderr')
	assert.match(events[1][1], /may consume authenticated usage or incur cost/)
	assert.match(events[1][1], /cheap tier/)
	assert.equal(events[2][0], 'run')
})

test('live-provider routing refuses a non-cheap selected tier before warning or launch', async t => {
	const { directory, facts_path, profile_id, recipe } = facts_fixture(t)
	fs.writeFileSync(facts_path, JSON.stringify({ provider_recipes: { [profile_id]: recipe }, external_execution: { source_directory: directory } }))
	const events = []
	const result = await live.main(['--run', '--facts', facts_path], {
		cwd: directory,
		active_host: 'codex',
		stderr: message => events.push(['stderr', message]),
		plan_cli: async () => ({ status: 'selected', tier: 'basic', selection: { kind: 'external', candidate_id: profile_id, actual: { model: 'configured-basic', effort: 'low' } } }),
		run_cli: () => { events.push(['run']); throw new Error('must not launch') },
	})
	assert.equal(result.status, 'unavailable')
	assert.match(result.requirement, /cheap tier/)
	assert.deepEqual(events, [])
})
