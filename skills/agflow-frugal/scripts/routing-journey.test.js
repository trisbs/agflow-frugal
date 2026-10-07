'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const execution = require('./routing-execution.js')
const lifecycle = require('./routing-lifecycle.js')
const contract = require('./routing-contract.js')
const state = require('./routing-state.js')
const resume = require('./routing-resume.js')
const runner = require('./routing-runner.js')
const settings = require('./ag-settings.js')

const journey = async (t, options = {}) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-journey-'))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const source = path.join(root, 'source')
	fs.mkdirSync(source)
	const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
	git(['init', '-q'])
	fs.writeFileSync(path.join(source, 'a.txt'), 'original\n')
	const disk_config = settings.make_template('codex')
	disk_config.switches['allowed-worker'] = ['external']
	disk_config.switches['review-policy'] = 'prefer-independent'
	disk_config.switches['cli-provider'] = 'on'
	disk_config.switches['workspace-dir'] = '.routing-workspace'
	disk_config['external-workers'] = disk_config['external-workers'].map((profile, index) => ({
		...profile,
		id: index === 0 ? 'fixture' : 'fixture-unavailable',
		command: index === 0 ? ['node'] : ['agentflow-missing-fixture-worker'],
	}))
	const switches = disk_config.switches
	const config_path = path.join(source, 'ag.json')
	fs.writeFileSync(config_path, `${JSON.stringify(disk_config)}\n`)
	git(['add', '.'])
	git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
	const source_identity = { source_kind: 'git', value: git(['rev-parse', 'HEAD']) }
	const config = {
		...disk_config,
		...(options.inject_secrets ? {
			token: 'journey-private-token',
			command: ['journey-private-command'],
			environment: { API_TOKEN: 'journey-private-environment' },
		} : {}),
	}
	const facts = {
		source_identity,
		config,
		source_root: source,
		config_path,
		policy: switches,
		host: { id: 'codex', family: 'codex' },
		admission_facts: options.cheap
			? { simple: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true }
			: { material_uncertainty: true },
		task: {
			task_id: 'journey', brief: { goal: 'Update the fixture' }, work_boundary: ['a.txt'], interactive_host: false,
			...(options.inject_secrets ? { prompt: 'journey-private-prompt' } : {}),
		},
		briefs: {
			assessment: { goal: 'Assess the fixture without source writes' },
			review: { goal: 'Review the accepted fixture result' },
			'debate-a': { goal: 'Evaluate fixture perspective A' },
			'debate-b': { goal: 'Evaluate fixture perspective B' },
			synthesis: { goal: 'Synthesize accepted fixture perspectives' },
		},
		capabilities: { external: options.unavailable_fallback ? [
			{
				id: 'fixture-unavailable', candidate_id: 'fixture-unavailable', family: 'codex', available: true, recipe_checked: true,
				priority: 4, command: ['agentflow-missing-fixture-worker'], controls: { read_only: true },
				tiers: { cheap: 'fixture/low', basic: 'fixture/low', better: 'fixture/low' },
			},
			{
				id: 'fixture', candidate_id: 'fixture', family: 'codex', available: true, recipe_checked: true,
				priority: 3, command: [process.execPath], controls: { read_only: true },
				tiers: { cheap: 'fixture/low', basic: 'fixture/low', better: 'fixture/low' },
			},
		] : [{
			id: 'fixture', candidate_id: 'fixture', family: 'codex', available: true, recipe_checked: true,
			command: [process.execPath], controls: { read_only: true },
			tiers: { cheap: 'fixture/low', basic: 'fixture/low', better: 'fixture/low' },
		}] },
		records: {},
		...(options.initial_usage ? { usage: options.initial_usage } : {}),
	}
	const launches = []
	const cancellation = options.cancelled ? new AbortController() : null
	let cancellation_queued = false
	const external = async context => {
		launches.push({ stage: context.stage, tier: context.tier, ...(options.unavailable_fallback ? { candidate_id: context.selection.candidate_id } : {}) })
		const risk_mode = options.full_l5 ? 'full_l5' : options.risk_mode
		const high_risk = ['l4_no_review', 'l4_review', 'l5_agreement', 'full_l5'].includes(risk_mode)
		const l5_case = risk_mode === 'l5_agreement' || risk_mode === 'full_l5'
		const assessment = Object.fromEntries(contract.definitions.assessment.boolean.map(key => [key,
			high_risk
				? key === 'material_uncertainty' || key === 'high_consequence' || key === 'material_risk' ||
					l5_case && key === 'material_disagreement' || risk_mode === 'l4_no_review' && key === 'deterministic_verification_sufficient'
				: key === 'material_uncertainty' || key === 'deterministic_verification_sufficient' ||
					key === 'substantial_mechanical_execution' && options.substantial === true,
		]))
		Object.assign(assessment, { risk_flags: [], missing_information: [] })
		const review_facts = {
			material_risk: true,
			deterministic_verification_sufficient: false,
			reviewer_material_disagreement: risk_mode === 'full_l5',
			viable_alternatives: risk_mode === 'full_l5',
			meaningful_tradeoffs: risk_mode === 'full_l5',
			substantial_consequence: risk_mode === 'full_l5',
			cheap_resolution_exhausted: risk_mode === 'full_l5',
			D: risk_mode === 'full_l5' ? 2 : 0,
			T: risk_mode === 'full_l5' ? 2 : 0,
			I: risk_mode === 'full_l5' ? 2 : 0,
			E: risk_mode === 'full_l5' ? 1 : 0,
			R: risk_mode === 'full_l5' ? 1 : 0,
		}
		const output = context.stage === 'assessment' ? {
			schema_version: 1, task_id: context.task.task_id, source_identity, facts: assessment,
			evidence: Object.entries(assessment).filter(([, value]) => value === true).map(([fact]) =>
				({ fact, source: 'fixture', observation: 'Named deterministic fixture condition' })),
		} : context.stage === 'review' && high_risk ? {
			schema_version: 1, task_id: context.task.task_id, source_identity, facts: review_facts,
			evidence: Object.entries(review_facts).filter(([, value]) => value === true || typeof value === 'number' && value > 0).map(([fact]) =>
				({ fact, source: 'fixture', observation: 'Named deterministic reviewer finding' })),
		} : { result: 'implemented' }
		const write = context.stage === 'primary' || options.assessment_write === true
		const write_path = options.boundary_escape ? 'b.txt' : 'a.txt'
		const expected = write && !options.boundary_escape ? 'implemented\n' : 'original\n'
		const command = [process.execPath, '-e',
			'const fs=require("node:fs");if(fs.readFileSync("a.txt","utf8")!==' + JSON.stringify(expected) + ')process.exit(1)',
		]
		const program = [
			'const fs=require("node:fs")',
			...(write ? [`fs.writeFileSync(${JSON.stringify(write_path)},"implemented\\n")`] : []),
			'process.stdout.write(' + JSON.stringify(JSON.stringify(options.malformed ? {} : output)) + ')',
			...(options.uncertain || options.cancelled ? ['setTimeout(()=>{},5000)'] : []),
		].join(';')
		return execution.external_adapter({
			source_directory: source,
			runner_options: {
				clone_directory: path.join(root, 'clone-' + launches.length),
				...(options.uncertain ? { timeout_ms: 500, termination_grace_ms: 25 } : {}),
				...(cancellation ? {
					signal: cancellation.signal,
					list_processes: () => {
						if (!cancellation_queued) {
							cancellation_queued = true
							setImmediate(() => cancellation.abort())
						}
						return []
					},
				} : {}),
			},
			allow_fixture_recipe: true,
			read_only_recipe_for_stage: () => ({
				schema_version: 1, provider: 'fixture-node', source_access: 'read-only',
				arguments: ['--input-type=commonjs'], validation: 'fixture',
			}),
			arguments_for_stage: () => ['-e', program],
			verification_for_stage: () => [command],
			verify_stage: async ({ runner, root: clone_root, commands }) => {
				if (runner.status !== 'completed') return { coordinator_inspected: true, results: [] }
				assert.equal(runner.clone.independent, true)
				assert.deepEqual(runner.clone.remotes, [])
				assert.notEqual(clone_root, source)
				return { coordinator_inspected: true, results: commands.map(command => {
					execFileSync(command[0], command.slice(1), { cwd: clone_root })
					return { command, passed: true }
				}) }
			},
		})(context)
	}
	const workspace = path.join(source, disk_config.switches['workspace-dir'])
	const result = options.interrupt_after_assessment
		? await runner.run({ ...facts, workspace_dir: workspace }, { max_actions: 1, adapters: { external } })
		: await lifecycle.run_lifecycle(facts, { external })
	const identity = resume.create_snapshot({ ...result.facts, source_identity, config })
	if (!options.interrupt_after_assessment) {
		state.save(workspace, 'journey', {
			...result.facts,
			source_root: source,
			config_path,
			...(identity.valid ? { resume_identity: identity.snapshot } : {}),
		})
	}
	if (options.stale_write) {
		assert.throws(() => state.save(workspace, 'journey', result.facts, { expected_revision: 0 }), /stale/)
	}
	const payload = state.load(workspace, 'journey')
	const saved = payload.state
	const serialized_state = fs.readFileSync(payload.path, 'utf8')
	assert.deepEqual(saved.records, result.facts.records)
	assert.deepEqual(saved.attempts || [], result.facts.attempts || [])
	assert.deepEqual(saved.usage, result.facts.usage)
	if (!options.unavailable_fallback) assert.equal((saved.attempts || []).length, launches.length)
	assert.equal(fs.readFileSync(path.join(source, 'a.txt'), 'utf8'), 'original\n')
	assert.equal(git(['rev-parse', 'HEAD']), source_identity.value)
	return { result, launches, external, saved, saved_revision: payload.revision, serialized_state, source, workspace, config_path }
}

