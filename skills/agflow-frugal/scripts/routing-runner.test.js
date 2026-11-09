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

test('routing runner refuses lifecycle completion that the coordinator cannot reproduce', () => {
	const result = runner.verify_lifecycle_result({ status: 'complete', facts: { task: { task_id: 'forged-completion' } } })
	assert.equal(result.status, 'unsatisfied')
	assert.match(result.requirement, /completion failed coordinator recheck/)
	assert.equal(runner.exit_code_for(result.status), 5)
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

test('routing inspect preserves normalized failure diagnostics without raw process output', async () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-runner-failure-inspect-'))
	const failure = {
		version: 1,
		outcome: 'nonzero_exit',
		clue: 'read_only_filesystem',
		clue_source: 'stderr_indicator',
		stderr_bytes: 71,
		stderr_truncated: false,
		recovery_hint: 'Use an executor runtime with writable state, then authorize a new attempt.',
	}
	state.save(workspace, 'task-failure-inspect', {
		task: { task_id: 'task-failure-inspect' },
		records: { assessment: { state: 'task-failed', acceptance: { accepted: false }, transport: { failure } } },
	})
	const result = await runner.main(['inspect', 'task-failure-inspect', workspace])
	assert.equal(result.status, 'loaded')
	assert.deepEqual(result.facts.records.assessment.transport.failure, failure)
	assert.equal(JSON.stringify(result).includes('private stderr'), false)
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
			provider_recipes: { [profile.id]: { schema_version: 1, family: profile.family, tier: 'cheap', model: profile.tiers.cheap.split('/')[0], effort: profile.tiers.cheap.split('/')[1], checked: true, validation: 'live-provider' } },
			admission_facts: { task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'fixture Ask', observation: 'Execute the bounded task without planning' }] }, complexity_reasons: {}, mechanical: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true },
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
			observe_transport: () => ({ model: 'unknown', effort: 'unknown' }),
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
	assert.equal(runner.exit_code_for('awaiting-evidence'), 2)
	assert.equal(runner.exit_code_for('awaiting-input'), 2)
	assert.equal(runner.exit_code_for('task-failed'), 4)
	assert.equal(runner.exit_code_for('invalid'), 5)
})

const basic_provider_route = () => {
	const config = require('./ag-settings.js').make_template('codex')
	config.switches['allowed-worker'] = ['external']
	const profile = config['external-workers'][0]
	profile.tiers.basic = 'fixture-basic/medium'
	const source_identity = { source_kind: 'git', value: 'a'.repeat(40) }
	const facts = {
		config, policy: config.switches, source_identity,
		task: { task_id: 'basic-provider-route', brief: { goal: 'bounded Basic stage' }, work_boundary: [] },
		capabilities: { external: [{ ...profile, candidate_id: profile.id, available: true, recipe_checked: true }] },
		provider_recipes: { [profile.id]: { schema_version: 1, family: 'codex', tier: 'basic', model: 'fixture-basic', effort: 'medium', checked: true, validation: 'live-provider' } },
		records: {},
	}
	const planner = current => require('./routing-coordinator.js').plan_class_action(current, { valid: true, execution_class: 'L2', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false })
	return { facts, planner, profile }
}

test('Basic production builder reaches the route adapter with independently observed fixture evidence', async () => {
	const { facts, planner } = basic_provider_route()
	let command
	facts.external_execution = {
		source_directory: process.cwd(),
		observe_transport: ({ runner }) => runner.transport_observation,
		run_external_command: async options => {
			command = options.command
			return { status: 'completed', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), result: { value: null }, process: { pid: 123, exit_code: 0 }, clone: { head: facts.source_identity.value }, limitations: [], transport_observation: { model: 'fixture-basic', effort: 'medium' } }
		},
	}
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
	assert.equal(result.status, 'complete', result.requirement)
	assert.ok(command.includes('fixture-basic'))
	assert.ok(command.includes('model_reasoning_effort=medium'))
	assert.equal(result.facts.records.primary.transport.worker_started, true)
})

test('observer-absent Basic dispatch starts and accepts the configured identity', async () => {
	const { facts, planner } = basic_provider_route()
	let starts = 0
	facts.external_execution = { source_directory: process.cwd(), run_external_command: async () => {
		starts += 1
		return { status: 'completed', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), result: { value: null }, process: { pid: 123, exit_code: 0 }, clone: { head: facts.source_identity.value }, limitations: [] }
	} }
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
	assert.equal(result.status, 'complete', result.requirement)
	assert.equal(starts, 1)
	const record = result.facts.records.primary
	assert.equal(record.transport.worker_started, true)
	assert.equal(record.actual.model, 'unknown')
	assert.equal(record.dispatched.model, 'fixture-basic')
	assert.equal(record.dispatched.effort, 'medium')
	assert.equal(record.dispatched.tier, 'basic')
	assert.equal(record.dispatched.stage, 'primary')
	assert.match(record.dispatched.invocation_digest, /^[a-f0-9]{64}$/)
})

