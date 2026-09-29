'use strict'

const EXECUTION_CLASSES = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
const PRESSURE_STATES = Object.freeze(['NORMAL', 'CAUTION', 'CONSERVE', 'STOP'])
const LIMITS = Object.freeze({
	external_workers: 1,
	delegation_depth: 1,
	parallel_workers: 0,
	independent_reviewers: 1,
	debate_perspectives: 2,
	debate_syntheses: 1,
	debate_retries: 0,
	retries_per_approach: 1,
	discovery_iterations: 2,
	expensive_calls: 2,
	backward_transitions: 1,
})

const invalid = error => ({ valid: false, error })
const nonnegative_integer = value => Number.isInteger(value) && value >= 0

const classify_task = facts => {
	if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return invalid('routing facts must be an object')
	if (facts.execution_class !== undefined) {
		if (!EXECUTION_CLASSES.includes(facts.execution_class)) return invalid(`execution_class must be one of: ${EXECUTION_CLASSES.join(', ')}`)
		return { valid: true, execution_class: facts.execution_class, basis: 'explicit structured metadata' }
	}

	for (const name of ['mechanical', 'simple', 'material_uncertainty', 'high_consequence', 'difficult_rollback', 'deterministic_verification', 'substantial_mechanical_execution', 'material_disagreement']) {
		if (facts[name] !== undefined && typeof facts[name] !== 'boolean') return invalid(`${name} must be a boolean when present`)
	}

	if (facts.high_consequence === true || facts.difficult_rollback === true) {
		return { valid: true, execution_class: facts.material_disagreement === true ? 'L5' : 'L4', basis: 'consequence or reversibility' }
	}
	if (facts.material_uncertainty === true) {
		return { valid: true, execution_class: facts.substantial_mechanical_execution === true ? 'L3' : 'L2', basis: 'material uncertainty' }
	}
	if (facts.mechanical === true && facts.deterministic_verification === true) return { valid: true, execution_class: 'L0', basis: 'mechanical with deterministic verification' }
	if (facts.simple === true && facts.deterministic_verification === true) return { valid: true, execution_class: 'L1', basis: 'simple with deterministic verification' }

	return { valid: true, execution_class: 'L2', basis: 'ambiguous facts use accuracy-preserving Medium Direct fallback' }
}

const budget_state = usage => {
	if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return invalid('usage must be an object')
	for (const name of Object.keys(LIMITS)) {
		const value = usage[name] ?? 0
		if (!nonnegative_integer(value)) return invalid(`${name} must be a non-negative integer`)
		if (value > LIMITS[name]) return { valid: true, pressure: 'STOP', stop_reason: `${name} exceeded ${LIMITS[name]}` }
	}
	if ((usage.external_workers ?? 0) === LIMITS.external_workers ||
		(usage.independent_reviewers ?? 0) === LIMITS.independent_reviewers ||
		(usage.expensive_calls ?? 0) === LIMITS.expensive_calls) return { valid: true, pressure: 'CONSERVE' }
	if ((usage.discovery_iterations ?? 0) === LIMITS.discovery_iterations ||
		(usage.retries_per_approach ?? 0) === LIMITS.retries_per_approach ||
		(usage.backward_transitions ?? 0) === LIMITS.backward_transitions) return { valid: true, pressure: 'CAUTION' }
	return { valid: true, pressure: 'NORMAL' }
}

const review_gate = facts => {
	if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return invalid('review facts must be an object')
	for (const name of ['material_risk', 'deterministic_verification_sufficient']) {
		if (typeof facts[name] !== 'boolean') return invalid(`${name} must be a boolean`)
	}
	return {
		valid: true,
		allowed: facts.material_risk && !facts.deterministic_verification_sufficient,
		reason: !facts.material_risk
			? 'no unresolved material risk'
			: facts.deterministic_verification_sufficient
				? 'deterministic verification resolves the risk'
				: 'material risk remains beyond deterministic verification',
	}
}

