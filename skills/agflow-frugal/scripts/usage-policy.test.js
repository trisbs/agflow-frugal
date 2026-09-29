'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const policy = require('./usage-policy.js')

test('mechanical and simple verified tasks use Light Direct', () => {
	assert.equal(policy.route_task({ mechanical: true, deterministic_verification: true }).route, 'Light Direct')
	assert.equal(policy.route_task({ simple: true, deterministic_verification: true }).route, 'Light Direct')
})

test('reasoning and ambiguous tasks use Medium Direct', () => {
	assert.equal(policy.route_task({ material_uncertainty: true }).route, 'Medium Direct')
	const ambiguous = policy.route_task({ simple: true, deterministic_verification: false })
	assert.equal(ambiguous.route, 'Medium Direct')
	assert.match(ambiguous.basis, /ambiguous/i)
})

test('substantial mechanical execution after reasoning permits one Terra Medium executor', () => {
	assert.equal(policy.route_task({ material_uncertainty: true, substantial_mechanical_execution: true }).route, 'Medium → Terra')
})

test('high risk uses Medium and review only when deterministic verification is insufficient', () => {
	const reviewed = policy.route_task({ high_consequence: true, material_risk: true, deterministic_verification_sufficient: false })
	assert.equal(reviewed.route, 'Medium Direct')
	assert.equal(reviewed.review, true)
	assert.equal(reviewed.debate, false)
	const deterministic = policy.route_task({ high_consequence: true, material_risk: true, deterministic_verification_sufficient: true })
	assert.equal(deterministic.review, false)
})

test('debate requires every L5 hard gate plus prior review eligibility', () => {
	const complete = {
		high_consequence: true, material_disagreement: true,
		material_risk: true, deterministic_verification_sufficient: false,
		D: 2, T: 2, I: 2, E: 1, R: 1,
		viable_alternatives: true, meaningful_tradeoffs: true,
		substantial_consequence: true, cheap_resolution_exhausted: true,
		reviewer_material_disagreement: true,
	}
	assert.equal(policy.route_task(complete).debate, true)
	assert.equal(policy.route_task({ ...complete, cheap_resolution_exhausted: false }).debate, false)
	assert.equal(policy.route_task({ ...complete, deterministic_verification_sufficient: true }).debate, false)
})

test('retry and budget exhaustion stop rather than escalate', () => {
	assert.equal(policy.budget_state({ retries_per_approach: 2 }).pressure, 'STOP')
	const stopped = policy.route_task({ material_uncertainty: true }, { external_workers: 2 })
	assert.equal(stopped.route, 'STOP')
	assert.match(stopped.stop_reason, /external_workers/)
})

test('conserve pressure disables optional delegation and review', () => {
	const delegated = policy.route_task({ material_uncertainty: true, substantial_mechanical_execution: true }, { external_workers: 1 })
	assert.equal(delegated.pressure, 'CONSERVE')
	assert.equal(delegated.route, 'Medium Direct')
	const reviewed = policy.route_task({ high_consequence: true, material_risk: true, deterministic_verification_sufficient: false }, { external_workers: 1 })
	assert.equal(reviewed.review, false)
})

test('telemetry records observed values and leaves unavailable values null', () => {
	const result = policy.create_telemetry_record({
		execution_class: 'L1', execution_path: 'Light Direct', model_effort: 'gpt-5.6-sol/low',
		llm_calls: 1, workers: 0, reviews: 0, debates: 0, retries: 0, tool_calls: 3,
		outcome: 'success', pressure: 'NORMAL',
	})
	assert.equal(result.valid, true)
	assert.equal(result.record.input_tokens, null)
	assert.equal(result.record.workers, 0)
})
