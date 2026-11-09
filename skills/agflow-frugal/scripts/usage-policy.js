'use strict'

const EXECUTION_CLASSES = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
const PRESSURE_STATES = Object.freeze(['NORMAL', 'CAUTION', 'CONSERVE', 'STOP'])
const LIMITS = Object.freeze({
	external_workers: 2,
	delegation_depth: 1,
	parallel_workers: 0,
	independent_reviewers: 2,
	debate_perspectives: 2,
	debate_syntheses: 1,
	debate_retries: 0,
	retries_per_approach: 1,
	discovery_iterations: 2,
	expensive_calls: 4,
	backward_transitions: 1,
})

const invalid = error => ({ valid: false, error })
const nonnegative_integer = value => Number.isInteger(value) && value >= 0
const text_array = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0)

const TASK_PLAN_CHANGES = Object.freeze(['work_sequence', 'dependencies', 'design_choices', 'acceptance_criteria'])
const TASK_PLAN_DETAILS = Object.freeze({
	material_uncertainty: ['missing_fact', 'branches'],
	cross_subsystem_coordination: ['responsibilities', 'producer', 'consumer', 'output', 'shared_invariant', 'joint_verification'],
	public_or_stored_data_contract: ['contract', 'before', 'after', 'compatibility', 'verification'],
	trust_boundary: ['identity', 'operation', 'input', 'boundary', 'new_control'],
	unresolved_material_decision: ['alternatives', 'effect'],
})
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const exact_keys = (value, keys) => is_object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const unique_text = (value, minimum) => text_array(value) && value.length >= minimum && new Set(value).size === value.length
const plan_evidence = value => Array.isArray(value) && value.length > 0 && value.every(item =>
	exact_keys(item, ['source_kind', 'source', 'observation']) && ['ask', 'repository'].includes(item.source_kind) && text(item.source) && text(item.observation) &&
	(item.source_kind !== 'repository' || !item.source.startsWith('/') && !item.source.includes('\\') && !item.source.includes('://') && !item.source.split('/').includes('..')))
