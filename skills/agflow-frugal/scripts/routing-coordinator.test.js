'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const coordinator = require('./routing-coordinator.js')

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
		},
	}],
}
const briefs = {
	assessment: { goal: 'Assess the escalated task and return structured routing facts without modifying files' },
	review: { goal: 'Review the accepted primary result' },
	'debate-a': { goal: 'Evaluate perspective A' },
	'debate-b': { goal: 'Evaluate perspective B' },
	synthesis: { goal: 'Synthesize accepted perspectives' },
}
const base = admission_facts => ({
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
const record = (stage, overrides = {}) => ({
	record_version: 1,
	task_id: `task-1:${stage}`,
	attempt_id: `attempt-${stage}`,
	candidate_id: 'codex-worker',
	kind: 'external',
	role: stage === 'assessment' ? 'explore' : stage === 'primary' ? 'implementation' : 'cross-check',
	source_identity,
	requested: {},
	actual: { model: 'gpt-worker', effort: 'medium' },
	state: 'completed',
	outputs: { result: 'accepted result' },
	changed_paths: [],
	acceptance: { checks_run: true, coordinator_inspected: true, accepted: true },
	limitations: [],
	transport: {
		runner_id: 'external-runner-v1',
		process: { exit_code: 0 },
	},
	...overrides,
})

test('L0 and L1 plan the configured cheap tier', () => {
	const result = coordinator.plan_next_action(base({
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

test('L2 and L3 plan the configured basic tier', () => {
	for (const substantial_mechanical_execution of [false, true]) {
		const facts = base({
			material_uncertainty: true,
			substantial_mechanical_execution,
		})
		const assessment = coordinator.plan_next_action(facts)
		assert.equal(assessment.stage, 'assessment')
		assert.equal(assessment.tier, 'basic')
		facts.records.assessment = record('assessment', {
			outputs: { routing_assessment: { material_uncertainty: true, substantial_mechanical_execution } },
		})
		const result = coordinator.plan_next_action(facts)
		assert.equal(result.stage, 'primary')
		assert.equal(result.status, 'selected')
		assert.equal(result.tier, 'basic')
		assert.equal(result.selection.actual.model, 'gpt-basic')
	}
})

test('assessment must be no-write and return structured routing facts', () => {
	const facts = base({ material_uncertainty: true })
	facts.records.assessment = record('assessment', { changed_paths: ['src/a.js'] })
	assert.match(coordinator.plan_next_action(facts).requirement, /must not modify files/)
	facts.records.assessment = record('assessment')
	assert.match(coordinator.plan_next_action(facts).requirement, /routing_assessment/)
})

test('L4 review waits for accepted primary evidence', () => {
	const facts = base({
		high_consequence: true,
		material_risk: true,
		deterministic_verification_sufficient: false,
	})
	facts.records.assessment = record('assessment', {
		outputs: { routing_assessment: { high_consequence: true, material_risk: true, deterministic_verification_sufficient: false } },
	})
	assert.equal(coordinator.plan_next_action(facts).stage, 'primary')
	facts.records.primary = record('primary', { state: 'task-failed', acceptance: { accepted: false }, outputs: {} })
	assert.equal(coordinator.plan_next_action(facts).status, 'unsatisfied')
	facts.records.primary = record('primary')
	const review = coordinator.plan_next_action(facts)
	assert.equal(review.stage, 'review')
	assert.equal(review.tier, 'better')
})

test('L5 requires review, two better perspectives, and basic synthesis', () => {
	const facts = base({
		high_consequence: true,
		material_disagreement: true,
	})
	facts.records.assessment = record('assessment', {
		outputs: { routing_assessment: { high_consequence: true, material_disagreement: true, material_risk: true, deterministic_verification_sufficient: false } },
	})
	facts.records.primary = record('primary')
	assert.equal(coordinator.plan_next_action(facts).stage, 'review')
	facts.records.review = record('review')
	facts.review_facts = {
		D: 2, T: 2, I: 2, E: 1, R: 1,
		viable_alternatives: true,
		meaningful_tradeoffs: true,
		substantial_consequence: true,
		cheap_resolution_exhausted: true,
		reviewer_material_disagreement: true,
	}
	assert.equal(coordinator.plan_next_action(facts).stage, 'debate-a')
	facts.records['debate-a'] = record('debate-a')
	assert.equal(coordinator.plan_next_action(facts).stage, 'debate-b')
	facts.records['debate-b'] = record('debate-b')
	const synthesis = coordinator.plan_next_action(facts)
	assert.equal(synthesis.stage, 'synthesis')
	assert.equal(synthesis.tier, 'basic')
	facts.records.synthesis = record('synthesis', { role: 'spec' })
	assert.equal(coordinator.plan_next_action(facts).status, 'complete')
})

test('usage pressure cannot complete work with an unresolved material-risk review', () => {
	for (const material_disagreement of [false, true]) {
		const assessment = { high_consequence: true, material_disagreement, material_risk: true, deterministic_verification_sufficient: false }
		const facts = base(assessment)
		facts.usage = { external_workers: 1 }
		facts.records.assessment = record('assessment', { outputs: { routing_assessment: assessment } })
		facts.records.primary = record('primary')
		const result = coordinator.plan_next_action(facts)
		assert.equal(result.status, 'stopped')
		assert.equal(result.routing.execution_class, material_disagreement ? 'L5' : 'L4')
		assert.match(result.requirement, /usage pressure prevents the required material-risk review/)
		facts.records.review = record('review', { acceptance: { checks_run: true, coordinator_inspected: true, accepted: false } })
		assert.equal(coordinator.plan_next_action(facts).status, 'unsatisfied')
		if (!material_disagreement) {
			facts.records.review = record('review')
			assert.equal(coordinator.plan_next_action(facts).status, 'complete')
		}
	}
})