for (const [name, options, execution_class, stages] of [
	['L1 Cheap Direct', { cheap: true }, 'L1', ['primary']],
	['L2 Basic assessment and primary', {}, 'L2', ['assessment', 'primary']],
	['L3 Basic assessment and bounded execution', { substantial: true }, 'L3', ['assessment', 'primary']],
]) {
	test(name, async t => {
		const { result, launches, saved } = await journey(t, options)
		assert.equal(result.status, 'complete')
		assert.equal(result.routing.execution_class, execution_class)
		assert.deepEqual(launches.map(item => item.stage), stages)
		assert.deepEqual(launches.map(item => item.tier), stages.map(() => options.cheap ? 'cheap' : 'basic'))
		assert.deepEqual(Object.keys(saved.records), stages)
		assert.deepEqual(saved.records.primary.changed_paths, ['a.txt'])
		assert.equal(saved.usage.external_workers, 1)
		assert.equal(saved.usage.discovery_iterations, options.cheap ? 0 : 1)
		for (const record of saved.attempts) {
			assert.equal(record.acceptance.accepted, true)
			assert.equal(record.transport.runner_id, 'external-runner-v1')
			assert.ok(Number.isInteger(record.transport.process.pid))
		}
	})
}

for (const [name, options, reason] of [
	['malformed assessment cannot advance', { malformed: true }, /schema_version/],
	['source write during assessment cannot advance', { assessment_write: true }, /assessment changed source paths/],
]) {
	test(name, async t => {
		const { result, launches, saved } = await journey(t, options)
		assert.equal(result.status, 'task-failed')
		assert.deepEqual(launches, [{ stage: 'assessment', tier: 'basic' }])
		assert.deepEqual(saved.records, {})
		assert.equal(saved.attempts[0].acceptance.accepted, false)
		assert.match(saved.attempts[0].reason, reason)
		assert.equal(saved.usage.discovery_iterations, 0)
	})
}

