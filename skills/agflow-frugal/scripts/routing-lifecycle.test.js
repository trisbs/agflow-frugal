'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const lifecycle = require('./routing-lifecycle.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const base = () => ({
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
	requested: {},
	actual: { model: context.selection.actual.model, effort: context.selection.actual.effort },
	state: 'completed',
	outputs,
	changed_paths: [],
	acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
	limitations: [],
	transport: {
		runner_id: 'external-runner-v1',
		...(context.stage === 'assessment' ? { read_only: true } : {}),
		process: { exit_code: 0 },
	},
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
	assert.equal(result.facts.records.assessment.outputs.routing_assessment.material_uncertainty, true)
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
	facts.usage = { external_workers: 1 }
	const result = await lifecycle.run_lifecycle(facts, {
		external: async () => { launches += 1 },
	})
	assert.equal(result.status, 'stopped')
	assert.match(result.requirement, /external_workers budget/)
	assert.equal(launches, 0)

	assert.deepEqual(
		lifecycle.would_exceed_budget({ expensive_calls: 2 }, { expensive_calls: 1 }),
		['expensive_calls', 3],
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