const changing_branches = details => text(details.missing_fact) && Array.isArray(details.branches) && details.branches.length >= 2 && details.branches.every(branch => exact_keys(branch, ['answer', 'plan_change']) && text(branch.answer) && text(branch.plan_change)) && new Set(details.branches.map(branch => branch.answer)).size >= 2 && new Set(details.branches.map(branch => branch.plan_change)).size >= 2
const validate_task_plan = (facts, options = {}) => {
	if (!is_object(facts)) return invalid('task-plan facts must be an object')
	if (!Object.hasOwn(facts, 'task_plan') && !Object.hasOwn(facts, 'complexity_reasons')) return { valid: true, complete: true, floor: null }
	const plan = facts.task_plan
	if (!exact_keys(plan, ['value', 'changes', 'evidence']) || ![true, false, 'unknown'].includes(plan.value) || !unique_text(plan.changes, plan.value === true ? 1 : 0) || plan.changes.some(change => !TASK_PLAN_CHANGES.includes(change)) || !plan_evidence(plan.evidence) || !plan.evidence.some(item => item.source_kind === 'ask')) return invalid('task_plan must identify requested substantive changes and cite the Ask')
	if (plan.value === false && plan.changes.length > 0) return invalid('a non-plan cannot declare substantive plan changes')
	const reasons = facts.complexity_reasons
	if (!is_object(reasons) || Object.keys(reasons).some(name => !Object.hasOwn(TASK_PLAN_DETAILS, name))) return invalid('complexity_reasons must contain only the five documented task-plan criteria')
	if (plan.value === false) return Object.keys(reasons).length === 0 ? { valid: true, complete: true, floor: null, plan_status: false } : invalid('a non-plan must not assert task-plan complexity reasons')
	if (plan.value === 'unknown' && options.partial !== true) return invalid('task_plan intent requires directed Basic assessment')
	let complete = plan.value !== 'unknown'
	const triggering = []
	for (const [name, fields] of Object.entries(TASK_PLAN_DETAILS)) {
		const reason = reasons[name]
		if (reason === undefined && options.partial === true) { complete = false; continue }
		if (!exact_keys(reason, ['value', 'checked', 'evidence', 'details']) || ![true, false, 'unknown'].includes(reason.value) || typeof reason.checked !== 'boolean') return invalid(`task-plan ${name} requires true/false/unknown, checked status, evidence, and details`)
		if (!reason.checked && options.partial === true && reason.value === 'unknown') { complete = false; continue }
		if (!reason.checked || !plan_evidence(reason.evidence)) return invalid(`task-plan ${name} requires a completed targeted check and Ask/repository evidence`)
		const required = reason.value === false ? ['reason'] : reason.value === 'unknown' ? ['missing_fact', 'branches'] : fields
		if (!exact_keys(reason.details, required)) return invalid(`task-plan ${name} details do not match its rubric value`)
		const details = reason.details
		if (reason.value === false) {
			if (!text(details.reason)) return invalid(`task-plan ${name} false requires an evidence-based exclusion`)
			continue
		}
		if (reason.value === 'unknown' || name === 'material_uncertainty') {
			if (!changing_branches(details)) return invalid(`task-plan ${name} must name a missing fact and distinct answers that change the plan`)
		} else if (name === 'cross_subsystem_coordination') {
			if (!unique_text(details.responsibilities, 2) || !details.responsibilities.includes(details.producer) || !details.responsibilities.includes(details.consumer) || details.producer === details.consumer || !['output', 'shared_invariant', 'joint_verification'].every(key => text(details[key]))) return invalid('cross_subsystem_coordination requires different responsibilities, an output dependency, a shared invariant, and joint verification')
		} else if (name === 'unresolved_material_decision') {
			if (!unique_text(details.alternatives, 2) || !text(details.effect)) return invalid('unresolved_material_decision requires two viable alternatives and their effect on the plan')
		} else if (!fields.every(key => text(details[key])) || name === 'public_or_stored_data_contract' && details.before === details.after) return invalid(`task-plan ${name} must describe the concrete change required by its rubric`)
		triggering.push(name)
	}
	return { valid: true, complete, plan_status: plan.value, floor: plan.value === true && triggering.length > 0 ? 'L5' : null, triggering }
}

const classify_task = facts => {
	if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return invalid('routing facts must be an object')

	const boolean_fields = [
		'mechanical',
		'simple',
		'requirement_clear',
		'scope_known',
		'reversible',
		'material_uncertainty',
		'high_consequence',
		'difficult_rollback',
		'deterministic_verification',
		'substantial_mechanical_execution',
		'material_disagreement',
	]
	for (const name of boolean_fields) {
		if (facts[name] !== undefined && typeof facts[name] !== 'boolean') return invalid(`${name} must be a boolean when present`)
	}
	for (const name of ['risk_flags', 'missing_information']) {
		if (facts[name] !== undefined && !text_array(facts[name])) return invalid(`${name} must be an array of non-empty strings when present`)
	}
	if (facts.execution_class !== undefined && !EXECUTION_CLASSES.includes(facts.execution_class)) {
		return invalid(`execution_class must be one of: ${EXECUTION_CLASSES.join(', ')}`)
	}

	const plan = validate_task_plan(facts)
	if (!plan.valid) return plan
	const risk_flags = facts.risk_flags || []
	const missing_information = facts.missing_information || []
	let inferred_class
	let basis

	if (facts.high_consequence === true || facts.difficult_rollback === true || risk_flags.length > 0) {
		inferred_class = facts.material_disagreement === true ? 'L5' : 'L4'
		basis = risk_flags.length > 0 ? 'verified risk flags' : 'consequence or reversibility'
	} else if (facts.material_uncertainty === true) {
		inferred_class = facts.substantial_mechanical_execution === true ? 'L3' : 'L2'
		basis = 'material uncertainty'
	} else {
		const light_gate = facts.requirement_clear === true &&
			facts.scope_known === true &&
			facts.reversible === true &&
			facts.deterministic_verification === true &&
			missing_information.length === 0
		if (light_gate && facts.mechanical === true) {
			inferred_class = 'L0'
			basis = 'mechanical task passed every L0/L1 safety gate'
		} else if (light_gate && facts.simple === true) {
			inferred_class = 'L1'
			basis = 'simple task passed every L0/L1 safety gate'
		} else {
			inferred_class = 'L2'
			basis = missing_information.length > 0
				? 'missing information requires basic reasoning'
				: 'unproven L0/L1 safety conditions require basic reasoning'
		}
	}

	if (plan.floor === 'L5') { inferred_class = 'L5'; basis = `L5 task-plan floor: ${plan.triggering.join(', ')}` }
	if (facts.execution_class === undefined) return { valid: true, execution_class: inferred_class, basis }
	const explicit_index = EXECUTION_CLASSES.indexOf(facts.execution_class)
	const inferred_index = EXECUTION_CLASSES.indexOf(inferred_class)
	if (explicit_index >= inferred_index) {
		return { valid: true, execution_class: facts.execution_class, basis: 'explicit structured metadata raised or preserved the inferred class' }
	}
	return { valid: true, execution_class: inferred_class, basis: `explicit ${facts.execution_class} was raised by verified routing facts` }
}