test('primary write outside frozen work boundary cannot advance', async t => {
	const { result, launches, saved } = await journey(t, { boundary_escape: true })
	assert.equal(result.status, 'task-failed')
	assert.deepEqual(launches, [
		{ stage: 'assessment', tier: 'basic' },
		{ stage: 'primary', tier: 'basic' },
	])
	assert.deepEqual(Object.keys(saved.records), ['assessment'])
	const failed_attempt = saved.attempts.at(-1)
	assert.deepEqual(failed_attempt.changed_paths, ['b.txt'])
	assert.equal(failed_attempt.acceptance.accepted, false)
	assert.match(failed_attempt.reason, /outside the frozen work boundary/)
})

test('full L5 journey uses review-call headroom through Basic synthesis', async t => {
	const { result, launches, saved } = await journey(t, { full_l5: true })
		assert.equal(result.status, 'complete')
	assert.deepEqual(launches.map(item => item.stage), ['assessment', 'primary', 'review', 'debate-a', 'debate-b', 'synthesis'])
	assert.deepEqual(launches.map(item => item.tier), ['basic', 'basic', 'better', 'better', 'better', 'basic'])
	assert.deepEqual(Object.keys(saved.records), ['assessment', 'primary', 'review', 'debate-a', 'debate-b', 'synthesis'])
	assert.equal(saved.usage.external_workers, 1)
	assert.equal(saved.usage.independent_reviewers, 1)
	assert.equal(saved.usage.debate_perspectives, 2)
	assert.equal(saved.usage.debate_syntheses, 1)
	assert.equal(saved.usage.expensive_calls, 3)
})