test('L3 production route dispatches a separate accepted review with the exact Basic tier', async () => {
	const { facts, profile } = basic_provider_route()
	facts.briefs = { review: { goal: 'Review the accepted L3 Basic result' } }
	const commands = []
	const contract = require('./routing-contract.js')
	const review = {
		schema_version: 1,
		task_id: `${facts.task.task_id}:review`,
		source_identity: facts.source_identity,
		facts: Object.fromEntries([...contract.definitions.review.boolean.map(key => [key, false]), ...contract.definitions.review.scores.map(key => [key, 0])]),
		evidence: [],
	}
	facts.external_execution = {
		source_directory: process.cwd(),
		observe_transport: ({ runner }) => runner.transport_observation,
		run_external_command: async options => {
			commands.push(options.command)
			return { status: 'completed', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: commands.length === 1 ? 'implemented' : JSON.stringify(review) } }), result: { value: null }, process: { pid: 123 + commands.length, exit_code: 0 }, clone: { head: facts.source_identity.value }, limitations: [], transport_observation: { model: 'fixture-basic', effort: 'medium' } }
		},
	}
	const planner = current => require('./routing-coordinator.js').plan_class_action(current, { valid: true, execution_class: 'L3', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false })
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
	assert.equal(result.status, 'complete', result.requirement)
	assert.deepEqual(result.steps.map(step => [step.stage, step.tier, step.candidate_id]), [['primary', 'basic', profile.id], ['review', 'basic', profile.id]])
	assert.ok(commands.every(command => command.includes('fixture-basic')))
	assert.equal(result.facts.records.review.acceptance.accepted, true)
})

test('wrong-tier provider recipe is a pre-dispatch failure rather than uncertain work', async () => {
	const { facts, planner, profile } = basic_provider_route()
	const [model, effort] = profile.tiers.cheap.split('/')
	facts.provider_recipes[profile.id] = { ...facts.provider_recipes[profile.id], tier: 'cheap', model, effort }
	facts.external_execution = { source_directory: process.cwd(), run_external_command: async () => { throw new Error('must not start') } }
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
	assert.equal(result.status, 'unavailable')
	assert.match(result.requirement, /dispatch did not start.*required tier/)
	assert.deepEqual(result.facts.records, {})
})

test('one profile uses checked Basic and Better recipes through the L4 production route', async () => {
	const { facts, profile } = basic_provider_route()
	profile.tiers.better = 'fixture-better/high'
	facts.briefs = { review: { goal: 'Review the accepted Basic result' } }
	facts.provider_recipes[profile.id] = { tiers: {
		basic: facts.provider_recipes[profile.id],
		better: { schema_version: 1, family: 'codex', tier: 'better', model: 'fixture-better', effort: 'high', checked: true, validation: 'live-provider' },
	} }
	const { provider_recipes, ...frozen_facts } = facts
	const prepared = runner.configured_facts(frozen_facts, { cwd: process.cwd(), config: facts.config, provider_recipes, executable_available: () => true })
	assert.deepEqual(prepared.provider_recipes, provider_recipes)
	const commands = []
	const contract = require('./routing-contract.js')
	const review = { schema_version: 1, task_id: `${facts.task.task_id}:review`, source_identity: facts.source_identity, facts: Object.fromEntries([...contract.definitions.review.boolean.map(key => [key, false]), ...contract.definitions.review.scores.map(key => [key, 0])]), evidence: [] }
	prepared.external_execution = {
		source_directory: process.cwd(), observe_transport: ({ runner }) => runner.transport_observation,
		run_external_command: async options => {
			const index = commands.length
			commands.push(options.command)
			return { status: 'completed', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: index === 0 ? 'implemented' : JSON.stringify(review) } }), result: { value: null }, process: { pid: 123 + index, exit_code: 0 }, clone: { head: facts.source_identity.value }, limitations: [], transport_observation: [{ model: 'fixture-basic', effort: 'medium' }, { model: 'fixture-better', effort: 'high' }][index] }
		},
	}
	const planner = current => require('./routing-coordinator.js').plan_class_action(current, { valid: true, execution_class: 'L4', primary_tier: 'basic', pressure: 'NORMAL', review: true, debate: false })
	const result = await require('./routing-lifecycle.js').run_lifecycle(prepared, runner.adapters_for(prepared), { planner })
	assert.equal(result.status, 'complete', result.requirement)
	assert.deepEqual(result.steps.map(step => [step.stage, step.tier, step.candidate_id]), [['primary', 'basic', profile.id], ['review', 'better', profile.id]])
	assert.ok(commands[0].includes('fixture-basic'))
	assert.ok(commands[1].includes('fixture-better'))
	assert.equal(result.facts.usage.external_workers, 1)
})