const admit_cheap = (facts, options = {}) => {
	if (!is_object(facts)) return invalid('routing facts must be an object')
	const plan = validate_task_plan(facts, { partial: true })
	if (!plan.valid) return plan
	const { task_plan, complexity_reasons, ...ordinary_facts } = facts
	const classification = classify_task(plan.complete ? facts : ordinary_facts)
	if (!classification.valid) return classification
	const ordinary_class = classify_task(ordinary_facts).execution_class
	const non_plan_floor_class = ['L0', 'L1'].includes(ordinary_class) ? 'L2' : ordinary_class
	if (options.missing_plan_detection) return { valid: true, admitted: false, execution_class: 'ESCALATE', floor_class: non_plan_floor_class, non_plan_floor_class, plan_status: 'unknown', basis: 'frozen Ask may request a substantive plan; directed Basic detection is required' }
	if (!plan.complete || plan.floor === 'L5') return { valid: true, admitted: false, execution_class: 'ESCALATE', non_plan_floor_class, floor_class: plan.floor || (['L0', 'L1'].includes(classification.execution_class) ? 'L2' : classification.execution_class), plan_status: plan.plan_status, basis: 'task plan requires directed Basic assessment' }
	if (classification.execution_class === 'L0' || classification.execution_class === 'L1') {
		return { valid: true, admitted: true, execution_class: classification.execution_class, basis: classification.basis }
	}
	return {
		valid: true,
		admitted: false,
		execution_class: 'ESCALATE',
		floor_class: classification.execution_class,
		...(plan.plan_status !== undefined ? { plan_status: plan.plan_status } : {}),
		basis: classification.basis,
	}
}

const classify_escalated_task = facts => {
	const classification = classify_task(facts)
	if (!classification.valid) return classification
	if (classification.execution_class === 'L0' || classification.execution_class === 'L1') {
		return { valid: true, execution_class: 'L2', basis: 'cheap escalation establishes an L2 minimum' }
	}
	return classification
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
	const cheap_direct = execution_class === 'L0' || execution_class === 'L1'
	const route = cheap_direct
		? 'Cheap Direct'
		: execution_class === 'L5'
			? 'Basic Coordinator'
			: 'Basic Direct'
	const primary_tier = cheap_direct ? 'cheap' : 'basic'
	let review = execution_class === 'L3'
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
	return {
		valid: true,
		...classification,
		pressure: budget.pressure,
		route,
		primary_tier,
		secondary_tier: review ? (execution_class === 'L3' ? 'basic' : 'better') : null,
		review,
		debate,
		...(deliberation_score === undefined ? {} : { deliberation_score }),
	}
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

module.exports = { TASK_PLAN_CHANGES, TASK_PLAN_DETAILS, validate_task_plan, EXECUTION_CLASSES, PRESSURE_STATES, LIMITS, classify_task, admit_cheap, classify_escalated_task, budget_state, review_gate, debate_gate, route_task, create_telemetry_record }