for (const [name, risk_mode, stages] of [
	['L4 completes without review when deterministic verification is sufficient', 'l4_no_review', ['assessment', 'primary']],
	['L4 completes after its required Better review', 'l4_review', ['assessment', 'primary', 'review']],
	['L5 completes after review finds no remaining disagreement', 'l5_agreement', ['assessment', 'primary', 'review']],
]) {
	test(name, async t => {
		const { result, launches, saved } = await journey(t, { risk_mode })
		assert.equal(result.status, 'complete')
		assert.deepEqual(launches.map(item => item.stage), stages)
		assert.deepEqual(Object.keys(saved.records), stages)
		assert.equal(saved.usage.independent_reviewers || 0, stages.includes('review') ? 1 : 0)
	})
}

test('settled unavailable worker falls back to the second configured profile', async t => {
	const { result, launches, saved } = await journey(t, { cheap: true, unavailable_fallback: true })
	assert.equal(result.status, 'complete', JSON.stringify(result))
	assert.deepEqual(launches.map(item => item.candidate_id), ['fixture-unavailable', 'fixture'])
	assert.equal(saved.attempts.length, 2)
	assert.equal(saved.attempts[0].state, 'unavailable')
	assert.equal(saved.records.primary.candidate_id, 'fixture')
	assert.equal(saved.usage.external_workers, 2)
})

test('uncertain timed-out process is saved and never relaunched automatically', async t => {
	const { result, launches, saved } = await journey(t, { cheap: true, uncertain: true })
	assert.equal(result.status, 'uncertain')
	assert.equal(launches.length, 1)
	assert.equal(saved.attempts.length, 1)
	assert.equal(saved.attempts[0].state, 'uncertain')
	assert.deepEqual(saved.records, {})
})

test('owner-cancelled child process is saved and never relaunched automatically', async t => {
	const { result, launches, saved } = await journey(t, { cheap: true, cancelled: true })
	assert.equal(result.status, 'cancelled')
	assert.equal(launches.length, 1)
	assert.equal(saved.attempts.length, 1)
	assert.equal(saved.attempts[0].state, 'cancelled')
	assert.equal(saved.attempts[0].transport.stop_verified, true)
	assert.ok(saved.attempts[0].limitations.some(value => /remote-provider cancellation/.test(value)))
	assert.deepEqual(saved.records, {})
})

