'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const policy = require('./usage-policy.js')

const light_facts = {
	requirement_clear: true,
	scope_known: true,
	reversible: true,
	deterministic_verification: true,
	risk_flags: [],
	missing_information: [],
}

test('L0 and L1 require every safety gate before using cheap', () => {
	const mechanical = policy.route_task({ ...light_facts, mechanical: true })
	assert.equal(mechanical.execution_class, 'L0')
	assert.equal(mechanical.route, 'Cheap Direct')
	assert.equal(mechanical.primary_tier, 'cheap')

	const simple = policy.route_task({ ...light_facts, simple: true })
	assert.equal(simple.execution_class, 'L1')
	assert.equal(simple.route, 'Cheap Direct')
})

test('unproven or incomplete light tasks escalate to L2 basic', () => {
	const unproven = policy.route_task({ simple: true, deterministic_verification: true })
	assert.equal(unproven.execution_class, 'L2')
	assert.equal(unproven.route, 'Basic Direct')
	assert.equal(unproven.primary_tier, 'basic')

	const incomplete = policy.route_task({ ...light_facts, simple: true, missing_information: ['affected boundary'] })
	assert.equal(incomplete.execution_class, 'L2')
	assert.match(incomplete.basis, /missing information/i)
})

test('cheap admission exposes only L0, L1, or ESCALATE', () => {
	const admitted = policy.admit_cheap({ ...light_facts, simple: true })
	assert.equal(admitted.admitted, true)
	assert.equal(admitted.execution_class, 'L1')

	const escalated = policy.admit_cheap({ material_uncertainty: true, substantial_mechanical_execution: true })
	assert.equal(escalated.admitted, false)
	assert.equal(escalated.execution_class, 'ESCALATE')
	assert.equal(escalated.floor_class, 'L3')
})

test('escalated basic classification cannot return below L2', () => {
	const result = policy.classify_escalated_task({ ...light_facts, mechanical: true })
	assert.equal(result.execution_class, 'L2')
	assert.match(result.basis, /L2 minimum/)
})

test('explicit metadata may raise a class but cannot lower verified risk', () => {
	assert.equal(policy.classify_task({ ...light_facts, simple: true, execution_class: 'L3' }).execution_class, 'L3')
	const protected_result = policy.classify_task({
		...light_facts,
		mechanical: true,
		execution_class: 'L0',
		risk_flags: ['authentication'],
	})
	assert.equal(protected_result.execution_class, 'L4')
	assert.match(protected_result.basis, /raised/i)
})

test('L2 and L3 use basic as the primary worker tier', () => {
	const reasoning = policy.route_task({ material_uncertainty: true })
	assert.equal(reasoning.execution_class, 'L2')
	assert.equal(reasoning.route, 'Basic Direct')
	assert.equal(reasoning.primary_tier, 'basic')

	const substantial = policy.route_task({ material_uncertainty: true, substantial_mechanical_execution: true })
	assert.equal(substantial.execution_class, 'L3')
	assert.equal(substantial.route, 'Basic Direct')
})

test('risk flags and high consequence use basic plus conditional better review', () => {
	assert.equal(policy.classify_task({ risk_flags: ['data migration'] }).execution_class, 'L4')
	const reviewed = policy.route_task({ high_consequence: true, material_risk: true, deterministic_verification_sufficient: false })
	assert.equal(reviewed.route, 'Basic Direct')
	assert.equal(reviewed.primary_tier, 'basic')
	assert.equal(reviewed.secondary_tier, 'better')
	assert.equal(reviewed.review, true)
	assert.equal(reviewed.debate, false)
	const deterministic = policy.route_task({ high_consequence: true, material_risk: true, deterministic_verification_sufficient: true })
	assert.equal(deterministic.review, false)
	assert.equal(deterministic.secondary_tier, null)
})

test('L5 uses basic coordination and better only after every debate gate passes', () => {
	const complete = {
		high_consequence: true, material_disagreement: true,
		material_risk: true, deterministic_verification_sufficient: false,
		D: 2, T: 2, I: 2, E: 1, R: 1,
		viable_alternatives: true, meaningful_tradeoffs: true,
		substantial_consequence: true, cheap_resolution_exhausted: true,
		reviewer_material_disagreement: true,
	}
	assert.equal(policy.route_task(complete).route, 'Basic Coordinator')
	assert.equal(policy.route_task(complete).primary_tier, 'basic')
	assert.equal(policy.route_task(complete).secondary_tier, 'better')
	assert.equal(policy.route_task(complete).debate, true)
	assert.equal(policy.route_task({ ...complete, cheap_resolution_exhausted: false }).debate, false)
	assert.equal(policy.route_task({ ...complete, deterministic_verification_sufficient: true }).debate, false)
})

test('retry and budget exhaustion stop rather than escalate', () => {
	assert.equal(policy.budget_state({ retries_per_approach: 2 }).pressure, 'STOP')
	const stopped = policy.route_task({ material_uncertainty: true }, { external_workers: 3 })
	assert.equal(stopped.route, 'STOP')
	assert.match(stopped.stop_reason, /external_workers/)
})

test('raised worker, reviewer, and Better-call ceilings preserve the required journey', () => {
	const delegated = policy.route_task({ material_uncertainty: true, substantial_mechanical_execution: true }, { external_workers: 1 })
	assert.equal(delegated.pressure, 'NORMAL')
	assert.equal(delegated.route, 'Basic Direct')
	assert.equal(delegated.primary_tier, 'basic')
	const reviewed = policy.route_task({ high_consequence: true, material_risk: true, deterministic_verification_sufficient: false }, { external_workers: 1 })
	assert.equal(reviewed.pressure, 'NORMAL')
	assert.equal(reviewed.review, true)
	assert.equal(policy.budget_state({ external_workers: 1 }).pressure, 'NORMAL')
	assert.equal(policy.budget_state({ external_workers: 2 }).pressure, 'CONSERVE')
	assert.equal(policy.budget_state({ expensive_calls: 3 }).pressure, 'NORMAL')
	assert.equal(policy.budget_state({ expensive_calls: 4 }).pressure, 'CONSERVE')
	assert.equal(policy.budget_state({ independent_reviewers: 1 }).pressure, 'NORMAL')
	assert.equal(policy.budget_state({ independent_reviewers: 2 }).pressure, 'CONSERVE')
})

test('routing arrays reject malformed evidence', () => {
	assert.equal(policy.classify_task({ risk_flags: 'security' }).valid, false)
	assert.equal(policy.classify_task({ missing_information: [''] }).valid, false)
})

test('telemetry records observed values and leaves unavailable values null', () => {
	const result = policy.create_telemetry_record({
		execution_class: 'L1', execution_path: 'Cheap Direct', model_effort: 'configured-cheap',
		llm_calls: 1, workers: 0, reviews: 0, debates: 0, retries: 0, tool_calls: 3,
		outcome: 'success', pressure: 'NORMAL',
	})
	assert.equal(result.valid, true)
	assert.equal(result.record.input_tokens, null)
	assert.equal(result.record.workers, 0)
})
