'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const contract = require('./routing-contract.js')

const source_identity = { source_kind: 'git', value: '0123456789abcdef0123456789abcdef01234567' }
const evidence = fact => [{ fact, source: 'src/a.js', observation: 'observed evidence' }]
const admission = () => ({ schema_version: 1, task_id: 'task-1', source_identity, facts: {
	mechanical: true, simple: false, requirement_clear: true, scope_known: true,
	reversible: true, deterministic_verification: true, risk_flags: [], missing_information: [],
}, evidence: [...evidence('mechanical'), ...evidence('requirement_clear'), ...evidence('scope_known'), ...evidence('reversible'), ...evidence('deterministic_verification')] })
const assessment = () => ({ schema_version: 1, task_id: 'task-1:assessment', source_identity, facts: {
	material_uncertainty: true, substantial_mechanical_execution: false, high_consequence: false,
	difficult_rollback: false, material_disagreement: false, material_risk: false,
	deterministic_verification_sufficient: true, risk_flags: [], missing_information: [],
}, evidence: [...evidence('material_uncertainty'), ...evidence('deterministic_verification_sufficient')] })
const review = () => ({ schema_version: 1, task_id: 'task-1:review', source_identity, facts: {
	material_risk: true, deterministic_verification_sufficient: false, reviewer_material_disagreement: true,
	D: 2, T: 2, I: 2, E: 1, R: 1, viable_alternatives: true, meaningful_tradeoffs: true,
	substantial_consequence: true, cheap_resolution_exhausted: true,
}, evidence: ['material_risk', 'reviewer_material_disagreement', 'D', 'T', 'I', 'E', 'R', 'viable_alternatives', 'meaningful_tradeoffs', 'substantial_consequence', 'cheap_resolution_exhausted'].flatMap(evidence) })

test('contracts validate canonical admission, assessment, and accepted review envelopes', () => {
	const expected = { task_id: 'task-1', source_identity }
	assert.equal(contract.validate_admission(admission(), expected).valid, true)
	assert.equal(contract.validate_assessment(assessment(), { ...expected, task_id: 'task-1:assessment' }).facts.material_uncertainty, true)
	assert.equal(contract.validate_review(review(), { ...expected, task_id: 'task-1:review', review_accepted: true }).facts.D, 2)
})

test('contracts reject unknown fields, missing evidence, identity mismatch, and premature review facts', () => {
	const unknown = admission(); unknown.extra = true
	assert.equal(contract.validate_admission(unknown, { task_id: 'task-1', source_identity }).valid, false)
	const unsupported = admission(); unsupported.evidence = unsupported.evidence.filter(item => item.fact !== 'mechanical')
	assert.match(contract.validate_admission(unsupported, { task_id: 'task-1', source_identity }).error, /mechanical requires evidence/)
	assert.match(contract.validate_assessment(assessment(), { task_id: 'other', source_identity }).error, /task_id/)
	assert.match(contract.validate_review(review(), { task_id: 'task-1:review', source_identity, review_accepted: false }).error, /accepted review/)
})

test('contracts reject contradictions and non-JSON worker output', () => {
	const contradictory = assessment(); contradictory.facts.material_disagreement = true
	assert.match(contract.validate_assessment(contradictory, { task_id: 'task-1:assessment', source_identity }).error, /risk basis/)
	assert.match(contract.parse_assessment('{"schema_version": 1}', { task_id: 'task-1:assessment', source_identity }).error, /task_id/)
	assert.match(contract.parse_assessment('```json\n{}\n```', { task_id: 'task-1:assessment', source_identity }).error, /valid JSON/)
})
