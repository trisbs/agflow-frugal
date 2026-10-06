'use strict'

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const clone = value => JSON.parse(JSON.stringify(value))
const invalid = error => ({ valid: false, error })
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const definitions = Object.freeze({
	admission: { boolean: ['mechanical', 'simple', 'requirement_clear', 'scope_known', 'reversible', 'deterministic_verification'], arrays: ['risk_flags', 'missing_information'] },
	assessment: { boolean: ['material_uncertainty', 'substantial_mechanical_execution', 'high_consequence', 'difficult_rollback', 'material_disagreement', 'material_risk', 'deterministic_verification_sufficient'], arrays: ['risk_flags', 'missing_information'] },
	review: { boolean: ['material_risk', 'deterministic_verification_sufficient', 'reviewer_material_disagreement', 'viable_alternatives', 'meaningful_tradeoffs', 'substantial_consequence', 'cheap_resolution_exhausted'], scores: ['D', 'T', 'I', 'E', 'R'] },
})

const validate_source_identity = value => {
	if (!is_object(value) || Object.keys(value).some(key => !['source_kind', 'value'].includes(key)) || !text(value.source_kind) || !text(value.value)) return invalid('source_identity must contain only source_kind and value')
	if (value.source_kind === 'git' && !/^[0-9a-f]{40}$/u.test(value.value)) return invalid('git source identity must be 40 lowercase hexadecimal characters')
	if (value.source_kind === 'no-git' && !/^[0-9a-f]{64}$/u.test(value.value)) return invalid('no-git source identity must be 64 lowercase hexadecimal characters')
	if (!['git', 'no-git'].includes(value.source_kind)) return invalid('source_identity source_kind must be git or no-git')
	return { valid: true, value: { source_kind: value.source_kind, value: value.value } }
}

const validate_evidence = (value, known_facts) => {
	if (!Array.isArray(value)) return invalid('evidence must be an array')
	for (const item of value) {
		if (!is_object(item) || Object.keys(item).some(key => !['fact', 'source', 'observation'].includes(key)) || !text(item.fact) || !text(item.source) || !text(item.observation)) return invalid('each evidence item must contain only non-empty fact, source, and observation')
		if (!known_facts.includes(item.fact)) return invalid(`evidence fact ${item.fact} is not valid for this contract`)
	}
	return { valid: true, value: value.map(item => ({ fact: item.fact, source: item.source, observation: item.observation })) }
}

const validate = (kind, envelope, expected = {}) => {
	const definition = definitions[kind]
	if (!definition) return invalid(`unknown routing contract ${kind}`)
	if (!is_object(envelope)) return invalid(`${kind} envelope must be an object`)
	const envelope_fields = ['schema_version', 'task_id', 'source_identity', 'facts', 'evidence']
	if (Object.keys(envelope).some(key => !envelope_fields.includes(key))) return invalid(`${kind} envelope has unknown fields`)
	if (envelope.schema_version !== 1) return invalid(`${kind} schema_version must be 1`)
	if (!text(envelope.task_id)) return invalid(`${kind} task_id must be non-empty text`)
	if (text(expected.task_id) && envelope.task_id !== expected.task_id) return invalid(`${kind} task_id does not match the frozen stage`)
	const source = validate_source_identity(envelope.source_identity)
	if (!source.valid) return source
	if (expected.source_identity && (source.value.source_kind !== expected.source_identity.source_kind || source.value.value !== expected.source_identity.value)) return invalid(`${kind} source_identity does not match the frozen source`)
	if (kind === 'review' && expected.review_accepted !== true) return invalid('review facts require an accepted review record')
	if (!is_object(envelope.facts)) return invalid(`${kind} facts must be an object`)
	const known = [...definition.boolean, ...(definition.arrays || []), ...(definition.scores || [])]
	if (Object.keys(envelope.facts).length !== known.length || known.some(key => !has(envelope.facts, key)) || Object.keys(envelope.facts).some(key => !known.includes(key))) return invalid(`${kind} facts must contain exactly the documented fields`)
	for (const key of definition.boolean) if (typeof envelope.facts[key] !== 'boolean') return invalid(`${kind} ${key} must be a boolean`)
	for (const key of definition.arrays || []) if (!Array.isArray(envelope.facts[key]) || envelope.facts[key].some(item => !text(item))) return invalid(`${kind} ${key} must be an array of non-empty text`)
	for (const key of definition.scores || []) if (!Number.isInteger(envelope.facts[key]) || envelope.facts[key] < 0 || envelope.facts[key] > 2) return invalid(`${kind} ${key} must be an integer from 0 through 2`)
	if (kind === 'admission' && envelope.facts.mechanical && envelope.facts.simple) return invalid('admission mechanical and simple cannot both be true')
	if (kind === 'assessment' && envelope.facts.material_disagreement && !envelope.facts.high_consequence && !envelope.facts.difficult_rollback && envelope.facts.risk_flags.length === 0) return invalid('assessment material_disagreement requires a risk basis')
	if (kind === 'review' && envelope.facts.reviewer_material_disagreement && !envelope.facts.material_risk) return invalid('reviewer_material_disagreement requires material_risk')
	const evidence = validate_evidence(envelope.evidence, known)
	if (!evidence.valid) return evidence
	for (const key of known) {
		const positive = envelope.facts[key] === true || Number(envelope.facts[key]) > 0 || (Array.isArray(envelope.facts[key]) && envelope.facts[key].length > 0)
		if (positive && !evidence.value.some(item => item.fact === key)) return invalid(`${kind} ${key} requires evidence`)
	}
	return { valid: true, envelope: { schema_version: 1, task_id: envelope.task_id, source_identity: source.value, facts: clone(envelope.facts), evidence: evidence.value }, facts: clone(envelope.facts) }
}

const parse = (kind, value, expected) => {
	if (!text(value)) return invalid(`${kind} output must be non-empty JSON`)
	try { return validate(kind, JSON.parse(value), expected) } catch { return invalid(`${kind} output must be valid JSON without markdown or prose`) }
}

module.exports = {
	definitions,
	validate_source_identity,
	validate_admission: (envelope, expected) => validate('admission', envelope, expected),
	validate_assessment: (envelope, expected) => validate('assessment', envelope, expected),
	validate_review: (envelope, expected) => validate('review', envelope, expected),
	parse_admission: (value, expected) => parse('admission', value, expected),
	parse_assessment: (value, expected) => parse('assessment', value, expected),
	parse_review: (value, expected) => parse('review', value, expected),
}
