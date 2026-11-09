'use strict'

const coordinator = require('./routing-coordinator.js')
const failure_diagnostic = require('./routing-failure.js')

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

const attempt_for = (result, step) => {
	const attempts = result?.facts?.attempts_by_stage?.[step.stage]
	if (!Array.isArray(attempts)) return null
	if (Number.isInteger(step.attempt_index)) {
		const attempt = attempts[step.attempt_index]
		return attempt && (!step.candidate_id || attempt.candidate_id === step.candidate_id) ? attempt : null
	}
	return attempts.findLast(attempt => !step.candidate_id || attempt.candidate_id === step.candidate_id) || null
}

const is_basic_class = execution_class => ['L2', 'L3', 'L4', 'L5'].includes(execution_class)
const is_simple_class = execution_class => ['L0', 'L1'].includes(execution_class)

const route_evidence = (result, source_facts) => {
	const facts = result?.facts || source_facts
	if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return { facts: null, decision: null, execution_class: null, basic_assessment_accepted: false, basic_primary_started: false }
	let decision
	try { decision = coordinator.plan_next_action(facts) } catch { return { facts, decision: null, execution_class: null, basic_assessment_accepted: false, basic_primary_started: false } }
	const routing = decision?.routing
	const assessment = facts.records?.assessment
	let basic_assessment_accepted = false
	if (is_basic_class(routing?.execution_class) && decision.stage !== 'assessment' && assessment) {
		const assessment_plan = coordinator.plan_stage(facts, routing, 'assessment', assessment)
		basic_assessment_accepted = coordinator.accepted_record(assessment, coordinator.stage_task_id(facts.task.task_id, 'assessment'), { plan: assessment_plan, facts }) === null
	}
	const primary_attempt = attempt_for(result, { stage: 'primary' }) || facts.attempts_by_stage?.primary?.at(-1) || facts.records?.primary
	const direct_basic_route = ['L2', 'L3'].includes(routing?.execution_class) && decision.stage !== 'assessment'
	let basic_primary_started = false
	if (direct_basic_route && primary_attempt && ['external', 'internal'].includes(primary_attempt.kind)) {
		const primary_plan = coordinator.plan_stage(facts, routing, 'primary', primary_attempt)
		basic_primary_started = coordinator.validate_started_record(primary_attempt, coordinator.stage_task_id(facts.task.task_id, 'primary'), { plan: primary_plan, facts }) === null
	}
	const established_class = basic_assessment_accepted && is_basic_class(routing.execution_class)
		? routing.execution_class
		: basic_primary_started
			? routing.execution_class
		: is_simple_class(routing?.execution_class) && decision.stage !== 'assessment'
			? routing.execution_class
			: null
	return { facts, decision, execution_class: established_class, basic_assessment_accepted, basic_primary_started, direct_basic_route }
}

const basic_worker_started = (result, source_facts) => {
	const evidence = route_evidence(result, source_facts)
	return evidence.basic_assessment_accepted || evidence.basic_primary_started
}

const process_started = attempt => {
	if (!attempt) return 'false'
	const transport = attempt.transport || {}
	if (Number.isInteger(transport.process?.pid)) return 'true'
	if (typeof transport.process_started === 'boolean') return String(transport.process_started)
	if (typeof transport.worker_started === 'boolean') return String(transport.worker_started)
	return 'unknown'
}

const accepted = attempt => typeof attempt?.acceptance?.accepted === 'boolean' ? String(attempt.acceptance.accepted) : 'unknown'

