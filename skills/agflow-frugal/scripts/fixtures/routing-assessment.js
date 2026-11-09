'use strict'

const assessment_envelope = (facts, task_id, source_identity) => {
	const complete = { material_uncertainty: false, substantial_mechanical_execution: false, high_consequence: false, difficult_rollback: false, material_disagreement: false, material_risk: false, deterministic_verification_sufficient: false, risk_flags: [], missing_information: [], task_plan: { value: false, changes: [], evidence: [{ source_kind: 'ask', source: 'fixture Ask', observation: 'Execute the requested change without creating a plan' }] }, complexity_reasons: {}, ...facts }
	return { schema_version: 1, task_id, source_identity, facts: complete, evidence: Object.entries(complete).filter(([, value]) => value === true || Array.isArray(value) && value.length > 0).map(([fact]) => ({ fact, source: 'fixture Ask', observation: 'Fixed scenario establishes this fact' })) }
}
module.exports = { assessment_envelope }