test('production selection excludes a tier without its checked recipe', async () => {
	const { facts, profile } = basic_provider_route()
	facts.briefs = { review: { goal: 'Review the accepted Basic result' } }
	facts.provider_recipes[profile.id] = { tiers: { basic: facts.provider_recipes[profile.id] } }
	const prepared = runner.configured_facts(facts, { cwd: process.cwd(), config: facts.config, provider_recipes: facts.provider_recipes, executable_available: () => true })
	assert.deepEqual(Object.keys(prepared.capabilities.external[0].tiers), ['basic'])
	let starts = 0
	const planner = current => require('./routing-coordinator.js').plan_class_action(current, { valid: true, execution_class: 'L4', primary_tier: 'basic', pressure: 'NORMAL', review: true, debate: false })
	prepared.external_execution = {
		source_directory: process.cwd(), observe_transport: ({ runner }) => runner.transport_observation,
		run_external_command: async () => {
			starts += 1
			return { status: 'completed', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'implemented' } }), result: { value: null }, process: { pid: 123, exit_code: 0 }, clone: { head: facts.source_identity.value }, limitations: [], transport_observation: { model: 'fixture-basic', effort: 'medium' } }
		},
	}
	const result = await require('./routing-lifecycle.js').run_lifecycle(prepared, runner.adapters_for(prepared), { planner })
	assert.equal(result.status, 'unsatisfied')
	assert.equal(result.stage, 'review')
	assert.ok(result.selection.skipped.some(item => /requested tier better.*unavailable/.test(item.reason)))
	assert.equal(starts, 1)
	assert.equal(result.facts.usage.external_workers, 1)
	assert.equal(result.facts.usage.expensive_calls, 0)
	assert.equal(result.facts.usage.independent_reviewers, 0)
})

test('wrong-tier recipe sets fail before production selection or adapter dispatch', async () => {
	const { facts, profile, planner } = basic_provider_route()
	const recipe = facts.provider_recipes[profile.id]
	facts.provider_recipes[profile.id] = { tiers: { better: recipe } }
	assert.throws(() => runner.configured_facts(facts, { cwd: process.cwd(), config: facts.config, provider_recipes: facts.provider_recipes, executable_available: () => true }), /key must match its declared tier/)
	let starts = 0
	facts.external_execution = { source_directory: process.cwd(), run_external_command: async () => { starts += 1 } }
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
	assert.equal(result.status, 'unavailable')
	assert.match(result.requirement, /dispatch did not start.*key must match/)
	assert.equal(starts, 0)
	assert.equal(result.facts.usage, undefined)
})

