'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const lifecycle = require('./routing-lifecycle.js')
const { assessment_envelope } = require('./fixtures/routing-assessment.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const base = () => ({
	source_identity,
	admission_facts: {
		material_uncertainty: true,
	},
	config: {
		switches: {
			'allowed-worker': ['external'],
			'review-policy': 'prefer-independent',
			'cli-provider': 'on',
		},
		'pipeline-roles': {
			explore: 'basic',
			implementation: 'basic',
		},
	},
	policy: {
		'allowed-worker': ['external'],
		'review-policy': 'prefer-independent',
		'cli-provider': 'on',
	},
	host: { id: 'codex', family: 'codex' },
	capabilities: {
		external: [{
			candidate_id: 'codex-worker',
			id: 'codex-worker',
			priority: 3,
			family: 'codex',
			available: true,
			recipe_checked: true,
			command: ['codex', 'exec'],
			controls: { read_only: true },
			tiers: {
				cheap: 'gpt-cheap/low',
				basic: 'gpt-basic/medium',
				better: 'gpt-better/medium',
			},
		}],
	},
	task: {
		task_id: 'task-1',
		role: 'implementation',
		brief: { goal: 'Execute the primary task' },
		work_boundary: ['src/a.js'],
		interactive_host: false,
	},
	briefs: {
		assessment: { goal: 'Return structured routing facts without modifying files' },
		review: { goal: 'Review the accepted L3 Basic result' },
	},
	records: {},
})

const accepted_record = (context, outputs) => ({
	record_version: 1,
	task_id: context.task.task_id,
	attempt_id: `attempt-${context.stage}`,
	candidate_id: context.selection.candidate_id,
	kind: context.selection.kind,
	role: context.task.role,
	source_identity,
	requested: context.selection.requested,
	stage_input_digest: context.task.stage_input_digest,
	actual: { model: context.selection.actual.model, effort: context.selection.actual.effort },
	dispatched: { ...context.selection.actual, stage: context.stage, tier: context.tier, profile: context.selection.candidate_id, invocation_digest: require('node:crypto').createHash('sha256').update(`${context.task.task_id}:${context.stage}:${context.selection.candidate_id}`).digest('hex'), provenance: 'configured-provider-invocation-v1' },
	state: 'completed',
	outputs: outputs?.routing_assessment ? { routing_assessment_envelope: assessment_envelope(outputs.routing_assessment, context.task.task_id, source_identity) } : outputs,
	changed_paths: [],
	acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
	limitations: [],
	transport: {
		worker_started: true,
		runner_id: 'external-runner-v1',
		...(context.stage === 'assessment' ? { read_only: true } : {}),
		process: { exit_code: 0 },
	},
})
const complete_non_plan_admission = overrides => ({
	task_plan: assessment_envelope({}, '', source_identity).facts.task_plan,
	complexity_reasons: {},
	mechanical: false,
	simple: false,
	requirement_clear: true,
	scope_known: true,
	reversible: true,
	deterministic_verification: false,
	risk_flags: [],
	missing_information: [],
	...overrides,
})

test('lifecycle executes assessment and primary until routing completes', async () => {
	const facts = base()
	const stages = []
	const result = await lifecycle.run_lifecycle(facts, {
		external: async context => {
			stages.push(context.stage)
			return accepted_record(
				context,
				context.stage === 'assessment'
					? { routing_assessment: { material_uncertainty: true } }
					: { result: 'implemented' },
			)
		},
	})

	assert.equal(result.status, 'complete')
	assert.deepEqual(stages, ['assessment', 'primary'])
	assert.deepEqual(result.steps.map(step => step.stage), ['assessment', 'primary'])
	assert.equal(result.facts.records.assessment.outputs.routing_assessment_envelope.facts.material_uncertainty, true)
	assert.equal(result.facts.records.primary.outputs.result, 'implemented')
	assert.deepEqual(facts.records, {})
})