const debate_gate = facts => {
	if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return invalid('debate facts must be an object')
	const score_names = ['D', 'T', 'I', 'E', 'R']
	for (const name of score_names) if (!Number.isInteger(facts[name]) || facts[name] < 0 || facts[name] > 2) return invalid(`${name} must be an integer from 0 through 2`)
	const gate_names = ['viable_alternatives', 'meaningful_tradeoffs', 'substantial_consequence', 'cheap_resolution_exhausted', 'reviewer_material_disagreement']
	for (const name of gate_names) if (typeof facts[name] !== 'boolean') return invalid(`${name} must be a boolean`)
	const score = score_names.reduce((total, name) => total + facts[name], 0)
	const allowed = score >= 7 && gate_names.every(name => facts[name])
	return { valid: true, score, allowed, reason: allowed ? 'all L5 hard gates passed' : 'score or a required L5 hard gate did not pass' }
}

const route_task = (facts, usage = {}) => {
	const classification = classify_task(facts)
	if (!classification.valid) return classification
	const budget = budget_state(usage)
	if (!budget.valid) return budget
	if (budget.pressure === 'STOP') return { valid: true, ...classification, ...budget, route: 'STOP', review: false, debate: false }

	const execution_class = classification.execution_class
	const route = execution_class === 'L0' || execution_class === 'L1'
		? 'Light Direct'
		: execution_class === 'L3' && budget.pressure !== 'CONSERVE'
			? 'Medium → Terra'
			: 'Medium Direct'
	let review = false
	if ((execution_class === 'L4' || execution_class === 'L5') && facts.material_risk !== undefined) {
		const gate = review_gate(facts)
		if (!gate.valid) return gate
		review = gate.allowed && budget.pressure !== 'CONSERVE'
	}
	let debate = false
	let deliberation_score
	if (execution_class === 'L5' && facts.D !== undefined) {
		const gate = debate_gate(facts)
		if (!gate.valid) return gate
		debate = gate.allowed && review && budget.pressure === 'NORMAL'
		deliberation_score = gate.score
	}
	return { valid: true, ...classification, pressure: budget.pressure, route, review, debate, ...(deliberation_score === undefined ? {} : { deliberation_score }) }
}

const create_telemetry_record = facts => {
	if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return invalid('telemetry facts must be an object')
	for (const name of ['llm_calls', 'workers', 'reviews', 'debates', 'retries', 'tool_calls']) {
		if (!nonnegative_integer(facts[name])) return invalid(`${name} must be a non-negative integer`)
	}
	if (!EXECUTION_CLASSES.includes(facts.execution_class)) return invalid('telemetry execution_class is invalid')
	if (!PRESSURE_STATES.includes(facts.pressure)) return invalid('telemetry pressure is invalid')
	if (!['success', 'failure', 'stopped'].includes(facts.outcome)) return invalid('telemetry outcome must be success, failure, or stopped')
	const optional_count = name => nonnegative_integer(facts[name]) ? facts[name] : null
	return { valid: true, record: {
		version: 1,
		execution_class: facts.execution_class,
		execution_path: String(facts.execution_path || ''),
		model_effort: facts.model_effort == null ? null : String(facts.model_effort),
		llm_calls: facts.llm_calls,
		workers: facts.workers,
		reviews: facts.reviews,
		debates: facts.debates,
		retries: facts.retries,
		tool_calls: facts.tool_calls,
		input_tokens: optional_count('input_tokens'),
		output_tokens: optional_count('output_tokens'),
		elapsed_ms: optional_count('elapsed_ms'),
		outcome: facts.outcome,
		pressure: facts.pressure,
		budget_stop_reason: facts.budget_stop_reason == null ? null : String(facts.budget_stop_reason),
	} }
}

module.exports = { EXECUTION_CLASSES, PRESSURE_STATES, LIMITS, classify_task, budget_state, review_gate, debate_gate, route_task, create_telemetry_record }