test('formal JSON CLI dispatches direct L2/L3 and assessed L4/gated L5 with exact tier identity and real PIDs', async () => {
	const cp = require('node:child_process')
	const cases = {
		L2: { stages: ['primary'], tiers: ['basic'] },
		L3: { stages: ['primary', 'review'], tiers: ['basic', 'basic'] },
		L4: { stages: ['assessment', 'primary'], tiers: ['basic', 'basic'] },
		L5: { stages: ['assessment', 'primary', 'review', 'debate-a', 'debate-b', 'synthesis'], tiers: ['basic', 'basic', 'better', 'best', 'best', 'better'] },
	}
	for (const [execution_class, expected] of Object.entries(cases)) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-formal-dispatch-'))
		const source = path.join(root, 'source')
		fs.mkdirSync(source)
		cp.execFileSync('git', ['init', '-q', source])
		fs.writeFileSync(path.join(source, 'a.txt'), 'fixture\n')
		cp.execFileSync('git', ['-C', source, 'add', 'a.txt'])
		cp.execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
		const source_identity = { source_kind: 'git', value: cp.execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
		const capture = path.join(root, 'capture.jsonl')
		const fake = path.join(root, 'codex')
		const assessment_module = path.join(__dirname, 'fixtures/routing-assessment.js')
		const contract = require('./routing-contract.js')
		const assessment_facts = {
			material_uncertainty: true,
			substantial_mechanical_execution: true,
			high_consequence: ['L4', 'L5'].includes(execution_class),
			material_disagreement: execution_class === 'L5',
			material_risk: ['L4', 'L5'].includes(execution_class),
			deterministic_verification_sufficient: execution_class === 'L4',
		}
		const review_facts = Object.fromEntries([
			...contract.definitions.review.boolean.map(key => [key, false]),
			...contract.definitions.review.scores.map(key => [key, 0]),
		])
		if (execution_class === 'L5') Object.assign(review_facts, {
			material_risk: true,
			deterministic_verification_sufficient: false,
			reviewer_material_disagreement: true,
			viable_alternatives: true,
			meaningful_tradeoffs: true,
			substantial_consequence: true,
			cheap_resolution_exhausted: true,
			D: 2, T: 2, I: 2, E: 1, R: 1,
		})
		const fake_source = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const payload = JSON.parse(args.at(-1).split('\\n\\n').at(-1))
const brief = payload.brief
const stage = brief.task_id.split(':').at(-1)
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ stage, args: args.slice(0, -1), pid: process.pid }) + '\\n')
if (stage === 'primary' && process.env.AGENTFLOW_TEST_SPAWN_GATE) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(process.env.AGENTFLOW_TEST_SPAWN_GATE)) Atomics.wait(wait, 0, 0, 10)
}
const assessment_facts = ${JSON.stringify(assessment_facts)}
const review_facts = ${JSON.stringify(review_facts)}
let text = 'done'
if (stage === 'assessment') text = JSON.stringify(require(${JSON.stringify(assessment_module)}).assessment_envelope(assessment_facts, brief.task_id, brief.source_identity))
if (stage === 'review') text = JSON.stringify({ schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: review_facts, evidence: Object.entries(review_facts).filter(([, value]) => value === true || typeof value === 'number' && value > 0).map(([fact]) => ({ fact, source: 'fixture', observation: 'Fixed CLI scenario' })) })
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
`
		fs.writeFileSync(fake, fake_source, { mode: 0o755 })
		const config = route_config(source)
		const profile = config['external-workers'][0]
		profile.command = ['codex', 'exec']
		profile.tiers.basic = 'fixed-basic/medium'
		profile.tiers.better = 'fixed-better/high'
		profile.tiers.best = 'fixed-best/xhigh'
		fs.writeFileSync(path.join(source, 'ag.json'), JSON.stringify(config))
		const facts = {
			source_root: source, source_identity,
			task: { task_id: `formal-${execution_class.toLowerCase()}`, brief: { goal: 'Execute bounded change' }, work_boundary: [] },
			briefs: { assessment: { goal: 'Assess without source writes' }, review: { goal: 'Review accepted result' }, 'debate-a': { goal: 'First Best perspective' }, 'debate-b': { goal: 'Second Best perspective' }, synthesis: { goal: 'Better synthesis' } },
			admission_facts: { material_uncertainty: true, substantial_mechanical_execution: execution_class === 'L3', mechanical: false, simple: false, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: false, risk_flags: [], missing_information: [], ...(execution_class === 'L4' || execution_class === 'L5' ? { high_consequence: true } : {}), task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'fixture Ask', observation: 'Execute bounded change' }] }, complexity_reasons: {} },
			provider_recipes: { [profile.id]: { tiers: {
				basic: { schema_version: 1, family: 'codex', tier: 'basic', model: 'fixed-basic', effort: 'medium', checked: true, validation: 'live-provider' },
				better: { schema_version: 1, family: 'codex', tier: 'better', model: 'fixed-better', effort: 'high', checked: true, validation: 'live-provider' },
				best: { schema_version: 1, family: 'codex', tier: 'best', model: 'fixed-best', effort: 'xhigh', checked: true, validation: 'live-provider' },
			} } },
			external_execution: { source_directory: source, read_only_stages: ['assessment'], read_only_recipes_by_stage: { assessment: { schema_version: 1, provider: 'codex', source_access: 'read-only', arguments: ['--sandbox', 'read-only'], validation: 'live-provider' } } },
		}
		let child
		if (execution_class === 'L3') {
			const gate = path.join(root, 'release-primary')
			const status = '[agf] Basic primary worker process launched; next: collect and validate its result.'
			let stdout = ''
			let stderr = ''
			let status_before_completion = false
			let released = false
			let watchdog
			const cli_child = cp.spawn(process.execPath, [path.join(__dirname, 'agf.js'), 'route', 'run', '--facts-stdin'], {
				cwd: source,
				env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, AGENTFLOW_TEST_SPAWN_GATE: gate },
			})
			const completed = new Promise((resolve, reject) => {
				cli_child.once('error', error => { clearTimeout(watchdog); reject(error) })
				cli_child.once('close', (code, signal) => {
					clearTimeout(watchdog)
					resolve({ status: code, signal, stdout, stderr, status_before_completion })
				})
				watchdog = setTimeout(() => {
					if (released) return
					released = true
					fs.writeFileSync(gate, 'release')
				}, 5000)
			})
			cli_child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
			cli_child.stderr.setEncoding('utf8').on('data', chunk => {
				stderr += chunk
				if (!released && stderr.includes(status)) {
					status_before_completion = cli_child.exitCode === null && stdout.length === 0
					released = true
					fs.writeFileSync(gate, 'release')
				}
			})
			cli_child.stdin.end(JSON.stringify(facts))
			child = await completed
			assert.equal(child.status_before_completion, true, 'spawn status should arrive while the formal route process is still waiting for the worker')
		} else {
			child = cp.spawnSync(process.execPath, [path.join(__dirname, 'agf.js'), 'route', 'run', '--facts-stdin'], { cwd: source, input: JSON.stringify(facts), encoding: 'utf8', env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` } })
		}
		assert.equal(child.status, 0, child.stdout + child.stderr)
		const status_lines = child.stderr.split(/\r?\n/u).filter(line => line.startsWith('[agf] '))
		assert.deepEqual(status_lines, expected.stages.map((stage, index) => {
			const tier = expected.tiers[index]
			const title = `${tier.slice(0, 1).toUpperCase()}${tier.slice(1)}`
			return `[agf] ${title} ${stage} worker process launched; next: collect and validate its result.`
		}))
		const result = JSON.parse(child.stdout)
		assert.equal(result.status, 'complete', result.requirement)
		assert.equal(result.routing.execution_class, execution_class)
		const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
		assert.deepEqual(Object.keys(result.facts.records), expected.stages)
		assert.deepEqual(calls.map(call => call.stage), expected.stages)
		assert.equal(calls.length, expected.stages.length)
		const replay = cp.spawnSync(process.execPath, [path.join(__dirname, 'agf.js'), 'route', 'run', '--facts-stdin'], { cwd: source, input: JSON.stringify({ ...facts, records: result.facts.records }), encoding: 'utf8', env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` } })
		assert.equal(JSON.parse(replay.stdout).status, 'invalid')
		assert.match(JSON.parse(replay.stdout).requirement, /caller-supplied routing history/)
		assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, expected.stages.length)
		const workspace = path.join(source, '.agentflow')
		const saved = state.load(workspace, facts.task.task_id)
		delete saved.state.records.primary.dispatched
		delete saved.state.records.primary.content_identity
		delete saved.state.records.primary.content_projection
		saved.state.resume_identity = resume.create_snapshot({ ...saved.state, config }).snapshot
		state.save(workspace, facts.task.task_id, saved.state, { expected_revision: saved.revision })
		const resumed = await runner.main(['resume', facts.task.task_id, workspace])
		assert.equal(resumed.status, 'unsatisfied', resumed.requirement)
		assert.match(resumed.requirement, /unverified.*dispatch receipt/)
		for (const [index, stage] of expected.stages.entries()) {
			const tier = expected.tiers[index]
			const model = { basic: 'fixed-basic', better: 'fixed-better', best: 'fixed-best' }[tier]
			const effort = { basic: 'medium', better: 'high', best: 'xhigh' }[tier]
			assert.deepEqual(calls[index].args, ['exec', ...(stage === 'assessment' ? ['--sandbox', 'read-only'] : []), '--json', '--model', model, '--config', `model_reasoning_effort=${effort}`])
			const record = result.facts.records[stage]
			assert.equal(record.transport.worker_started, true)
			assert.equal(record.transport.process.pid, calls[index].pid)
			assert.equal(record.dispatched.provenance, 'configured-provider-invocation-v1')
			assert.equal(record.dispatched.model, model)
			assert.equal(record.dispatched.effort, effort)
			assert.equal(record.actual.model, 'unknown')
		}
	}
})

test('formal L3 route reports each process launch through a real PTY before releasing that worker', { skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/script') }, async () => {
	const cp = require('node:child_process')
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-route-pty-'))
	const source = path.join(root, 'source')
	const gates = { primary: path.join(root, 'release-primary'), review: path.join(root, 'release-review') }
	const launch_statuses = {
		primary: '[agf] Basic primary worker process launched; next: collect and validate its result.',
		review: '[agf] Basic review worker process launched; next: collect and validate its result.',
	}
	const facts_path = path.join(root, 'facts.json')
	const result_path = path.join(root, 'route-result.json')
	const fake = path.join(root, 'codex')
	try {
		fs.mkdirSync(source)
		cp.execFileSync('git', ['init', '-q', source])
		cp.execFileSync('git', ['-C', source, 'config', 'user.name', 'PTY Fixture'])
		cp.execFileSync('git', ['-C', source, 'config', 'user.email', 'pty@example.invalid'])
		fs.writeFileSync(path.join(source, '.gitignore'), '.agentflow/\n')
		fs.writeFileSync(path.join(source, 'a.txt'), 'fixture\n')
		cp.execFileSync('git', ['-C', source, 'add', '.gitignore', 'a.txt'])
		cp.execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture source'])

		const config = route_config(source)
		const profile = config['external-workers'][0]
		profile.command = ['codex', 'exec']
		profile.tiers.basic = 'pty-basic/medium'
		fs.writeFileSync(path.join(source, 'ag.json'), JSON.stringify(config))
		cp.execFileSync('git', ['-C', source, 'add', 'ag.json'])
		cp.execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture routing config'])
		const source_identity = { source_kind: 'git', value: cp.execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
		const contract = require('./routing-contract.js')
		const review_facts = Object.fromEntries([
			...contract.definitions.review.boolean.map(key => [key, false]),
			...contract.definitions.review.scores.map(key => [key, 0]),
		])
		const fake_source = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const payload = JSON.parse(args.at(-1).split('\\n\\n').at(-1))
const brief = payload.brief
const stage = brief.task_id.split(':').at(-1)
const gate = stage === 'primary' ? process.env.AGENTFLOW_TEST_PRIMARY_GATE : stage === 'review' ? process.env.AGENTFLOW_TEST_REVIEW_GATE : ''
if (gate) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10)
}
let text = 'done'
if (stage === 'review') text = JSON.stringify({ schema_version: 1, task_id: brief.task_id, source_identity: brief.source_identity, facts: ${JSON.stringify(review_facts)}, evidence: [] })
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
`
		fs.writeFileSync(fake, fake_source, { mode: 0o755 })
		const facts = {
			source_root: source,
			source_identity,
			task: { task_id: 'pty-l3', brief: { goal: 'Run the bounded PTY fixture' }, work_boundary: [] },
			briefs: { review: { goal: 'Review the accepted L3 result' } },
			admission_facts: {
				material_uncertainty: true,
				substantial_mechanical_execution: true,
				mechanical: false,
				simple: false,
				requirement_clear: true,
				scope_known: true,
				reversible: true,
				deterministic_verification: false,
				risk_flags: [],
				missing_information: [],
				task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'fixture Ask', observation: 'Run the bounded PTY fixture' }] },
				complexity_reasons: {},
			},
			provider_recipes: { [profile.id]: { schema_version: 1, family: 'codex', tier: 'basic', model: 'pty-basic', effort: 'medium', checked: true, validation: 'live-provider' } },
			external_execution: { source_directory: source },
		}
		fs.writeFileSync(facts_path, JSON.stringify(facts))
		const status_before = cp.execFileSync('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
		const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
		const command = `${quote(process.execPath)} ${quote(path.join(__dirname, 'agf.js'))} route run --facts-stdin < ${quote(facts_path)} > ${quote(result_path)}`
		const route_pty = cp.spawn('/usr/bin/script', ['-qefc', command, '/dev/null'], {
			cwd: source,
			env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, AGENTFLOW_TEST_PRIMARY_GATE: gates.primary, AGENTFLOW_TEST_REVIEW_GATE: gates.review },
		})
		let pty_output = ''
		let pty_error = ''
		const status_before_release = []
		const released = new Set()
		let watchdog
		const completed = new Promise((resolve, reject) => {
			route_pty.once('error', error => { clearTimeout(watchdog); reject(error) })
			route_pty.once('close', (code, signal) => {
				clearTimeout(watchdog)
				resolve({ status: code, signal, pty_output, pty_error })
			})
			watchdog = setTimeout(() => {
				for (const stage of Object.keys(gates)) {
					if (released.has(stage)) continue
					released.add(stage)
					fs.writeFileSync(gates[stage], 'release')
				}
			}, 5000)
		})
		route_pty.stdout.setEncoding('utf8').on('data', chunk => {
			pty_output += chunk
			for (const [stage, status] of Object.entries(launch_statuses)) {
				if (released.has(stage) || !pty_output.includes(status)) continue
				status_before_release.push({ stage, route_still_waiting: route_pty.exitCode === null && fs.statSync(result_path).size === 0 })
				released.add(stage)
				fs.writeFileSync(gates[stage], 'release')
			}
		})
		route_pty.stderr.setEncoding('utf8').on('data', chunk => { pty_error += chunk })
		const child = await completed
		assert.equal(child.status, 0, child.pty_output + child.pty_error)
		assert.deepEqual(status_before_release, [
			{ stage: 'primary', route_still_waiting: true },
			{ stage: 'review', route_still_waiting: true },
		])
		assert.deepEqual(child.pty_output.replace(/\r/gu, '').split('\n').filter(line => line.startsWith('[agf] ')), [
			launch_statuses.primary,
			launch_statuses.review,
		])
		assert.equal(JSON.parse(fs.readFileSync(result_path, 'utf8')).status, 'complete')
		assert.equal(cp.execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source_identity.value)
		assert.equal(cp.execFileSync('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }), status_before)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test('formal route resume receives the same stage-aware spawn status callback', async () => {
	const agf = require('./agf.js')
	const original_cli = runner.cli
	const messages = []
	runner.cli = async options => {
		assert.equal(options.command, 'resume')
		assert.equal(typeof options.on_spawn, 'function')
		options.on_spawn({ stage: 'primary', tier: 'basic' })
		return { status: 'complete' }
	}
	try {
		const result = await agf.route_main(['resume', '--task', 'fixture-task'], process.cwd(), message => messages.push(message))
		assert.deepEqual(result, { json: { status: 'complete' }, exitCode: 0 })
		assert.deepEqual(messages, ['[agf] Basic primary worker process launched; next: collect and validate its result.'])
	} finally {
		runner.cli = original_cli
	}
})

