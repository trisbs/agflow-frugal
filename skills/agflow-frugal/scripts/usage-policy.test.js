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

test('L2 stays a single Basic primary while L3 requires a separate Basic review', () => {
	const reasoning = policy.route_task({ material_uncertainty: true })
	assert.equal(reasoning.execution_class, 'L2')
	assert.equal(reasoning.route, 'Basic Direct')
	assert.equal(reasoning.primary_tier, 'basic')
	assert.equal(reasoning.review, false)
	assert.equal(reasoning.secondary_tier, null)

	const substantial = policy.route_task({ material_uncertainty: true, substantial_mechanical_execution: true })
	assert.equal(substantial.execution_class, 'L3')
	assert.equal(substantial.route, 'Basic Direct')
	assert.equal(substantial.primary_tier, 'basic')
	assert.equal(substantial.review, true)
	assert.equal(substantial.secondary_tier, 'basic')
	const conserved = policy.route_task({ material_uncertainty: true, substantial_mechanical_execution: true }, { external_workers: 2 })
	assert.equal(conserved.pressure, 'CONSERVE')
	assert.equal(conserved.review, true)
	assert.equal(conserved.secondary_tier, 'basic')
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

const plan_evidence = (observation = 'The owner requests new task dependencies') => [{ source_kind: 'ask', source: 'Ask:1', observation }]
const plan_facts = () => ({
	material_uncertainty: true,
	task_plan: { value: true, changes: ['dependencies'], evidence: plan_evidence() },
	complexity_reasons: Object.fromEntries(['material_uncertainty', 'cross_subsystem_coordination', 'public_or_stored_data_contract', 'trust_boundary', 'unresolved_material_decision'].map(name => [name, { value: false, checked: true, evidence: plan_evidence('Targeted checks found no applicable complexity condition'), details: { reason: 'The owner already fixed this part of the plan' } }])),
})
const changing_unknown = () => ({ missing_fact: 'Whether the stored format has external readers', branches: [{ answer: 'External readers exist', plan_change: 'Add a migration compatibility phase' }, { answer: 'No external readers', plan_change: 'Replace the format directly' }] })

test('fixed facts independently specify every original class and immutable primary tier', () => {
	for (const [facts, expected_class, tier] of [
		[{ ...light_facts, mechanical: true }, 'L0', 'cheap'],
		[{ ...light_facts, simple: true }, 'L1', 'cheap'],
		[{ material_uncertainty: true }, 'L2', 'basic'],
		[{ material_uncertainty: true, substantial_mechanical_execution: true }, 'L3', 'basic'],
		[{ high_consequence: true }, 'L4', 'basic'],
		[{ high_consequence: true, material_disagreement: true }, 'L5', 'basic'],
	]) {
		assert.equal(policy.classify_task(facts).execution_class, expected_class)
		assert.equal(policy.route_task(facts).primary_tier, tier)
	}
})

test('a checked design-changing task-plan unknown establishes L5 without blocking classification', () => {
	const facts = plan_facts()
	facts.complexity_reasons.material_uncertainty = { value: 'unknown', checked: true, evidence: plan_evidence('Repository readers were checked but an external reader remains unconfirmed'), details: changing_unknown() }
	const result = policy.classify_escalated_task(facts)
	assert.equal(result.valid, true)
	assert.equal(result.execution_class, 'L5')
	assert.equal(policy.route_task(facts).primary_tier, 'basic')
	assert.equal(policy.classify_escalated_task(plan_facts()).execution_class, 'L2')
})

test('known or possible task plans escalate before an incomplete rubric can take Cheap Direct', () => {
	const facts = { ...light_facts, mechanical: true, task_plan: plan_facts().task_plan, complexity_reasons: {} }
	assert.equal(policy.admit_cheap(facts).execution_class, 'ESCALATE')
	assert.equal(policy.classify_escalated_task(facts).valid, false)
	facts.task_plan.value = 'unknown'
	assert.equal(policy.admit_cheap(facts).execution_class, 'ESCALATE')
	assert.equal(policy.classify_escalated_task(facts).valid, false)
})

const true_plan_details = {
	material_uncertainty: changing_unknown(),
	cross_subsystem_coordination: { responsibilities: ['producer service', 'consumer service'], producer: 'producer service', consumer: 'consumer service', output: 'accepted routing facts', shared_invariant: 'the source identity remains unchanged', joint_verification: 'check producer output against consumer acceptance' },
	public_or_stored_data_contract: { contract: 'stored routing evidence', before: 'records have no content digest', after: 'records carry a full content digest', compatibility: 'old evidence requires revalidation', verification: 'resume old and new record fixtures' },
	trust_boundary: { identity: 'review worker', operation: 'inspect source', input: 'frozen repository files', boundary: 'worker to source write authority', new_control: 'enforce read-only source access' },
	unresolved_material_decision: { alternatives: ['preserve old record format', 'require migrated records'], effect: 'the choice changes resume compatibility and verification' },
}

test('each evidenced task-plan complexity criterion independently establishes the L5 floor', () => {
	for (const [name, details] of Object.entries(true_plan_details)) {
		const facts = plan_facts()
		facts.complexity_reasons[name] = { value: true, checked: true, evidence: plan_evidence(), details }
		assert.equal(policy.classify_task(facts).execution_class, 'L5', name)
		assert.equal(policy.route_task(facts).route, 'Basic Coordinator', name)
		assert.equal(policy.admit_cheap(facts).floor_class, 'L5', name)
	}
})

test('a named checked unknown in any plan criterion is conservative L5; unchecked is invalid', () => {
	for (const name of Object.keys(true_plan_details)) {
		const facts = plan_facts()
		facts.complexity_reasons[name] = { value: 'unknown', checked: true, evidence: plan_evidence('Targeted inspection left this named design-changing question unresolved'), details: changing_unknown() }
		assert.equal(policy.classify_escalated_task(facts).execution_class, 'L5', name)
		facts.complexity_reasons[name].checked = false
		assert.equal(policy.classify_escalated_task(facts).valid, false, name)
		assert.equal(policy.admit_cheap(facts).execution_class, 'ESCALATE', name)
	}
})

test('plan exclusions do not invent complexity from file counts, settled choices, or formatting', () => {
	const ordinary = plan_facts()
	ordinary.complexity_reasons.cross_subsystem_coordination.details.reason = 'Three files implement one responsibility; there is no producer/consumer handoff'
	ordinary.complexity_reasons.public_or_stored_data_contract.details.reason = 'The existing interface is reused without semantic change'
	ordinary.complexity_reasons.unresolved_material_decision.details.reason = 'The owner already chose the implementation policy'
	assert.equal(policy.classify_escalated_task(ordinary).execution_class, 'L2')
	assert.equal(policy.classify_task({ ...ordinary, high_consequence: true }).execution_class, 'L4')
	const restatement = { ...light_facts, simple: true, task_plan: { value: false, changes: [], evidence: plan_evidence('The Ask only reformats the settled task list') }, complexity_reasons: {} }
	assert.equal(policy.admit_cheap(restatement).execution_class, 'L1')
	assert.equal(policy.classify_task({ ...light_facts, simple: true, title: 'task plan' }).execution_class, 'L1')
})

test('missing, untrusted, generic or contradictory plan evidence cannot establish classification', () => {
	const cases = [
		facts => { delete facts.complexity_reasons.trust_boundary },
		facts => { facts.task_plan.evidence = [] },
		facts => { facts.task_plan.changes = [] },
		facts => { facts.task_plan.value = 'true' },
		facts => { facts.complexity_reasons.material_uncertainty.evidence = [] },
		facts => { facts.complexity_reasons.material_uncertainty.evidence[0].source_kind = 'reviewer' },
		facts => { facts.complexity_reasons.material_uncertainty.evidence = [{ source_kind: 'repository', source: '../other-repository', observation: 'untrusted source' }] },
		facts => { facts.complexity_reasons.material_uncertainty = { value: 'unknown', checked: true, evidence: plan_evidence(), details: { missing_fact: 'something unknown', branches: [{ answer: 'one', plan_change: 'same plan' }, { answer: 'two', plan_change: 'same plan' }] } } },
		facts => { facts.complexity_reasons.cross_subsystem_coordination = { value: true, checked: true, evidence: plan_evidence(), details: { files: ['a.js', 'b.js'] } } },
		facts => { facts.complexity_reasons.public_or_stored_data_contract = { value: true, checked: true, evidence: plan_evidence(), details: { ...true_plan_details.public_or_stored_data_contract, after: true_plan_details.public_or_stored_data_contract.before } } },
	]
	for (const change of cases) {
		const facts = JSON.parse(JSON.stringify(plan_facts()))
		change(facts)
		assert.equal(policy.classify_escalated_task(facts).valid, false)
		assert.equal(policy.route_task(facts).valid, false)
	}
})

test('Better annotations cannot override authoritative fixed facts or the required primary tier', () => {
	const facts = plan_facts()
	facts.complexity_reasons.material_uncertainty = { value: 'unknown', checked: true, evidence: plan_evidence(), details: changing_unknown() }
	const original = JSON.parse(JSON.stringify(facts))
	const result = policy.route_task({ ...facts, final_class: 'L0', requested_tier: 'cheap', better_output: { facts: { task_plan: false }, execution_class: 'L0', primary_tier: 'cheap' } })
	assert.equal(result.execution_class, 'L5')
	assert.equal(result.primary_tier, 'basic')
	assert.deepEqual(facts, original)
})
