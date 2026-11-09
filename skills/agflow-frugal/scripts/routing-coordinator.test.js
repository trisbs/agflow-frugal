'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const coordinator = require('./routing-coordinator.js')
const { assessment_envelope } = require('./fixtures/routing-assessment.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const config = {
	switches: {
		'allowed-worker': ['external'],
		'review-policy': 'prefer-independent',
		'cli-provider': 'on',
	},
	'pipeline-roles': {
		implementation: 'basic',
		'cross-check': 'better',
		spec: 'better',
	},
}
const capabilities = {
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
			best: 'gpt-best/high',
		},
	}],
}
const briefs = {
	assessment: { goal: 'Assess the escalated task and return structured routing facts without modifying files' },
	review: { goal: 'Review the accepted primary result' },
	'plan-review': { goal: 'Review the Basic plan with supported findings' },
	resolution: { goal: 'Resolve each finding and provide the final plan' },
	'debate-a': { goal: 'Evaluate perspective A' },
	'debate-b': { goal: 'Evaluate perspective B' },
	synthesis: { goal: 'Synthesize accepted perspectives' },
}
const base = admission_facts => ({
	source_identity,
	admission_facts,
	config,
	policy: config.switches,
	host: { id: 'codex', family: 'codex' },
	capabilities,
	task: {
		task_id: 'task-1',
		role: 'implementation',
		brief: { goal: 'Execute the primary task' },
		work_boundary: ['src/a.js'],
		interactive_host: false,
	},
	briefs,
	records: {},
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
const record = (facts, stage, overrides = {}) => {
	if (overrides.outputs?.routing_assessment) overrides = { ...overrides, outputs: { routing_assessment_envelope: assessment_envelope(overrides.outputs.routing_assessment, 'task-1:assessment', source_identity) } }
	const assessed = facts.records.assessment?.outputs.routing_assessment_envelope?.facts
	const admitted = facts.admission_facts || facts.routing_facts
	const routed_facts = assessed || admitted
	const routing = routed_facts ? { ...require('./usage-policy.js').route_task(routed_facts, facts.usage), task_plan: routed_facts.task_plan?.value === true } : { primary_tier: 'basic' }
	const plan = coordinator.plan_stage(facts, routing, stage)
	const stage_number = ['assessment', 'primary', 'review', 'debate-a', 'debate-b', 'plan-review', 'resolution', 'synthesis'].indexOf(stage) + 1
	return ({
	record_version: 1,
	task_id: `task-1:${stage}`,
	attempt_id: `attempt-${stage}`,
	candidate_id: 'codex-worker',
	kind: 'external',
	role: plan.task.role,
	source_identity,
	requested: plan.selection.requested,
	stage_input_digest: plan.task.stage_input_digest,
	actual: plan.selection.actual,
	dispatched: { ...plan.selection.actual, stage, tier: plan.tier, profile: plan.selection.candidate_id, invocation_digest: stage_number.toString(16).padStart(64, '0'), provenance: 'configured-provider-invocation-v1' },
	state: 'completed',
	outputs: { result: 'accepted result' },
	changed_paths: [],
	acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
	limitations: [],
	transport: {
		read_only: plan.task.require_read_only === true,
		worker_started: true,
		runner_id: 'external-runner-v1',
		process: { pid: 12000 + stage_number, exit_code: 0 },
	},
	...overrides,
})
}
const native_record = (facts, stage, thread_handle, plan = coordinator.plan_stage(facts, { valid: true, execution_class: 'L3', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }, stage)) => {
	return {
		record_version: 1,
		task_id: `task-1:${stage}`,
		attempt_id: `attempt-${stage}`,
		candidate_id: plan.selection.candidate_id,
		kind: 'internal',
		role: plan.task.role,
		source_identity,
		requested: plan.selection.requested,
		actual: plan.selection.actual,
		stage_input_digest: plan.task.stage_input_digest,
		state: 'completed',
		outputs: { result: 'accepted result' },
		changed_paths: [],
		acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
		limitations: [],
		transport: { tool: 'spawn_agent', thread_handle, worker_started: true },
	}
}

test('L0 and L1 plan the configured cheap tier', () => {
	const result = coordinator.plan_next_action(base({
		task_plan: assessment_envelope({}, '', source_identity).facts.task_plan, complexity_reasons: {},
		mechanical: true,
		requirement_clear: true,
		scope_known: true,
		reversible: true,
		deterministic_verification: true,
		risk_flags: [],
		missing_information: [],
	}))
	assert.equal(result.status, 'selected')
	assert.equal(result.stage, 'primary')
	assert.equal(result.tier, 'cheap')
	assert.equal(result.selection.actual.model, 'gpt-cheap')
})

test('ordinary L2 skips assessment and L3 follows its Basic primary with an accepted Basic review', () => {
	for (const substantial_mechanical_execution of [false, true]) {
		const facts = base(complete_non_plan_admission({
			material_uncertainty: true,
			substantial_mechanical_execution,
		}))
		const primary = coordinator.plan_next_action(facts)
		assert.equal(primary.stage, 'primary')
		assert.equal(primary.status, 'selected')
		assert.equal(primary.tier, 'basic')
		assert.equal(primary.selection.actual.model, 'gpt-basic')
		facts.records.primary = record(facts, 'primary')
		const next = coordinator.plan_next_action(facts)
		if (substantial_mechanical_execution) {
			assert.equal(next.stage, 'review')
			assert.equal(next.status, 'selected')
			assert.equal(next.tier, 'basic')
			facts.records.review = record(facts, 'review', { state: 'task-failed', acceptance: { checks_run: true, coordinator_inspected: true, accepted: false } })
			assert.equal(coordinator.plan_next_action(facts).status, 'unsatisfied')
			facts.records.review = record(facts, 'review')
			assert.equal(coordinator.plan_next_action(facts).status, 'complete')
		} else {
			assert.equal(next.status, 'complete')
			assert.equal(facts.records.assessment, undefined)
		}
	}
})

test('incomplete non-plan admission retains the Basic assessment stage', () => {
	for (const admission_facts of [
		{ task_plan: assessment_envelope({}, '', source_identity).facts.task_plan, complexity_reasons: {}, material_uncertainty: true },
		complete_non_plan_admission({ material_uncertainty: true, missing_information: ['task outcome is unclear'] }),
	]) {
		const result = coordinator.plan_next_action(base(admission_facts))
		assert.equal(result.stage, 'assessment')
		assert.equal(result.tier, 'basic')
	}
})

test('L3 Basic review rejects reused execution evidence and accepts distinct executions on the same profile', () => {
	const facts = base(complete_non_plan_admission({
		material_uncertainty: true,
		substantial_mechanical_execution: true,
	}))
	const primary = record(facts, 'primary')
	facts.records.primary = primary
	const review_plan = coordinator.plan_next_action(facts)
	assert.equal(review_plan.stage, 'review')
	assert.equal(review_plan.tier, 'basic')

	const duplicate_invocation = record(facts, 'review')
	duplicate_invocation.dispatched.invocation_digest = primary.dispatched.invocation_digest
	facts.records.review = duplicate_invocation
	let result = coordinator.plan_next_action(facts)
	assert.equal(result.status, 'unsatisfied')
	assert.match(result.requirement, /distinct.*invocation/i)

	const duplicate_process = record(facts, 'review')
	duplicate_process.transport.process.pid = primary.transport.process.pid
	facts.records.review = duplicate_process
	result = coordinator.plan_next_action(facts)
	assert.equal(result.status, 'unsatisfied')
	assert.match(result.requirement, /distinct.*process/i)

	const distinct_review = record(facts, 'review')
	assert.equal(distinct_review.candidate_id, primary.candidate_id)
	assert.equal(distinct_review.actual.model, primary.actual.model)
	assert.equal(distinct_review.dispatched.profile, primary.dispatched.profile)
	assert.notEqual(distinct_review.dispatched.invocation_digest, primary.dispatched.invocation_digest)
	facts.records.review = distinct_review
	assert.equal(coordinator.plan_next_action(facts).status, 'complete')

	const native_facts = base(complete_non_plan_admission({
		material_uncertainty: true,
		substantial_mechanical_execution: true,
	}))
	native_facts.policy = { ...native_facts.policy, 'allowed-worker': ['internal'] }
	native_facts.capabilities = {
		internal: { candidate_id: 'native-worker', available: true, tiers: { basic: 'gpt-basic/medium' }, model: 'gpt-basic', effort: 'medium' },
	}
	const native_primary_plan = coordinator.plan_next_action(native_facts)
	assert.equal(native_primary_plan.stage, 'primary')
	const native_primary = native_record(native_facts, 'primary', 'shared-native-thread', native_primary_plan)
	native_facts.records.primary = native_primary
	let native_review_plan = coordinator.plan_next_action(native_facts)
	assert.equal(native_review_plan.stage, 'review')
	const duplicate_handle = native_record(native_facts, 'review', 'shared-native-thread', native_review_plan)
	native_facts.records.review = duplicate_handle
	result = coordinator.plan_next_action(native_facts)
	assert.equal(result.status, 'unsatisfied')
	assert.match(result.requirement, /distinct.*thread handle/i)

	delete native_facts.records.review
	native_review_plan = coordinator.plan_next_action(native_facts)
	const distinct_native_review = native_record(native_facts, 'review', 'separate-native-thread', native_review_plan)
	assert.equal(distinct_native_review.candidate_id, native_primary.candidate_id)
	assert.equal(distinct_native_review.actual.model, native_primary.actual.model)
	native_facts.records.review = distinct_native_review
	assert.equal(coordinator.plan_next_action(native_facts).status, 'complete')
})

test('assessment must be no-write and return structured routing facts', () => {
	const facts = base({ material_uncertainty: true })
	facts.records.assessment = record(facts, 'assessment', { changed_paths: ['src/a.js'] })
	assert.match(coordinator.plan_next_action(facts).requirement, /must not modify files/)
	facts.records.assessment = record(facts, 'assessment')
	assert.match(coordinator.plan_next_action(facts).requirement, /routing_assessment/)
})

test('L4 review waits for accepted primary evidence', () => {
	const facts = base({
		high_consequence: true,
		material_risk: true,
		deterministic_verification_sufficient: false,
	})
	facts.records.assessment = record(facts, 'assessment', {
		outputs: { routing_assessment: { high_consequence: true, material_risk: true, deterministic_verification_sufficient: false } },
	})
	assert.equal(coordinator.plan_next_action(facts).stage, 'primary')
	facts.records.primary = record(facts, 'primary', { state: 'task-failed', acceptance: { accepted: false }, outputs: {} })
	assert.equal(coordinator.plan_next_action(facts).status, 'unsatisfied')
	facts.records.primary = record(facts, 'primary')
	const review = coordinator.plan_next_action(facts)
	assert.equal(review.stage, 'review')
	assert.equal(review.tier, 'better')
})

test('gated L5 requires review, two Best perspectives, and Better synthesis', () => {
	const facts = base({
		high_consequence: true,
		material_disagreement: true,
	})
	facts.usage = { external_workers: 1, discovery_iterations: 1 }
	facts.records.assessment = record(facts, 'assessment', {
		outputs: { routing_assessment: { high_consequence: true, material_disagreement: true, material_risk: true, deterministic_verification_sufficient: false } },
	})
	facts.records.primary = record(facts, 'primary')
	const review = coordinator.plan_next_action(facts)
	assert.equal(review.stage, 'review')
	assert.equal(review.tier, 'better')
	facts.records.review = record(facts, 'review')
	facts.usage.independent_reviewers = 1
	facts.usage.expensive_calls = 1
	facts.review_facts = {
		D: 2, T: 2, I: 2, E: 1, R: 1,
		viable_alternatives: true,
		meaningful_tradeoffs: true,
		substantial_consequence: true,
		cheap_resolution_exhausted: true,
		reviewer_material_disagreement: true,
	}
	assert.equal(coordinator.plan_next_action(facts).stage, 'debate-a')
	assert.equal(coordinator.plan_next_action(facts).tier, 'best')
	facts.records['debate-a'] = record(facts, 'debate-a')
	facts.usage.debate_perspectives = 1
	facts.usage.expensive_calls = 2
	assert.equal(coordinator.plan_next_action(facts).stage, 'debate-b')
	assert.equal(coordinator.plan_next_action(facts).tier, 'best')
	facts.records['debate-b'] = record(facts, 'debate-b')
	facts.usage.debate_perspectives = 2
	facts.usage.expensive_calls = 3
	const synthesis = coordinator.plan_next_action(facts)
	assert.equal(synthesis.stage, 'synthesis')
	assert.equal(synthesis.tier, 'better')
	facts.records.synthesis = record(facts, 'synthesis', { role: 'spec' })
	assert.equal(coordinator.plan_next_action(facts).status, 'complete')
})

test('usage pressure cannot complete work with an unresolved material-risk review', () => {
	for (const material_disagreement of [false, true]) {
		const assessment = { high_consequence: true, material_disagreement, material_risk: true, deterministic_verification_sufficient: false }
		const facts = base(assessment)
		facts.usage = { expensive_calls: 4 }
		facts.records.assessment = record(facts, 'assessment', { outputs: { routing_assessment: assessment } })
		facts.records.primary = record(facts, 'primary')
		const result = coordinator.plan_next_action(facts)
		assert.equal(result.status, 'stopped')
		assert.equal(result.routing.execution_class, material_disagreement ? 'L5' : 'L4')
		assert.match(result.requirement, /usage pressure prevents the required material-risk review/)
		facts.records.review = record(facts, 'review', { acceptance: { checks_run: true, coordinator_inspected: true, accepted: false } })
		assert.equal(coordinator.plan_next_action(facts).status, 'unsatisfied')
		if (!material_disagreement) {
			facts.records.review = record(facts, 'review')
			assert.equal(coordinator.plan_next_action(facts).status, 'complete')
		}
	}
})

test('accepted stage evidence cannot survive a changed frozen brief', () => {
	const facts = base({ material_uncertainty: true })
	facts.records.assessment = record(facts, 'assessment', { outputs: { routing_assessment: { material_uncertainty: true } } })
	facts.records.primary = record(facts, 'primary')
	assert.equal(coordinator.plan_next_action(facts).status, 'complete')
	facts.task.brief = { goal: 'A different primary task' }
	const result = coordinator.plan_next_action(facts)
	assert.equal(result.status, 'unsatisfied')
	assert.match(result.requirement, /stage input/)
})

test('downstream input identity covers long output and keys omitted from public state', () => {
	const facts = base({ material_uncertainty: true })
	facts.records.primary = record(facts, 'primary', { outputs: { result: 'A'.repeat(5000), prompt: 'first private input' } })
	const first = coordinator.plan_stage(facts, { primary_tier: 'basic' }, 'review').task.stage_input_digest
	facts.records.primary.outputs.result = 'B'.repeat(5000)
	const second = coordinator.plan_stage(facts, { primary_tier: 'basic' }, 'review').task.stage_input_digest
	assert.notEqual(first, second)
	facts.records.primary.outputs.prompt = 'second private input'
	assert.notEqual(second, coordinator.plan_stage(facts, { primary_tier: 'basic' }, 'review').task.stage_input_digest)
})

test('changed long or removed-key output invalidates an accepted downstream review', () => {
	const routing = { valid: true, execution_class: 'L4', primary_tier: 'basic', pressure: 'NORMAL', review: true, debate: false }
	for (const changed of [{ result: 'B'.repeat(5000), prompt: 'first' }, { result: 'A'.repeat(5000), prompt: 'second' }]) {
		const facts = base({ material_uncertainty: true })
		facts.records.primary = record(facts, 'primary', { outputs: { result: 'A'.repeat(5000), prompt: 'first' } })
		facts.records.review = record(facts, 'review')
		assert.equal(coordinator.plan_class_action(facts, routing).status, 'complete')
		const saved = require('./routing-state.js').persistable_state(facts)
		assert.equal(coordinator.plan_class_action(saved, routing).status, 'complete')
		facts.records.primary.outputs = changed
		const result = coordinator.plan_class_action(facts, routing)
		assert.equal(result.status, 'unsatisfied')
		assert.match(result.requirement, /stage input/)
		delete saved.records.review
		assert.equal(coordinator.plan_class_action(saved, routing).status, 'awaiting-input')
	}
})

test('unchanged long frozen inputs remain accepted after persistence; dispatch requires original content', () => {
	const state = require('./routing-state.js')
	const facts = base({ material_uncertainty: true })
	facts.task.brief.goal = 'long goal '.repeat(600)
	facts.task.prompt = 'private frozen instruction'
	facts.records.primary = record(facts, 'primary')
	const routing = { valid: true, execution_class: 'L2', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }
	assert.equal(coordinator.plan_class_action(facts, routing).status, 'complete')
	const saved = state.persistable_state(facts)
	assert.equal(JSON.stringify(saved).includes('private frozen instruction'), false)
	assert.equal(coordinator.plan_class_action(saved, routing).status, 'complete')
	delete saved.records.primary
	assert.equal(coordinator.plan_class_action(saved, routing).status, 'awaiting-input')
	const reattached = state.reattach_inputs(saved, { task: facts.task })
	assert.equal(reattached.valid, true)
	reattached.facts.capabilities = facts.capabilities
	assert.equal(coordinator.plan_class_action(reattached.facts, routing).status, 'selected')
	assert.equal(state.reattach_inputs(saved, { task: { ...facts.task, prompt: 'changed' } }).valid, false)
})

const classified_plan_facts = () => ({
	material_uncertainty: true, substantial_mechanical_execution: false, high_consequence: false, difficult_rollback: false, material_disagreement: false, material_risk: false, deterministic_verification_sufficient: true, risk_flags: [], missing_information: [],
	task_plan: { value: true, changes: ['dependencies'], evidence: [{ source_kind: 'ask', source: 'Ask:1', observation: 'Create a new plan with changed dependencies' }] },
	complexity_reasons: Object.fromEntries(['material_uncertainty', 'cross_subsystem_coordination', 'public_or_stored_data_contract', 'trust_boundary', 'unresolved_material_decision'].map(name => [name, { value: false, checked: true, evidence: [{ source_kind: 'repository', source: 'src/a.js:1', observation: 'The named criterion was checked against source' }], details: { reason: 'This condition does not apply' } }])),
})
const plan_assessment_record = (facts, assessed) => record(facts, 'assessment', { outputs: { routing_assessment_envelope: { schema_version: 1, task_id: 'task-1:assessment', source_identity, facts: assessed, evidence: [{ fact: 'material_uncertainty', source: 'Ask:1', observation: 'The plan needs directed reasoning' }, { fact: 'deterministic_verification_sufficient', source: 'tests', observation: 'The fixed facts have deterministic checks' }] } } })

test('possible plan admission starts Basic assessment and accepted named unknown facts route as L5', () => {
	const assessed = classified_plan_facts()
	const facts = base({ mechanical: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true, task_plan: assessed.task_plan, complexity_reasons: {} })
	const before = coordinator.plan_next_action(facts)
	assert.equal(before.stage, 'assessment')
	assert.equal(before.tier, 'basic')
	assessed.complexity_reasons.material_uncertainty = { value: 'unknown', checked: true, evidence: [{ source_kind: 'repository', source: 'src/a.js:1', observation: 'Inspected known callers; external format readers remain unconfirmed' }], details: { missing_fact: 'Whether external format readers exist', branches: [{ answer: 'Readers exist', plan_change: 'Add a compatibility migration' }, { answer: 'No readers', plan_change: 'Replace the format directly' }] } }
	facts.records.assessment = plan_assessment_record(facts, assessed)
	const result = coordinator.plan_next_action(facts)
	assert.equal(result.status, 'selected', result.requirement)
	assert.equal(result.stage, 'primary')
	assert.equal(result.routing.execution_class, 'L5')
	assert.equal(result.tier, 'basic')
	assert.equal(result.selection.actual.model, 'gpt-basic')
})

test('assessment cannot omit or discard plan intent established by admission', () => {
	for (const omitted of [true, false]) {
		const assessed = classified_plan_facts()
		const facts = base({ material_uncertainty: true, task_plan: assessed.task_plan, complexity_reasons: {} })
		if (omitted) { delete assessed.task_plan; delete assessed.complexity_reasons }
		else { assessed.task_plan = { ...assessed.task_plan, value: false, changes: [] }; assessed.complexity_reasons = {} }
		facts.records.assessment = plan_assessment_record(facts, assessed)
		const result = coordinator.plan_next_action(facts)
		assert.equal(result.status, 'unsatisfied')
		assert.match(result.requirement, /plan rubric|task-plan intent/)
	}
})

test('Better output cannot replace accepted classification facts, plan rubric, class or tier', () => {
	const assessed = classified_plan_facts()
	assessed.high_consequence = true
	assessed.material_disagreement = true
	assessed.material_risk = true
	assessed.deterministic_verification_sufficient = false
	const facts = base({ high_consequence: true, material_disagreement: true })
	facts.records.assessment = record(facts, 'assessment', { outputs: { routing_assessment: assessed } })
	facts.records.primary = record(facts, 'primary')
	facts.records.review = record(facts, 'review')
	facts.review_facts = { reviewer_material_disagreement: false, execution_class: 'L0', tier: 'cheap', high_consequence: false, material_disagreement: false, material_risk: false, deterministic_verification_sufficient: true, task_plan: { value: false, changes: [], evidence: assessed.task_plan.evidence }, complexity_reasons: {} }
	const original = JSON.parse(JSON.stringify(assessed))
	const result = coordinator.plan_next_action(facts)
	assert.equal(result.stage, 'plan-review')
	assert.equal(result.routing.execution_class, 'L5')
	assert.equal(result.routing.primary_tier, 'basic')
	assert.equal(result.routing.review, true)
	assert.deepEqual(assessed, original)
})

test('bare empty and rubric-only assessments never bypass the typed accepted envelope', () => {
	for (const assessed of [{}, { task_plan: classified_plan_facts().task_plan, complexity_reasons: {} }]) {
		const facts = base({ material_uncertainty: true })
		facts.records.assessment = record(facts, 'assessment')
		facts.records.assessment.outputs = { routing_assessment: assessed }
		const result = coordinator.plan_next_action(facts)
		assert.equal(result.status, 'unsatisfied')
		assert.equal(result.stage, 'assessment')
		assert.match(result.requirement, /routing_assessment_envelope/)
	}
})

test('omitted or unknown plan detection escalates; evidenced explicit non-plan preserves Cheap', () => {
	const light = { mechanical: true, requirement_clear: true, scope_known: true, reversible: true, deterministic_verification: true, risk_flags: [], missing_information: [] }
	const facts = base(light)
	facts.task.brief.goal = 'Create a substantive work plan with new dependencies'
	assert.equal(coordinator.plan_next_action(facts).stage, 'assessment')
	facts.admission_facts = { ...light, task_plan: { ...classified_plan_facts().task_plan, value: 'unknown', changes: [] }, complexity_reasons: {} }
	assert.equal(coordinator.plan_next_action(facts).stage, 'assessment')
	facts.task.brief.goal = 'Reformat an existing settled task list'
	facts.admission_facts = { ...light, task_plan: assessment_envelope({}, '', source_identity).facts.task_plan, complexity_reasons: {} }
	assert.equal(coordinator.plan_next_action(facts).tier, 'cheap')
})

test('Basic complete exclusions supersede Cheap task-plan floor while Basic true or unknown retains L5', () => {
	for (const status of [false, true, 'unknown']) {
		const cheap = classified_plan_facts()
		cheap.complexity_reasons.material_uncertainty = { value: 'unknown', checked: true, evidence: cheap.task_plan.evidence, details: { missing_fact: 'Whether a migration is required', branches: [{ answer: 'Yes', plan_change: 'Migrate consumers' }, { answer: 'No', plan_change: 'Keep the current interface' }] } }
		const assessed = classified_plan_facts()
		if (status !== false) assessed.complexity_reasons.material_uncertainty = { ...cheap.complexity_reasons.material_uncertainty, value: status }
		const facts = base(cheap)
		facts.records.assessment = plan_assessment_record(facts, assessed)
		const result = coordinator.plan_next_action(facts)
		assert.equal(result.status, 'selected', result.requirement)
		assert.equal(result.routing.execution_class, status === false ? 'L2' : 'L5')
	}
})

const l5_plan = () => {
	const assessed = classified_plan_facts()
	assessed.complexity_reasons.material_uncertainty = { value: 'unknown', checked: true, evidence: assessed.task_plan.evidence, details: { missing_fact: 'External consumers', branches: [{ answer: 'Present', plan_change: 'Add migration' }, { answer: 'Absent', plan_change: 'Replace directly' }] } }
	const facts = base({ task_plan: assessed.task_plan, complexity_reasons: {} })
	facts.records.assessment = plan_assessment_record(facts, assessed)
	return facts
}
const supported_findings = [{ id: 'F1', requirement: 'Keep compatible readers', reproduction: 'Read the previous stored fixture', reasoning: 'The proposed replacement changes reader behavior', evidence: 'src/a.js:1' }]

test('L5 plan requires Basic plan, mandatory Better review, Basic resolution, and digest-bound owner Go/Stop', () => {
	const facts = l5_plan()
	assert.equal(coordinator.plan_next_action(facts).task.role, 'spec')
	facts.records.primary = record(facts, 'primary', { outputs: { result: 'Basic draft plan' } })
	const review = coordinator.plan_next_action(facts)
	assert.equal(review.stage, 'plan-review')
	assert.equal(review.tier, 'better')
	assert.equal(review.routing.review, false)
	facts.records['plan-review'] = record(facts, 'plan-review', { outputs: { result: { findings: supported_findings } } })
	const resolution = coordinator.plan_next_action(facts)
	assert.equal(resolution.stage, 'resolution')
	assert.equal(resolution.tier, 'basic')
	facts.records.resolution = record(facts, 'resolution', { outputs: { result: { plan: 'Final conditional migration plan', findings: [{ id: 'F1', disposition: 'accepted', reason: 'Add the compatible reader fixture' }] } } })
	const gate = coordinator.plan_next_action(facts)
	assert.equal(gate.status, 'awaiting-owner')
	facts.owner_design_decision = { task_id: facts.task.task_id, source_identity, resolution_digest: gate.resolution_digest, decision: 'Stop' }
	assert.equal(coordinator.plan_next_action(facts).status, 'stopped')
	facts.owner_design_decision.decision = 'Go'
	assert.equal(coordinator.plan_next_action(facts).status, 'complete')
	const saved = require('./routing-state.js').persistable_state(facts)
	assert.equal(coordinator.plan_next_action(saved).status, 'complete')
	facts.records.resolution.outputs.result.plan = 'Revised plan'
	assert.equal(coordinator.plan_next_action(facts).status, 'awaiting-owner')
	facts.records['plan-review'].outputs.result.findings[0].evidence = 'src/a.js:2'
	assert.match(coordinator.plan_next_action(facts).requirement, /stage input/)
})

test('unsupported plan findings and incomplete resolutions cannot reach owner gate', () => {
	const facts = l5_plan()
	facts.records.primary = record(facts, 'primary')
	facts.records['plan-review'] = record(facts, 'plan-review', { outputs: { result: { findings: [{ id: 'F1', requirement: 'Compatibility' }] } } })
	assert.match(coordinator.plan_next_action(facts).requirement, /each plan finding/)
	facts.records['plan-review'] = record(facts, 'plan-review', { outputs: { result: { findings: supported_findings } } })
	facts.records.resolution = record(facts, 'resolution', { outputs: { result: { plan: 'Final plan', findings: [] } } })
	assert.match(coordinator.plan_next_action(facts).requirement, /address every finding/)
})

test('plan lifecycle dispatches every mandatory tier and stops for owner without source writes', async () => {
	const facts = l5_plan()
	delete facts.records.assessment
	const assessed = l5_plan().records.assessment.outputs.routing_assessment_envelope.facts
	const stages = []
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, { external: async context => {
		stages.push([context.stage, context.tier])
		if (context.stage === 'assessment') return plan_assessment_record(context.facts, assessed)
		return record(context.facts, context.stage, { outputs: { result: context.stage === 'plan-review' ? { findings: [] } : context.stage === 'resolution' ? { plan: 'Final plan with conditional branches and acceptance criteria', findings: [] } : 'Basic plan' } })
	} })
	assert.equal(result.status, 'awaiting-owner', result.requirement)
	assert.deepEqual(stages, [['assessment', 'basic'], ['primary', 'basic'], ['plan-review', 'better'], ['resolution', 'basic']])
	assert.equal(result.facts.usage.expensive_calls, 1)
	assert.equal(result.facts.usage.independent_reviewers, 1)
})

test('L5 plan review supplies optional Debate gates without adding a second review or changing Debate rules', () => {
	const facts = l5_plan()
	const assessed = facts.records.assessment.outputs.routing_assessment_envelope.facts
	assessed.material_risk = true
	assessed.deterministic_verification_sufficient = false
	facts.records.assessment = plan_assessment_record(facts, assessed)
	facts.records.assessment.outputs.routing_assessment_envelope.evidence.push({ fact: 'material_risk', source: 'fixture Ask', observation: 'Risk remains beyond deterministic checking' })
	facts.records.primary = record(facts, 'primary')
	const review_facts = { material_risk: true, deterministic_verification_sufficient: false, reviewer_material_disagreement: true, viable_alternatives: true, meaningful_tradeoffs: true, substantial_consequence: true, cheap_resolution_exhausted: true, D: 2, T: 2, I: 2, E: 1, R: 1 }
	const review_envelope = { schema_version: 1, task_id: 'task-1:plan-review', source_identity, facts: review_facts, evidence: Object.keys(review_facts).filter(fact => review_facts[fact] === true || Number(review_facts[fact]) > 0).map(fact => ({ fact, source: 'fixture', observation: 'Fixed hard gate evidence' })) }
	facts.records['plan-review'] = record(facts, 'plan-review', { outputs: { result: { findings: [], review_envelope } } })
	facts.usage = { expensive_calls: 1, independent_reviewers: 1 }
	assert.equal(coordinator.plan_next_action(facts).stage, 'debate-a')
	facts.records['debate-a'] = record(facts, 'debate-a')
	assert.equal(coordinator.plan_next_action(facts).stage, 'debate-b')
	facts.records['debate-b'] = record(facts, 'debate-b')
	assert.equal(coordinator.plan_next_action(facts).stage, 'synthesis')
	facts.records.synthesis = record(facts, 'synthesis')
	assert.equal(coordinator.plan_next_action(facts).stage, 'resolution')
})

test('all optional Debate stages of an L5 plan require read-only dispatch and reject changed paths', () => {
	const facts = l5_plan()
	const routing = { valid: true, execution_class: 'L5', primary_tier: 'basic', task_plan: true }
	for (const stage of ['debate-a', 'debate-b', 'synthesis']) {
		const plan = coordinator.plan_stage(facts, routing, stage)
		assert.equal(plan.task.require_read_only, true, stage)
		assert.equal(plan.task.enforced_read_only, true, stage)
		const receipt = record(facts, stage, { changed_paths: ['src/a.js'] })
		assert.match(coordinator.accepted_record(receipt, receipt.task_id, { plan, facts }), /must not modify files/, stage)
	}
})

test('redacted long plan JSON requests verified reattachment instead of invalidating accepted evidence', () => {
	const state = require('./routing-state.js')
	for (const stage of ['plan-review', 'resolution']) {
		const facts = l5_plan()
		facts.records.primary = record(facts, 'primary')
		facts.records['plan-review'] = record(facts, 'plan-review', { outputs: { result: JSON.stringify({ findings: stage === 'plan-review' ? [{ ...supported_findings[0], evidence: 'Evidence '.repeat(900) }] : [] }) } })
		if (stage === 'resolution') facts.records.resolution = record(facts, 'resolution', { outputs: { result: JSON.stringify({ plan: 'Final conditional plan '.repeat(400), findings: [] }) } })
		assert.equal(coordinator.plan_next_action(facts).status, stage === 'resolution' ? 'awaiting-owner' : 'selected')
		const saved = state.persistable_state(facts)
		const pending = coordinator.plan_next_action(saved)
		assert.equal(pending.status, 'awaiting-input', pending.requirement)
		assert.equal(pending.stage, stage)
		assert.match(pending.requirement, /reattach/)
		assert.equal(state.reattach_inputs(saved, { records: { [stage]: { ...facts.records[stage], outputs: { result: 'different' } } } }).valid, false)
		const restored = state.reattach_inputs(saved, { records: { [stage]: facts.records[stage] } })
		assert.equal(restored.valid, true)
		restored.facts.capabilities = facts.capabilities
		assert.equal(coordinator.plan_next_action(restored.facts).status, stage === 'resolution' ? 'awaiting-owner' : 'selected')
		saved.records[stage].outputs.result = 'tampered projection'
		assert.equal(coordinator.plan_next_action(saved).status, 'unsatisfied')
	}
})

test('mandatory L5 plan review stops before dispatch when the existing Better call cap is exhausted', async () => {
	const facts = l5_plan()
	facts.records.primary = record(facts, 'primary')
	facts.usage = { expensive_calls: require('./usage-policy.js').LIMITS.expensive_calls }
	const calls = []
	const result = await require('./routing-lifecycle.js').run_lifecycle(facts, { external: async context => {
		calls.push(context.stage)
		throw new Error('exhausted review must never dispatch')
	} })
	assert.equal(result.status, 'stopped')
	assert.equal(result.stage, 'plan-review')
	assert.match(result.requirement, /expensive_calls budget would exceed 4/)
	assert.deepEqual(calls, [])
	assert.deepEqual(result.steps, [])
	assert.equal(result.plan.routing.execution_class, 'L5')
	assert.equal(result.plan.tier, 'better')
	assert.equal(result.facts.records['plan-review'], undefined)
	assert.equal(result.facts.records.resolution, undefined)
	assert.equal(result.facts.owner_design_decision, undefined)
	assert.equal(result.facts.usage.expensive_calls, 4)
})

test('the last available Better call reviews the L5 plan; CONSERVE suppresses optional Debate and preserves Basic resolution and owner gate', async () => {
	const facts = l5_plan()
	const assessed = facts.records.assessment.outputs.routing_assessment_envelope.facts
	assessed.material_risk = true
	assessed.deterministic_verification_sufficient = false
	facts.records.assessment = plan_assessment_record(facts, assessed)
	facts.records.assessment.outputs.routing_assessment_envelope.evidence.push({ fact: 'material_risk', source: 'fixture Ask', observation: 'Risk remains beyond deterministic checking' })
	facts.records.primary = record(facts, 'primary')
	facts.usage = { expensive_calls: require('./usage-policy.js').LIMITS.expensive_calls - 1 }
	const review_facts = { material_risk: true, deterministic_verification_sufficient: false, reviewer_material_disagreement: true, viable_alternatives: true, meaningful_tradeoffs: true, substantial_consequence: true, cheap_resolution_exhausted: true, D: 2, T: 2, I: 2, E: 1, R: 1 }
	assert.equal(require('./usage-policy.js').debate_gate(review_facts).allowed, true)
	const review_envelope = { schema_version: 1, task_id: 'task-1:plan-review', source_identity, facts: review_facts, evidence: Object.keys(review_facts).filter(fact => review_facts[fact] === true || Number(review_facts[fact]) > 0).map(fact => ({ fact, source: 'fixture', observation: 'Fixed hard gate evidence' })) }
	const calls = []
	const external = async context => {
		calls.push([context.stage, context.tier])
		assert.equal(context.routing.execution_class, 'L5')
		return record(context.facts, context.stage, { outputs: { result: context.stage === 'plan-review' ? { findings: [], review_envelope } : { plan: 'Final conditional plan with verification', findings: [] } } })
	}
	const reviewed = await require('./routing-lifecycle.js').run_lifecycle(facts, { external }, { max_actions: 1 })
	assert.equal(reviewed.status, 'action-limit')
	assert.equal(reviewed.stage, 'resolution')
	assert.equal(reviewed.plan.tier, 'basic')
	assert.equal(reviewed.plan.routing.execution_class, 'L5')
	assert.equal(reviewed.plan.routing.pressure, 'CONSERVE')
	assert.equal(reviewed.plan.routing.debate, false)
	assert.equal(reviewed.facts.usage.expensive_calls, 4)
	assert.equal(reviewed.facts.records.resolution, undefined)
	assert.equal(reviewed.facts.owner_design_decision, undefined)
	const resolved = await require('./routing-lifecycle.js').run_lifecycle(reviewed.facts, { external })
	assert.equal(resolved.status, 'awaiting-owner')
	assert.equal(resolved.stage, 'owner-design')
	assert.equal(resolved.routing.execution_class, 'L5')
	assert.equal(resolved.routing.primary_tier, 'basic')
	assert.deepEqual(calls, [['plan-review', 'better'], ['resolution', 'basic']])
	assert.equal(resolved.facts.usage.expensive_calls, 4)
	assert.equal(resolved.facts.records['debate-a'], undefined)
	assert.equal(resolved.facts.records['debate-b'], undefined)
	assert.equal(resolved.facts.records.synthesis, undefined)
})

test('direct accepted classes map primary and assessment tiers without invoking classification', () => {
	for (const execution_class of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
		const facts = base({})
		const primary_tier = ['L0', 'L1'].includes(execution_class) ? 'cheap' : 'basic'
		const routing = { valid: true, execution_class, primary_tier, pressure: 'NORMAL', review: false, debate: false }
		const planned = coordinator.plan_class_action(facts, routing)
		assert.equal(planned.status, 'selected', planned.requirement)
		assert.equal(planned.tier, primary_tier)
		assert.equal(planned.selection.actual.model, `gpt-${primary_tier}`)
		assert.equal(coordinator.plan_stage(facts, routing, 'assessment').tier, 'basic')
		if (primary_tier === 'basic') {
			facts.policy = { ...facts.policy, 'allowed-worker': ['external', 'host'] }
			facts.capabilities = { external: [{ ...capabilities.external[0], tiers: { cheap: 'gpt-cheap/low' } }], host: [{ candidate_id: 'host', available: true, model: 'gpt-basic', effort: 'medium' }] }
			assert.equal(coordinator.plan_class_action(facts, routing).status, 'unsatisfied')
		}
	}
})

test('persisted external completion without dispatch provenance remains unverified', () => {
	const fs = require('node:fs')
	const os = require('node:os')
	const path = require('node:path')
	const state = require('./routing-state.js')
	const facts = base({})
	const routing = { valid: true, execution_class: 'L3', primary_tier: 'basic', pressure: 'NORMAL', review: false, debate: false }
	facts.records.primary = record(facts, 'primary')
	delete facts.records.primary.dispatched
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-legacy-completion-'))
	state.save(workspace, facts.task.task_id, facts)
	const loaded = state.load(workspace, facts.task.task_id)
	const result = coordinator.plan_class_action(loaded.state, routing)
	assert.equal(result.status, 'unsatisfied')
	assert.match(result.requirement, /unverified.*dispatch receipt/)
})