test('lifecycle pauses when the selected transport adapter is unavailable', async () => {
	const result = await lifecycle.run_lifecycle(base())
	assert.equal(result.status, 'awaiting-executor')
	assert.equal(result.stage, 'assessment')
	assert.match(result.requirement, /external executor adapter/)
	assert.deepEqual(result.steps, [])
})

test('lifecycle refuses invalid or unaccepted execution evidence', async () => {
	const invalid = await lifecycle.run_lifecycle(base(), {
		external: async context => ({
			...accepted_record(context, { routing_assessment: { material_uncertainty: true } }),
			task_id: 'wrong-task',
		}),
	})
	assert.equal(invalid.status, 'awaiting-acceptance')
	assert.match(invalid.requirement, /task_id/)

	const unaccepted = await lifecycle.run_lifecycle(base(), {
		external: async context => ({
			...accepted_record(context, { routing_assessment: { material_uncertainty: true } }),
			acceptance: { checks_run: true, coordinator_inspected: true, accepted: false },
		}),
	})
	assert.equal(unaccepted.status, 'unsatisfied')
	assert.match(unaccepted.requirement, /coordinator inspection, and acceptance/)
})

test('lifecycle reports executor failures without recording a stage', async () => {
	const result = await lifecycle.run_lifecycle(base(), {
		external: async () => {
			throw new Error('worker transport failed')
		},
	})
	assert.equal(result.status, 'uncertain')
	assert.equal(result.stage, 'assessment')
	assert.match(result.requirement, /worker transport failed/)
	assert.deepEqual(result.facts.records, {})
})

const unsuccessful_record = (context, state) => ({
	...accepted_record(context, { diagnostic: state }),
	state,
	acceptance: { checks_run: false, coordinator_inspected: true, accepted: false },
	transport: {
		worker_started: true,
		runner_id: 'external-runner-v1',
		read_only: context.stage === 'assessment',
		worker_started: state === 'unavailable' ? false : true,
		...(state === 'cancelled' ? { stop_verified: true } : {}),
		process: { exit_code: state === 'unavailable' ? 127 : 1 },
	},
})

for (const state of ['task-failed', 'cancelled', 'uncertain']) {
	test(`lifecycle persists settled ${state} without an automatic relaunch`, async () => {
		let launches = 0
		const result = await lifecycle.run_lifecycle(base(), {
			external: async context => {
				launches += 1
				return unsuccessful_record(context, state)
			},
		})
		assert.equal(result.status, state)
		assert.equal(launches, 1)
		assert.equal(result.facts.attempts_by_stage.assessment[0].state, state)
	})
}

test('lifecycle stops before a launch that would exceed a budget', async () => {
	let launches = 0
	const facts = base()
	facts.usage = { external_workers: 2 }
	const result = await lifecycle.run_lifecycle(facts, {
		external: async () => { launches += 1 },
	})
	assert.equal(result.status, 'stopped')
	assert.match(result.requirement, /external_workers budget would exceed/)
	assert.equal(launches, 0)

	assert.deepEqual(
		lifecycle.would_exceed_budget({ expensive_calls: 4 }, { expensive_calls: 1 }),
		['expensive_calls', 5],
	)
})

test('accepted stages update coordinator-owned usage counters', async () => {
	const result = await lifecycle.run_lifecycle(base(), {
		external: async context => accepted_record(
			context,
			context.stage === 'assessment'
				? { routing_assessment: { material_uncertainty: true } }
				: { result: 'implemented' },
		),
	})
	assert.equal(result.status, 'complete')
	assert.equal(result.facts.usage.external_workers, 1)
	assert.equal(result.facts.usage.discovery_iterations, 1)
})

