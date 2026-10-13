'use strict'

const looks_secret = value => /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|credential|bearer|authorization|private[-_]?key)/iu.test(value)

const active_model = value => typeof value === 'string'
	&& value.length <= 128
	&& /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
	&& !looks_secret(value)
	? value
	: 'unavailable'

const safe_atom = (value, fallback = 'unknown') => typeof value === 'string' && value.length > 0 && !looks_secret(value)
	? value.replace(/[^A-Za-z0-9._:/-]/gu, '_').slice(0, 48) || fallback
	: fallback

const observed_atom = value => typeof value === 'string' && !['inherited', 'unknown', 'unavailable'].includes(value.toLowerCase())
	? safe_atom(value)
	: 'unknown'

const attempt_for = (result, stage) => {
	const attempts = result?.facts?.attempts_by_stage?.[stage]
	return Array.isArray(attempts) ? attempts.at(-1) : null
}

const action_line = (step, attempt, mode) => {
	const actual = attempt?.actual || {}
	const action_kind = step.selection ? 'selected' : 'executor'
	const fields = [
		`[agf trace] ${safe_atom(step.stage)}`,
		`tier=${safe_atom(step.tier)}`,
		`${action_kind}=${safe_atom(step.kind)}/${safe_atom(step.candidate_id)}`,
		`model=${observed_atom(actual.model)}`,
		`effort=${observed_atom(actual.effort)}`,
	]
	if (mode === 'full') {
		const exit = attempt?.transport?.process?.exit_code
		fields.push(`state=${safe_atom(attempt?.state)}`)
		if (Number.isInteger(exit)) fields.push(`exit=${exit}`)
		if (Number.isSafeInteger(attempt?.elapsed_ms) && attempt.elapsed_ms >= 0) fields.push(`elapsed_ms=${attempt.elapsed_ms}`)
	}
	return fields.join(' | ').slice(0, 240)
}

const format = (result, mode = 'summary') => {
	if (!['summary', 'full'].includes(mode)) throw new Error('trace mode must be summary or full')
	if (!result || typeof result !== 'object' || Array.isArray(result)) return ['[agf trace] outcome=unknown']
	const lines = []
	const steps = Array.isArray(result.steps) ? result.steps.slice(0, 12) : []
	for (const step of steps) {
		if (!step || typeof step !== 'object' || typeof step.stage !== 'string') continue
		lines.push(action_line(step, attempt_for(result, step.stage), mode))
	}
	const selected = result.status === 'selected' || result.selection ? result : result.plan
	if (selected && typeof selected.stage === 'string' && !steps.some(step => step?.stage === selected.stage)) {
		lines.push(action_line({
			stage: selected.stage,
			tier: selected.tier,
			selection: selected.selection,
			kind: selected.selection?.kind,
			candidate_id: selected.selection?.candidate_id,
		}, null, mode))
	}
	if (!['complete', 'selected'].includes(result.status) && typeof result.stage === 'string') {
		lines.push(`[agf trace] ${safe_atom(result.stage)} | status=${safe_atom(result.status)}`)
	}
	lines.push(`[agf trace] outcome=${safe_atom(result.status)}`)
	return lines.slice(0, 14)
}

module.exports = { safe_atom, active_model, observed_atom, format }