test('exhausted worker budget stops before launching a process', async t => {
	const { result, launches, saved } = await journey(t, { initial_usage: { external_workers: 2 } })
	assert.equal(result.status, 'stopped')
	assert.match(result.requirement, /external_workers budget would exceed/)
	assert.deepEqual(launches, [])
	assert.deepEqual(saved.attempts || [], [])
	assert.deepEqual(saved.records, {})
	assert.equal(saved.usage.external_workers, 2)
})

test('persisted journey state excludes injected secret-bearing values', async t => {
	const { serialized_state } = await journey(t, { inject_secrets: true })
	for (const forbidden of [
		'journey-private-prompt',
		'journey-private-token',
		'journey-private-command',
		'journey-private-environment',
	]) assert.equal(serialized_state.includes(forbidden), false)
})

test('stale concurrent journey write preserves the accepted state', async t => {
	const { saved, saved_revision } = await journey(t, { stale_write: true })
	assert.equal(saved_revision, 1)
	assert.deepEqual(Object.keys(saved.records), ['assessment', 'primary'])
	assert.equal(saved.attempts.length, 2)
})

test('resume rejects a changed source identity before another launch', async t => {
	const { launches, source, workspace, config_path } = await journey(t)
	fs.writeFileSync(path.join(source, 'later.txt'), 'changed after the saved journey\n')
	execFileSync('git', ['-C', source, 'add', 'later.txt'])
	execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'advance source'])
	const revision = state.load(workspace, 'journey').revision
	const result = await runner.resume_with_config('journey', workspace, config_path)
	assert.equal(result.status, 'invalid')
	assert.match(result.requirement, /source identity changed/)
	assert.equal(launches.length, 2)
	assert.equal(state.load(workspace, 'journey').revision, revision)
})

test('resume rejects a changed accepted brief digest before another launch', async t => {
	const { launches, workspace, config_path } = await journey(t)
	const loaded = state.load(workspace, 'journey')
	const altered = {
		...loaded.state,
		records: {
			...loaded.state.records,
			primary: { ...loaded.state.records.primary, brief_digest: 'f'.repeat(64) },
		},
	}
	state.save(workspace, 'journey', altered, { expected_revision: loaded.revision })
	const revision = state.load(workspace, 'journey').revision
	const result = await runner.resume_with_config('journey', workspace, config_path)
	assert.equal(result.status, 'invalid')
	assert.match(result.requirement, /brief or requested-control identity changed/)
	assert.equal(launches.length, 2)
	assert.equal(state.load(workspace, 'journey').revision, revision)
})

test('runner resumes after an accepted assessment without repeating it or charging it again', async t => {
	const { result, launches, external, source, workspace } = await journey(t, { interrupt_after_assessment: true })
	assert.equal(result.status, 'action-limit')
	assert.deepEqual(launches.map(item => item.stage), ['assessment'])
	const before = state.load(workspace, 'journey')
	assert.deepEqual(Object.keys(before.state.records), ['assessment'])
	assert.equal(before.state.usage.external_workers, 1)

	const resumed = await runner.cli({
		command: 'resume',
		cwd: source,
		active_host: 'codex',
		task_id: 'journey',
		adapters: { external },
		provider_recipes: { fixture: { checked: true, validation: 'fixture' } },
		executable_available: () => true,
	})
	assert.equal(resumed.status, 'complete', resumed.requirement)
	assert.deepEqual(resumed.steps.map(item => item.stage), ['primary'])
	assert.deepEqual(launches.map(item => item.stage), ['assessment', 'primary'])
	const after = state.load(workspace, 'journey')
	assert.deepEqual(Object.keys(after.state.records), ['assessment', 'primary'])
	assert.equal(after.state.attempts.length, 2)
	assert.equal(after.state.usage.external_workers, 1)
	assert.equal(after.state.usage.discovery_iterations, 1)
})