test('ordinary L2 runs one Basic primary while L3 requires a separate accepted Basic review', async () => {
	for (const execution_class of ['L2', 'L3']) {
		const facts = base()
		facts.admission_facts = complete_non_plan_admission({
			material_uncertainty: true,
			...(execution_class === 'L3' ? { substantial_mechanical_execution: true } : {}),
		})
		const stages = []
		const result = await lifecycle.run_lifecycle(facts, {
			external: async context => {
				stages.push([context.stage, context.tier])
				return accepted_record(context, { result: context.stage })
			},
		})
		assert.equal(result.status, 'complete', result.requirement)
		assert.deepEqual(stages, execution_class === 'L2'
			? [['primary', 'basic']]
			: [['primary', 'basic'], ['review', 'basic']])
		assert.equal(result.facts.records.assessment, undefined)
		assert.equal(result.facts.records.primary.acceptance.accepted, true)
		if (execution_class === 'L3') assert.equal(result.facts.records.review.acceptance.accepted, true)
	}
})

test('given L3 routing rejects Cheap host and forged evidence without classification', async () => {
	const coordinator = require('./routing-coordinator.js')
	const policy = require('./usage-policy.js')
	const original = policy.classify_escalated_task
	let classified = 0
	policy.classify_escalated_task = () => { classified += 1; throw new Error('classifier must not run') }
	try {
		const facts = { ...base(), source_identity }
		const routing = { valid: true, execution_class: 'L3', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }
		facts.policy['allowed-worker'] = ['host']
		facts.capabilities.host = { candidate_id: 'cheap-host', available: true, model: 'cheap', effort: 'low', tiers: { cheap: 'cheap/low' } }
		const planner = current => coordinator.plan_class_action(current, routing)
		assert.equal((await lifecycle.run_lifecycle(facts, {}, { planner })).status, 'unsatisfied')
		facts.policy['allowed-worker'] = ['external']
		const missing = await lifecycle.run_lifecycle(facts, {}, { planner })
		assert.equal(missing.status, 'awaiting-executor')
		assert.deepEqual(missing.steps, [])
		const forged = await lifecycle.run_lifecycle(facts, { external: async context => ({
			...accepted_record(context, { result: 'wrong tier' }), dispatched: { ...accepted_record(context, {}).dispatched, model: 'cheap', effort: 'low' },
		}) }, { planner })
		assert.notEqual(forged.status, 'complete')
		assert.match(forged.requirement, /tier|identity/)
		const stages = []
		const correct = await lifecycle.run_lifecycle(facts, { external: async context => {
			stages.push([context.stage, context.tier])
			return accepted_record(context, { result: 'done' })
		} }, { planner })
		assert.equal(correct.status, 'complete', correct.requirement)
		assert.equal(correct.steps[0].tier, 'basic')
		assert.deepEqual(stages, [['primary', 'basic'], ['review', 'basic']])
		assert.equal(classified, 0)
	} finally { policy.classify_escalated_task = original }
})

test('stage acceptance rejects missing starts, wrong stage, stale source and stale input', async () => {
	const coordinator = require('./routing-coordinator.js')
	const routing = { valid: true, execution_class: 'L3', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }
	for (const [change, reason] of [
		[record => ({ ...record, transport: { ...record.transport, worker_started: false } }), /started/],
		[record => ({ ...record, task_id: 'task-1:review' }), /task_id/],
		[record => ({ ...record, source_identity: { source_kind: 'git', value: 'f'.repeat(40) } }), /source identity/],
		[record => ({ ...record, stage_input_digest: 'f'.repeat(64) }), /stage input/],
		[record => ({ ...record, candidate_id: 'different-worker' }), /identity/],
		[record => ({ ...record, kind: 'host', candidate_id: 'cheap-host', actual: { model: 'cheap', effort: 'low' }, transport: { session_id: 'cheap-session', worker_started: true } }), /identity/],
		[record => ({ ...record, requested: { tier: 'cheap' } }), /tier/],
	]) {
		const result = await lifecycle.run_lifecycle(base(), {
			external: async context => change(accepted_record(context, { result: 'done' })),
		}, { planner: facts => coordinator.plan_class_action(facts, routing) })
		assert.notEqual(result.status, 'complete')
		assert.match(result.requirement, reason)
		assert.deepEqual(result.facts.records, {})
	}
})