const action_line = (step, attempt, mode, execution_class, task_basic_assessment_accepted, task_basic_primary_started, direct_basic_route) => {
	const dispatched = attempt?.dispatched || {}
	const action_kind = step.selection ? 'selected' : 'executor'
	const basic_class = is_basic_class(execution_class) || execution_class === 'unverified'
	const class_evidence = direct_basic_route ? task_basic_primary_started : task_basic_assessment_accepted
	const fields = [
		`[agf trace] ${safe_atom(step.stage)}`,
		`class=${basic_class && !class_evidence ? 'unverified' : safe_atom(execution_class)}`,
		...(basic_class ? [direct_basic_route ? `basic_primary_started=${task_basic_primary_started}` : `basic_assessment_accepted=${task_basic_assessment_accepted}`, ...(!class_evidence ? ['required_tier=basic'] : [])] : []),
		`tier=${safe_atom(step.tier)}`,
		`${action_kind}=${safe_atom(step.kind)}/${safe_atom(step.candidate_id)}`,
		`profile=${safe_atom(dispatched.profile || step.candidate_id)}`,
		`dispatch_model=${observed_atom(dispatched.model)}`,
		`dispatch_effort=${observed_atom(dispatched.effort)}`,
		`process_started=${process_started(attempt)}`,
		`accepted=${accepted(attempt)}`,
		`result=${safe_atom(attempt?.state, 'selected')}`,
	]
	if (failure_diagnostic.is_valid(attempt?.transport?.failure)) fields.push(`failure=${attempt.transport.failure.outcome}`, `clue=${attempt.transport.failure.clue}`)
	const exit = attempt?.transport?.process?.exit_code
	if (Number.isInteger(exit)) fields.push(`exit=${exit}`)
	if (mode === 'full') {
		fields.push(`observed_model=${observed_atom(attempt?.actual?.model)}`, `observed_effort=${observed_atom(attempt?.actual?.effort)}`)
		if (Number.isSafeInteger(attempt?.elapsed_ms) && attempt.elapsed_ms >= 0) fields.push(`elapsed_ms=${attempt.elapsed_ms}`)
	}
	return fields.join(' | ')
}

const format = (result, mode = 'summary', source_facts) => {
	if (!['summary', 'full'].includes(mode)) throw new Error('trace mode must be summary or full')
	if (!result || typeof result !== 'object' || Array.isArray(result)) return ['[agf trace] outcome=unknown']
	const lines = []
	const evidence = route_evidence(result, source_facts)
	const claimed_class = result.routing?.execution_class || result.plan?.routing?.execution_class || result.execution_class || result.steps?.find(step => step?.execution_class)?.execution_class || evidence.decision?.routing?.execution_class
	const execution_class = evidence.execution_class || (is_basic_class(claimed_class) || evidence.decision?.stage === 'assessment' ? 'unverified' : null)
	const task_basic_assessment_accepted = evidence.basic_assessment_accepted
	const task_basic_primary_started = evidence.basic_primary_started
	const direct_basic_route = evidence.direct_basic_route
	const rendered = new Set()
	const steps = Array.isArray(result.steps) ? result.steps.slice(0, 12) : []
	for (const step of steps) {
		if (!step || typeof step !== 'object' || typeof step.stage !== 'string') continue
		rendered.add(attempt_for(result, step))
		lines.push(action_line(step, attempt_for(result, step), mode, execution_class || 'unknown', task_basic_assessment_accepted, task_basic_primary_started, direct_basic_route))
	}
	const selected = result.status === 'selected' || result.selection ? result : result.plan
	if (selected && typeof selected.stage === 'string' && !steps.some(step => step?.stage === selected.stage)) {
		rendered.add(attempt_for(result, { stage: selected.stage, candidate_id: selected.selection?.candidate_id }))
		lines.push(action_line({
			stage: selected.stage,
			execution_class: selected.routing?.execution_class,
			tier: selected.tier,
			selection: selected.selection,
			kind: selected.selection?.kind,
			candidate_id: selected.selection?.candidate_id,
			}, attempt_for(result, { stage: selected.stage, candidate_id: selected.selection?.candidate_id }), mode, execution_class || 'unknown', task_basic_assessment_accepted, task_basic_primary_started, direct_basic_route))
	}
	for (const [stage, attempts] of Object.entries(result.facts?.attempts_by_stage || {})) {
		if (!Array.isArray(attempts)) continue
		for (const attempt of attempts.slice(0, 12)) {
			if (!attempt || rendered.has(attempt)) continue
			lines.push(action_line({ stage, tier: attempt.dispatched?.tier || attempt.requested?.tier, kind: attempt.kind, candidate_id: attempt.candidate_id }, attempt, mode, execution_class || 'unknown', task_basic_assessment_accepted, task_basic_primary_started, direct_basic_route))
		}
	}
	if (!['complete', 'selected'].includes(result.status) && typeof result.stage === 'string') {
		lines.push(`[agf trace] ${safe_atom(result.stage)} | status=${safe_atom(result.status)}`)
	}
	const outcome = result.status === 'complete' && evidence.decision?.status !== 'complete' ? 'unverified' : result.status
	lines.push(`[agf trace] outcome=${safe_atom(outcome)}`)
	return lines.slice(0, 14)
}

module.exports = { safe_atom, active_model, observed_atom, basic_worker_started, route_evidence, format }