test('formal CLI failure keeps JSON, trace, exit code and inspect aligned without raw process output', async () => {
	const cp = require('node:child_process')
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-cli-failure-e2e-'))
	const source = path.join(root, 'source')
	fs.mkdirSync(source)
	cp.execFileSync('git', ['init', '-q', source])
	fs.writeFileSync(path.join(source, 'a.txt'), 'fixture\n')
	cp.execFileSync('git', ['-C', source, 'add', 'a.txt'])
	cp.execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
	const source_identity = { source_kind: 'git', value: cp.execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
	const capture = path.join(root, 'capture.jsonl')
	const fake = path.join(root, 'codex')
	const assessment_module = path.join(__dirname, 'fixtures/routing-assessment.js')
	fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const payload = JSON.parse(args.at(-1).split('\\n\\n').at(-1)); fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid }) + '\\n'); const brief = payload.brief; if (payload.output_contract && payload.output_contract.facts) { const value = JSON.stringify(require(${JSON.stringify(assessment_module)}).assessment_envelope({ material_uncertainty: true, substantial_mechanical_execution: true, deterministic_verification_sufficient: true }, brief.task_id, brief.source_identity)); process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:value}})); } else { process.stdout.write('token=private-stdout'); process.stderr.write('EROFS: read-only file system at /private/runtime token=private-stderr'); process.exit(1); }\n`, { mode: 0o755 })
	const config = route_config(source)
	const profile = config['external-workers'][0]
	profile.command = ['codex', 'exec']
	profile.tiers.basic = 'fixed-basic/medium'
	fs.writeFileSync(path.join(source, 'ag.json'), JSON.stringify(config))
	const task_id = 'formal-failed-primary'
	const facts = {
		source_root: source,
		source_identity,
		task: { task_id, brief: { goal: 'Execute bounded change' }, work_boundary: [] },
		briefs: { assessment: { goal: 'Assess without writing' } },
		admission_facts: { material_uncertainty: true, mechanical: false, simple: false, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: false, risk_flags: [], missing_information: [], task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'fixture Ask', observation: 'Execute bounded change' }] }, complexity_reasons: {} },
		provider_recipes: { [profile.id]: { schema_version: 1, family: 'codex', tier: 'basic', model: 'fixed-basic', effort: 'medium', checked: true, validation: 'live-provider' } },
		external_execution: { source_directory: source, read_only_stages: ['assessment'], read_only_recipes_by_stage: { assessment: { schema_version: 1, provider: 'codex', source_access: 'read-only', arguments: ['--sandbox', 'read-only'], validation: 'live-provider' } } },
	}
	const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` }
	const child = cp.spawnSync(process.execPath, [path.join(__dirname, 'agf.js'), 'route', 'run', '--facts-stdin', '--trace'], { cwd: source, input: JSON.stringify(facts), encoding: 'utf8', env })
	assert.equal(child.status, 4, child.stdout + child.stderr)
	const result = JSON.parse(child.stdout)
	assert.equal(child.stdout.trim().startsWith('{'), true)
	assert.equal(result.status, 'task-failed')
	const primary = result.facts.attempts_by_stage.primary[0]
	assert.equal(primary.transport.failure.outcome, 'nonzero_exit')
	assert.equal(primary.transport.failure.clue, 'read_only_filesystem')
	assert.equal(primary.acceptance.accepted, false)
	assert.match(child.stderr, /^\[agf\] Basic primary worker process launched; next: collect and validate its result\./mu)
	assert.match(child.stderr, /class=L2 \| basic_primary_started=true .*process_started=true \| accepted=false \| result=task-failed \| failure=nonzero_exit \| clue=read_only_filesystem \| exit=1/u)
	assert.match(child.stderr, /\[agf trace\] outcome=task-failed/u)
	assert.equal(JSON.stringify(result).includes('private-stdout'), false)
	assert.equal(JSON.stringify(result).includes('private-stderr'), false)
	assert.equal(child.stderr.includes('private-stdout'), false)
	assert.equal(child.stderr.includes('private-stderr'), false)
	assert.equal(fs.readFileSync(capture, 'utf8').trim().split('\n').length, 1)
	const inspected = cp.spawnSync(process.execPath, [path.join(__dirname, 'agf.js'), 'route', 'inspect', '--task', task_id], { cwd: source, encoding: 'utf8', env })
	assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr)
	const inspection = JSON.parse(inspected.stdout)
	assert.equal(inspection.status, 'loaded')
	assert.deepEqual(inspection.facts.attempts_by_stage.primary[0].transport.failure, primary.transport.failure)
	assert.equal(inspected.stdout.includes('private-stdout'), false)
	assert.equal(inspected.stdout.includes('private-stderr'), false)
})