test('all validated classes use the common planner with the existing primary tier', () => {
	const coordinator = require('./routing-coordinator.js')
	for (const execution_class of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
		const primary_tier = ['L0', 'L1'].includes(execution_class) ? 'cheap' : 'basic'
		const plan = coordinator.plan_class_action(base(), { valid: true, execution_class, primary_tier, pressure: 'NORMAL', review: false, debate: false })
		assert.equal(plan.status, 'selected')
		assert.equal(plan.stage, 'primary')
		assert.equal(plan.tier, primary_tier)
	}
	assert.equal(coordinator.plan_class_action(base(), { valid: true, execution_class: 'L3', primary_tier: 'cheap' }).status, 'unsatisfied')
})

test('unavailable Basic worker cannot fall back to a Cheap host', async () => {
	const facts = base()
	facts.policy['allowed-worker'] = ['external', 'host']
	facts.capabilities.host = { candidate_id: 'cheap-host', available: true, tier: 'cheap', model: 'cheap', effort: 'low' }
	let launches = 0
	const result = await lifecycle.run_lifecycle(facts, { external: async context => {
		launches += 1
		return unsuccessful_record(context, 'unavailable')
	} })
	assert.notEqual(result.status, 'complete')
	assert.equal(launches, 1)
	assert.deepEqual(result.facts.records, {})
})

test('same-tier fallback trace binds failed spawn and successful worker to their own attempts', async () => {
	const coordinator = require('./routing-coordinator.js')
	const facts = base()
	facts.capabilities.external.push({ ...facts.capabilities.external[0], candidate_id: 'fallback-worker', id: 'fallback-worker' })
	const result = await lifecycle.run_lifecycle(facts, { external: async context => context.selection.candidate_id === 'codex-worker'
		? { ...unsuccessful_record(context, 'unavailable'), transport: { runner_id: 'external-runner-v1', worker_started: false, clone: { path: '/fixture/failed' }, process: { error: 'ENOENT' } } }
		: { ...accepted_record(context, { result: 'done' }), transport: { runner_id: 'external-runner-v1', worker_started: true, process: { pid: 9876, exit_code: 0 } } }
	}, { planner: current => coordinator.plan_class_action(current, { valid: true, execution_class: 'L2', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }) })
	assert.equal(result.status, 'complete', result.requirement)
	const lines = require('./routing-trace.js').format(result)
	assert.match(lines[0], /tier=basic.*external\/codex-worker.*profile=codex-worker.*process_started=false.*accepted=false.*result=unavailable/)
	assert.doesNotMatch(lines[0], /fallback-worker|exit=0/)
	assert.match(lines[1], /tier=basic.*external\/fallback-worker.*profile=fallback-worker.*process_started=true.*accepted=true.*result=completed/)
})

test('fallback trace includes a started second attempt whose output fails acceptance', async () => {
	const coordinator = require('./routing-coordinator.js')
	const facts = base()
	facts.capabilities.external.push({ ...facts.capabilities.external[0], candidate_id: 'fallback-worker', id: 'fallback-worker' })
	const result = await lifecycle.run_lifecycle(facts, { external: async context => context.selection.candidate_id === 'codex-worker'
		? { ...unsuccessful_record(context, 'unavailable'), transport: { runner_id: 'external-runner-v1', worker_started: false, clone: { path: '/fixture/failed' } } }
		: { ...unsuccessful_record(context, 'task-failed'), transport: { runner_id: 'external-runner-v1', worker_started: true, process: { pid: 9876, exit_code: 1 } } }
	}, { planner: current => coordinator.plan_class_action(current, { valid: true, execution_class: 'L2', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }) })
	assert.equal(result.status, 'task-failed')
	const lines = require('./routing-trace.js').format(result)
	assert.match(lines[0], /external\/codex-worker.*process_started=false.*accepted=false.*result=unavailable/)
	assert.ok(lines.some(line => /tier=basic.*external\/fallback-worker.*process_started=true.*accepted=false.*result=task-failed.*exit=1/.test(line)), lines.join('\n'))
})
