'use strict'

const routing_coordinator = require('./routing-coordinator.js')
const delegation_route = require('./delegation-route.js')
const usage_policy = require('./usage-policy.js')

const DEFAULT_MAX_ACTIONS = Object.keys(routing_coordinator.STAGES).length
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => JSON.parse(JSON.stringify(value))
const USAGE_COUNTERS = Object.freeze([
	'external_workers',
	'independent_reviewers',
	'debate_perspectives',
	'debate_syntheses',
	'retries_per_approach',
	'discovery_iterations',
	'expensive_calls',
])

const usage_snapshot = usage => Object.fromEntries(
	USAGE_COUNTERS.map(name => [name, usage?.[name] ?? 0]),
)

const merge_usage = (usage, delta) => Object.fromEntries(
	USAGE_COUNTERS.map(name => [name, (usage?.[name] ?? 0) + (delta[name] ?? 0)]),
)

const launch_delta = (plan, facts) => ({
	external_workers: plan.selection.kind === 'external' &&
		!(facts.launched_candidates || []).includes(plan.selection.candidate_id) ? 1 : 0,
	retries_per_approach: (facts.attempts_by_stage?.[plan.stage] || []).length > 0 ? 1 : 0,
	expensive_calls: plan.tier === 'better' ? 1 : 0,
})

const accepted_stage_delta = stage => ({
	discovery_iterations: stage === 'assessment' ? 1 : 0,
	independent_reviewers: stage === 'review' ? 1 : 0,
	debate_perspectives: ['debate-a', 'debate-b'].includes(stage) ? 1 : 0,
	debate_syntheses: stage === 'synthesis' ? 1 : 0,
})

const would_exceed_budget = (usage, delta) => Object.entries(merge_usage(usage, delta)).find(
	([name, value]) => value > usage_policy.LIMITS[name],
)

const adapter_for = (adapters, kind) => {
	if (!is_object(adapters)) return null
	return typeof adapters[kind] === 'function' ? adapters[kind] : null
}

const store_record = (facts, stage, record) => {
	const next = {
		...facts,
		records: {
			...(facts.records || {}),
			[stage]: clone(record),
		},
	}
	if (stage === 'review' && is_object(record.outputs?.review_facts)) {
		next.review_facts = clone(record.outputs.review_facts)
	}
	return { ...next, usage: merge_usage(next.usage, accepted_stage_delta(stage)) }
}

const store_attempt = (facts, stage, record) => ({
	...facts,
	attempts: [...(facts.attempts || []), clone(record)],
	attempts_by_stage: {
		...(facts.attempts_by_stage || {}),
		[stage]: [...(facts.attempts_by_stage?.[stage] || []), clone(record)],
	},
})

const run_lifecycle = async (facts, adapters = {}, options = {}) => {
	if (!is_object(facts)) return { status: 'unsatisfied', requirement: 'routing lifecycle facts must be an object', steps: [] }
	const max_actions = options.max_actions === undefined ? DEFAULT_MAX_ACTIONS : options.max_actions
	if (!Number.isInteger(max_actions) || max_actions < 1) {
		return { status: 'unsatisfied', requirement: 'max_actions must be a positive integer', steps: [] }
	}

	let current = clone(facts)
	const steps = []
	let action_count = 0

	for (;;) {
		const plan = routing_coordinator.plan_next_action(current)
		if (plan.status !== 'selected') return { ...plan, facts: current, steps }
		const delta = launch_delta(plan, current)
		const exhausted = would_exceed_budget(current.usage, delta)
		if (exhausted) {
			return {
				status: 'stopped',
				stage: plan.stage,
				requirement: `${exhausted[0]} budget would exceed ${usage_policy.LIMITS[exhausted[0]]}`,
				plan,
				facts: current,
				steps,
			}
		}
		if (action_count >= max_actions) {
			return {
				status: 'action-limit',
				stage: plan.stage,
				requirement: `routing lifecycle exceeded ${max_actions} actions`,
				plan,
				facts: current,
				steps,
			}
		}

		const execute = adapter_for(adapters, plan.selection.kind)
		if (execute === null) {
			return {
				status: 'awaiting-executor',
				stage: plan.stage,
				requirement: `no ${plan.selection.kind} executor adapter is available`,
				plan,
				facts: current,
				steps,
			}
		}

		let record
		try {
			record = await execute({
				stage: plan.stage,
				tier: plan.tier,
				routing: clone(plan.routing),
				task: clone(plan.task),
				selection: clone(plan.selection),
				facts: clone(current),
			})
		} catch (error) {
			return {
				status: 'uncertain',
				stage: plan.stage,
				requirement: `adapter did not return a settled execution record: ${error instanceof Error ? error.message : String(error)}`,
				plan,
				facts: current,
				steps,
			}
		}

		const validation_error = delegation_route.validate_execution_record(record, { ...plan.task, allow_uncertain: true })
		if (validation_error) {
			return {
				status: 'unsatisfied',
				stage: plan.stage,
				requirement: validation_error,
				plan,
				facts: current,
				steps,
			}
		}
		const after_launch = {
			...store_attempt(current, plan.stage, record),
			usage: merge_usage(current.usage, delta),
			...(delta.external_workers ? { launched_candidates: [...(current.launched_candidates || []), plan.selection.candidate_id] } : {}),
		}
		const acceptance_error = routing_coordinator.accepted_record(record, plan.task.task_id)
		if (acceptance_error) {
			if (record.state === 'unavailable') {
				const fallback = delegation_route.next_executor_action({ ...after_launch, task: plan.task }, record)
				if (fallback.status === 'selected') {
					current = after_launch
					steps.push({ stage: plan.stage, state: 'unavailable', candidate_id: record.candidate_id })
					action_count += 1
					continue
				}
			}
			return {
				status: record.state === 'completed' ? 'awaiting-acceptance' : record.state,
				stage: plan.stage,
				requirement: acceptance_error,
				record: clone(record),
				plan,
				facts: after_launch,
				steps,
			}
		}

		current = store_record(after_launch, plan.stage, record)
		steps.push({
			stage: plan.stage,
			tier: plan.tier,
			kind: plan.selection.kind,
			candidate_id: plan.selection.candidate_id,
			task_id: plan.task.task_id,
		})
		action_count += 1
	}
}

module.exports = {
	DEFAULT_MAX_ACTIONS,
	USAGE_COUNTERS,
	adapter_for,
	usage_snapshot,
	merge_usage,
	launch_delta,
	accepted_stage_delta,
	would_exceed_budget,
	store_record,
	store_attempt,
	run_lifecycle,
}