test('formal CLI rejects unchecked legacy recipe arguments and caller-supplied accepted history', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-cli-provenance-'))
	const config = route_config(root)
	const profile = config['external-workers'][0]
	const facts = {
		task: { task_id: 'legacy-route', brief: { goal: 'Execute bounded task' }, work_boundary: [] },
		provider_recipes: { [profile.id]: { checked: true } },
		external_execution: { source_directory: root, arguments_by_stage: { primary: ['--model', 'wrong-model'] } },
		admission_facts: { task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'Ask', observation: 'Execute bounded task' }] }, complexity_reasons: {}, mechanical: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true },
	}
	const legacy = await runner.cli({ command: 'plan', cwd: root, active_host: 'codex', executable_available: () => true, facts })
	assert.equal(legacy.status, 'invalid')
	assert.match(legacy.requirement, /checked.*live-provider/)
	facts.provider_recipes[profile.id].validation = 'fixture'
	const fixture = await runner.cli({ command: 'plan', cwd: root, active_host: 'codex', executable_available: () => true, facts })
	assert.equal(fixture.status, 'invalid')
	assert.match(fixture.requirement, /checked.*live-provider/)
	const [model, effort] = profile.tiers.cheap.split('/')
	facts.provider_recipes[profile.id] = { schema_version: 1, family: 'codex', tier: 'cheap', model, effort, checked: true, validation: 'live-provider' }
	facts.records = { primary: { state: 'completed', acceptance: { accepted: true } } }
	const history = await runner.cli({ command: 'run', cwd: root, active_host: 'codex', executable_available: () => true, facts })
	assert.equal(history.status, 'invalid')
	assert.match(history.requirement, /caller-supplied.*history/)
})

test('production dispatch rejects wrong/default model command before spawn', async () => {
	for (const extra of [['--model', 'wrong-model'], ['-mwrong-model'], ['--config', 'model_reasoning_effort=low'], ['--config=model_reasoning_effort=low'], ['--']]) {
		const { facts, profile, planner } = basic_provider_route()
		profile.command.push(...extra)
		let starts = 0
		facts.external_execution = { source_directory: process.cwd(), run_external_command: async () => { starts += 1; throw new Error('must not start') } }
		const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
		assert.equal(result.status, 'unavailable')
		assert.match(result.requirement, /invocation.*exactly one/)
		assert.equal(starts, 0)
	}
})

test('post-spawn observer failure preserves started uncertain attempt and trace', async () => {
	const { facts, planner } = basic_provider_route()
	facts.external_execution = { source_directory: process.cwd(), observe_transport: () => { throw new Error('observer unavailable token=callback-secret /private/callback') }, run_external_command: async () => ({ status: 'completed', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), stderr: 'warning: EROFS was mentioned by the provider', result: { value: null }, process: { pid: 4321, exit_code: 0 }, clone: { head: facts.source_identity.value }, limitations: [] }) }
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, runner.adapters_for(facts), { planner })
	assert.equal(result.status, 'uncertain')
	const failed = result.facts.attempts_by_stage.primary[0]
	assert.equal(failed.transport.worker_started, true)
	assert.equal(failed.transport.process.pid, 4321)
	assert.equal(failed.reason, 'post-spawn adapter failure')
	assert.equal(failed.transport.failure.outcome, 'adapter_failure')
	assert.equal(failed.transport.failure.clue, 'unknown')
	assert.equal(JSON.stringify(failed).includes('callback-secret'), false)
	assert.equal(JSON.stringify(failed).includes('/private/callback'), false)
	const trace = require('./routing-trace.js').format(result).join('\n')
	assert.match(trace, /dispatch_model=fixture-basic.*process_started=true.*accepted=false.*result=uncertain.*failure=adapter_failure/)
	assert.equal(trace.includes('worker_started='), false)
})

test('direct facts-file CLI refuses caller routing history for plan and run', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-direct-history-'))
	const file = path.join(root, 'facts.json')
	fs.writeFileSync(file, JSON.stringify({ task: { task_id: 'supplied-history' }, records: { primary: { state: 'completed' } } }))
	for (const command of ['plan', 'run']) {
		const result = await runner.main([command, file])
		assert.equal(result.status, 'invalid')
		assert.match(result.requirement, /caller-supplied routing history/)
	}
})
