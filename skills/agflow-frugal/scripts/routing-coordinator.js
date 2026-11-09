'use strict'

const fs = require('node:fs')
const routing_state = require('./routing-state.js')
const path = require('node:path')
const usage_policy = require('./usage-policy.js')
const delegation_route = require('./delegation-route.js')
const routing_contract = require('./routing-contract.js')

const STAGES = Object.freeze({
	assessment: { tier: () => 'basic', role: 'explore', review: false },
	primary: { tier: routing => routing.primary_tier, role: 'implementation', review: false },
	review: { tier: routing => routing.execution_class === 'L3' ? 'basic' : 'better', role: 'cross-check', review: true },
	'debate-a': { tier: () => 'best', role: 'cross-check', review: true },
	'debate-b': { tier: () => 'best', role: 'cross-check', review: true },
	'plan-review': { tier: () => 'better', role: 'cross-check', review: true },
	resolution: { tier: () => 'basic', role: 'spec', review: false },
	synthesis: { tier: () => 'better', role: 'spec', review: false },
})

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty_text = value => typeof value === 'string' && value.trim().length > 0
const validate_started_record = (record, task_id, context = {}) => {
	const error = delegation_route.validate_execution_record(record, context.plan?.task || {})
	if (error) return error
	if (record.task_id !== task_id) return `execution record task_id must be ${task_id}`
	if (record.transport.worker_started !== true) return 'execution record must prove the worker started'
	if (context.plan) {
		const { plan, facts } = context
		if (plan.status !== 'selected') return `stage executor is no longer eligible: ${plan.selection?.requirement || plan.requirement}`
		if (record.requested.tier !== plan.tier) return `execution record requested tier must be ${plan.tier}`
		if (record.kind === 'external' && (!record.dispatched || !['configured-provider-invocation-v1', 'fixture-invocation-v1'].includes(record.dispatched.provenance))) return 'external completion is unverified: a provenance-backed dispatch receipt is required'
		const identity = record.kind === 'external' && record.dispatched ? record.dispatched : record.actual
		if (record.kind !== plan.selection.kind || record.candidate_id !== plan.selection.candidate_id || !identity || identity.model !== plan.selection.actual.model || identity.effort !== plan.selection.actual.effort) return `execution record dispatch identity does not satisfy selected ${plan.tier} tier`
		if (record.kind === 'external' && record.dispatched && (identity.stage !== plan.stage || identity.tier !== plan.tier || identity.profile !== plan.selection.candidate_id || !/^[a-f0-9]{64}$/u.test(identity.invocation_digest || ''))) return 'execution record dispatch receipt does not match the frozen stage'

		if (plan.task.require_read_only && record.changed_paths.length > 0) return 'plan and assessment stages must not modify files'
		if (record.role !== plan.task.role) return 'execution record role does not match the stage'
		if (!facts.source_identity || JSON.stringify(record.source_identity) !== JSON.stringify(facts.source_identity)) return 'execution record source identity does not match the frozen source'
		if (record.stage_input_digest !== plan.task.stage_input_digest) return 'execution record stage input is stale or missing'
	}
	return null
}

const accepted_record = (record, task_id, context = {}) => {
	const error = validate_started_record(record, task_id, context)
	if (error) return error
	if (record.state !== 'completed' || record.acceptance.accepted !== true) return 'execution record must be completed and accepted'
	if (context.plan) {
		const { plan, facts } = context
		if (plan.stage === 'review' && plan.routing?.execution_class === 'L3') {
			const primary = facts.records?.primary
			if (record.kind === 'external' && primary?.kind === 'external') {
				if (nonempty_text(record.dispatched?.invocation_digest) && record.dispatched.invocation_digest === primary.dispatched?.invocation_digest) return 'L3 review must use a distinct external invocation digest from primary'
				const review_pid = record.transport.process?.pid
				const primary_pid = primary.transport?.process?.pid
				if (Number.isInteger(review_pid) && Number.isInteger(primary_pid) && review_pid === primary_pid) return 'L3 review must use a distinct external process PID from primary'
			}
			if (record.kind === 'internal' && primary?.kind === 'internal') {
				const review_handle = record.transport.thread_handle || record.transport.thread_id || record.transport.handle
				const primary_handle = primary.transport?.thread_handle || primary.transport?.thread_id || primary.transport?.handle
				if (nonempty_text(review_handle) && review_handle === primary_handle) return 'L3 review must use a distinct native thread handle from primary'
			}
		}
	}
	return null
}

const complete_non_plan_admission = facts => {
	if (!is_object(facts)) return false
	const definition = routing_contract.definitions.admission
	if (!definition.boolean.every(name => typeof facts[name] === 'boolean')) return false
	if (!definition.arrays.every(name => Array.isArray(facts[name]) && facts[name].every(nonempty_text))) return false
	return facts.missing_information.length === 0
}

const stage_task_id = (base, stage) => `${base}:${stage}`
const higher_class = (left, right) => usage_policy.EXECUTION_CLASSES[
	Math.max(usage_policy.EXECUTION_CLASSES.indexOf(left), usage_policy.EXECUTION_CLASSES.indexOf(right))
]

const assessment_routing = (admission, assessment, usage = {}) => {
	if ([true, 'unknown'].includes(admission.plan_status) && !is_object(assessment?.task_plan)) return { valid: false, error: 'task-plan admission requires a complete accepted plan rubric' }
	if (admission.plan_status === true && assessment?.task_plan?.value !== true) return { valid: false, error: 'assessment cannot discard the task-plan intent established by the frozen Ask' }
	const classification = usage_policy.classify_escalated_task(assessment)
	if (!classification.valid) return classification
	const execution_class = higher_class(admission.non_plan_floor_class || admission.floor_class, classification.execution_class)
	return { ...usage_policy.route_task({ ...assessment, execution_class }, usage), task_plan: assessment.task_plan?.value === true }
}

const plan_stage = (facts, routing, stage, record) => {
	const definition = STAGES[stage]
	const base_task = facts.task
	const brief = stage === 'primary'
		? base_task.brief || base_task.frozen_brief
		: facts.briefs?.[stage]
	if (!is_object(brief) && !nonempty_text(brief)) {
		return { status: 'unsatisfied', stage, routing, requirement: `a frozen ${stage} brief is required` }
	}
	const executor_choice = facts.executor_choices?.[stage]
	const task = {
		...base_task,
		task_id: stage_task_id(base_task.task_id, stage),
		role: stage === 'primary' && routing.execution_class === 'L5' && routing.task_plan ? 'spec' : definition.role,
		review: definition.review,
		requested_tier: definition.tier(routing),
		brief,
		...(stage === 'assessment' || ['plan-review', 'resolution'].includes(stage) || routing.execution_class === 'L5' && routing.task_plan ? { require_read_only: true, enforced_read_only: true } : {}),
		...(executor_choice ? { executor_choice } : {}),
	}
	delete task.tier
	const dependencies = { assessment: [], primary: ['assessment'], review: ['primary'], 'debate-a': ['review', 'plan-review'], 'debate-b': ['review', 'plan-review'], synthesis: ['debate-a', 'debate-b'], 'plan-review': ['assessment', 'primary'], resolution: ['assessment', 'primary', 'plan-review', 'review', 'debate-a', 'debate-b', 'synthesis'] }[stage]
	const task_input = routing_state.frozen_input(facts, 'task')
	const brief_input = stage === 'primary' ? task_input : routing_state.frozen_input(facts, 'briefs', stage)
	if (!task_input.valid || !brief_input.valid) return { status: 'unsatisfied', stage, routing, requirement: task_input.error || brief_input.error }
	if (!record && (!task_input.complete || !brief_input.complete)) return { status: 'awaiting-input', stage, routing, requirement: `reattach the original frozen task and ${stage} brief before dispatch; saved input was redacted` }
	if (!record && dependencies.some(name => facts.records?.[name]?.content_projection === true && facts.records[name].content_identity?.full_digest !== facts.records[name].content_identity?.projection_digest)) return { status: 'awaiting-input', stage, routing, requirement: `reattach the original accepted upstream output before ${stage} dispatch; saved output was redacted` }
	try {
		task.stage_input_digest = routing_state.content_digest({ task_digest: task_input.identity.full_digest, brief_digest: brief_input.identity.full_digest, stage, role: task.role, tier: task.requested_tier, source_identity: facts.source_identity, inputs: dependencies.map(name => facts.records?.[name] ? routing_state.record_digest(facts.records[name]) : null) })
	} catch (error) { return { status: 'unsatisfied', stage, routing, requirement: error.message } }

	const selection = record ? delegation_route.select_recorded_executor(facts, task, record) : delegation_route.select_executor_action({
		...facts,
		task,
		attempts: facts.attempts_by_stage?.[stage] || [],
	})
	return {
		status: selection.status,
		stage,
		tier: task.requested_tier,
		routing,
		task,
		selection,
	}
}

const require_record = (facts, routing, stage) => {
	const task_id = stage_task_id(facts.task.task_id, stage)
	const record = facts.records?.[stage]
	if (!record) return { missing: true, task_id }
	try { routing_state.record_digest(record) } catch (error) { return { error: error.message, task_id } }
	const plan = plan_stage(facts, routing, stage, record)
	const error = accepted_record(record, task_id, { plan, facts })
	return error ? { error, task_id } : { record, task_id }
}

const plan_next_action = facts => {
	if (!is_object(facts) || !is_object(facts.task) || !nonempty_text(facts.task.task_id)) {
		return { status: 'unsatisfied', requirement: 'routing coordinator requires a task with a stable task_id' }
	}
	let admission_facts = facts.admission_facts || facts.routing_facts
	if (facts.admission_envelope !== undefined) {
		const contract = routing_contract.validate_admission(facts.admission_envelope, { task_id: facts.task.task_id, source_identity: facts.source_identity })
		if (!contract.valid) return { status: 'unsatisfied', requirement: contract.error }
		admission_facts = contract.facts
	}
	const missing_plan_detection = !Object.hasOwn(admission_facts || {}, 'task_plan')
	const admission = usage_policy.admit_cheap(admission_facts, { missing_plan_detection })
	if (!admission.valid) return { status: 'unsatisfied', requirement: admission.error, routing: admission }
	if (admission.admitted) {
		const routing = usage_policy.route_task(admission_facts, facts.usage)
		if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
		if (routing.route === 'STOP') return { status: 'stopped', routing, requirement: routing.stop_reason }
		const primary = require_record(facts, routing, 'primary')
		if (primary.missing) return plan_stage(facts, routing, 'primary')
		if (primary.error) return { status: 'unsatisfied', stage: 'primary', routing, requirement: primary.error }
		return { status: 'complete', routing }
	}
	if (admission.plan_status === false && ['L2', 'L3'].includes(admission.floor_class) && complete_non_plan_admission(admission_facts)) {
		const routing = usage_policy.route_task({ ...admission_facts, execution_class: admission.floor_class }, facts.usage)
		if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
		if (routing.route === 'STOP') return { status: 'stopped', routing, requirement: routing.stop_reason }
		return plan_class_action(facts, routing, admission_facts)
	}

	const { task_plan, complexity_reasons, ...preliminary_facts } = admission_facts
	const preliminary_routing = usage_policy.route_task({ ...preliminary_facts, execution_class: admission.floor_class }, facts.usage)
	if (!preliminary_routing.valid) return { status: 'unsatisfied', requirement: preliminary_routing.error, routing: preliminary_routing }
	if (preliminary_routing.route === 'STOP') return { status: 'stopped', routing: preliminary_routing, requirement: preliminary_routing.stop_reason }
	const assessment = require_record(facts, preliminary_routing, 'assessment')
	if (assessment.missing) return plan_stage(facts, preliminary_routing, 'assessment')
	if (assessment.error) return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: assessment.error }
	if (assessment.record.changed_paths.length > 0) {
		return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: 'assessment must not modify files' }
	}
	const contract = routing_contract.validate_assessment(assessment.record.outputs.routing_assessment_envelope, { task_id: assessment.task_id, source_identity: facts.source_identity })
	if (!contract.valid) return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: `assessment requires outputs.routing_assessment_envelope: ${contract.error}` }
	const routing_assessment = contract.facts
	let routing = assessment_routing(admission, routing_assessment, facts.usage)
	if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
	if (routing.route === 'STOP') return { status: 'stopped', routing, requirement: routing.stop_reason }

	return plan_class_action(facts, routing, routing_assessment)
}

const plan_class_action = (facts, initial_routing, routing_assessment = {}) => {
	let routing = initial_routing
	if (!is_object(routing) || routing.valid !== true || !usage_policy.EXECUTION_CLASSES.includes(routing.execution_class) || routing.primary_tier !== (['L0', 'L1'].includes(routing.execution_class) ? 'cheap' : 'basic')) return { status: 'unsatisfied', requirement: 'validated class and matching primary tier are required' }
	if (routing.route === 'STOP') return { status: 'stopped', routing, requirement: routing.stop_reason }
	if (routing.execution_class === 'L3') routing = { ...routing, review: true, secondary_tier: 'basic' }

	const primary = require_record(facts, routing, 'primary')
	if (primary.missing) return plan_stage(facts, routing, 'primary')
	if (primary.error) return { status: 'unsatisfied', stage: 'primary', routing, requirement: primary.error }

	const plan_l5 = routing.execution_class === 'L5' && routing_assessment.task_plan?.value === true
	if (plan_l5) {
		const reviewed = require_record(facts, routing, 'plan-review')
		if (reviewed.missing) return plan_stage(facts, routing, 'plan-review')
		if (reviewed.error) return { status: 'unsatisfied', stage: 'plan-review', routing, requirement: reviewed.error }
		const pending = projected_plan_input(reviewed.record, routing, 'plan-review')
		if (pending) return pending
		const error = validate_plan_review(stage_result(reviewed.record))
		if (error) return { status: 'unsatisfied', stage: 'plan-review', routing, requirement: error }
	}
	const review_stage = plan_l5 ? 'plan-review' : 'review'
	const finish = () => plan_l5 ? plan_owner_action(facts, routing) : { status: 'complete', routing }

	if (routing.pressure === 'CONSERVE' &&
		['L4', 'L5'].includes(routing.execution_class) &&
		routing_assessment.material_risk === true &&
		routing_assessment.deterministic_verification_sufficient === false) {
		const review = require_record(facts, routing, review_stage)
		if (review.missing) return {
			status: 'stopped',
			routing,
			requirement: 'usage pressure prevents the required material-risk review',
		}
		if (review.error) return { status: 'unsatisfied', stage: 'review', routing, requirement: review.error }
	}

	if (routing.execution_class === 'L5' && !routing.review && !plan_l5) {
		return {
			status: 'awaiting-routing-facts',
			routing,
			requirement: 'L5 requires explicit material-risk and deterministic-verification facts before review',
		}
	}

	if (routing.review) {
		const review = require_record(facts, routing, review_stage)
		if (review.missing) return plan_stage(facts, routing, review_stage)
		if (review.error) return { status: 'unsatisfied', stage: 'review', routing, requirement: review.error }
	}

	if (routing.execution_class !== 'L5') return finish()
	if (plan_l5 && !routing.review) return finish()
	let review_facts = plan_l5 ? undefined : facts.review_facts
	const review_envelope = plan_l5 ? stage_result(facts.records['plan-review'])?.review_envelope : facts.records.review?.outputs?.review_envelope
	if (review_envelope !== undefined) {
		const contract = routing_contract.validate_review(review_envelope, { task_id: stage_task_id(facts.task.task_id, review_stage), source_identity: facts.source_identity, review_accepted: true })
		if (!contract.valid) return { status: 'unsatisfied', stage: 'review', routing, requirement: contract.error }
		review_facts = contract.facts
	}
	if (!is_object(review_facts)) {
		return {
			status: 'awaiting-routing-facts',
			routing,
			requirement: 'L5 requires structured review_facts from the accepted reviewer result',
		}
	}
	const debate_fields = [...routing_contract.definitions.review.scores, ...routing_contract.definitions.review.boolean.filter(name => !['material_risk', 'deterministic_verification_sufficient'].includes(name))]
	const debate_facts = Object.fromEntries(debate_fields.filter(name => Object.hasOwn(review_facts, name)).map(name => [name, review_facts[name]]))
	routing = { ...usage_policy.route_task({ ...routing_assessment, ...debate_facts, execution_class: routing.execution_class }, facts.usage), ...(plan_l5 ? { task_plan: true } : {}) }
	if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
	if (review_facts.reviewer_material_disagreement === false) return finish()
	if (review_facts.reviewer_material_disagreement !== true) {
		return {
			status: 'awaiting-routing-facts',
			routing,
			requirement: 'L5 requires the accepted reviewer result to state whether material disagreement remains',
		}
	}
	if (review_facts.D === undefined) {
		return {
			status: 'awaiting-routing-facts',
			routing,
			requirement: 'L5 disagreement requires complete Debate gate facts before perspectives start',
		}
	}
	if (!routing.debate) return finish()

	for (const stage of ['debate-a', 'debate-b', 'synthesis']) {
		const record = require_record(facts, routing, stage)
		if (record.missing) return plan_stage(facts, routing, stage)
		if (record.error) return { status: 'unsatisfied', stage, routing, requirement: record.error }
	}
	return finish()
}

const projected_plan_input = (record, routing, stage) => record.content_projection === true && record.content_identity.full_digest !== record.content_identity.projection_digest
	? { status: 'awaiting-input', stage, routing, requirement: `reattach the original accepted ${stage} output for content validation; saved output was redacted` }
	: null

const stage_result = record => {
	try { return typeof record.outputs.result === 'string' ? JSON.parse(record.outputs.result) : record.outputs.result } catch { return null }
}
const validate_plan_review = result => {
	if (!is_object(result) || !Array.isArray(result.findings)) return 'plan review requires structured findings'
	const ids = new Set()
	for (const finding of result.findings) {
		if (!is_object(finding) || !['id', 'requirement', 'reproduction', 'reasoning', 'evidence'].every(key => nonempty_text(finding[key])) || ids.has(finding.id)) return 'each plan finding requires a unique id, requirement, reproduction, reasoning and evidence'
		ids.add(finding.id)
	}
	return null
}
const plan_owner_action = (facts, routing) => {
	const resolution = require_record(facts, routing, 'resolution')
	if (resolution.missing) return plan_stage(facts, routing, 'resolution')
	if (resolution.error) return { status: 'unsatisfied', stage: 'resolution', routing, requirement: resolution.error }
	const pending = projected_plan_input(resolution.record, routing, 'resolution')
	if (pending) return pending
	const result = stage_result(resolution.record)
	const findings = stage_result(facts.records['plan-review']).findings
	if (!is_object(result) || !nonempty_text(result.plan) || !Array.isArray(result.findings) || result.findings.length !== findings.length || new Set(result.findings.map(item => item?.id)).size !== findings.length || result.findings.some(item => !is_object(item) || !findings.some(finding => finding.id === item.id) || !['accepted', 'rejected', 'unresolved'].includes(item.disposition) || !nonempty_text(item.reason))) return { status: 'unsatisfied', stage: 'resolution', routing, requirement: 'resolution must supply the final plan and address every finding with a disposition and reason' }
	const resolution_digest = routing_state.record_digest(resolution.record)
	const decision = facts.owner_design_decision
	if (!is_object(decision) || decision.task_id !== facts.task.task_id || JSON.stringify(decision.source_identity) !== JSON.stringify(facts.source_identity) || decision.resolution_digest !== resolution_digest || !['Go', 'Stop'].includes(decision.decision)) return { status: 'awaiting-owner', stage: 'owner-design', routing, resolution_digest, requirement: 'owner Design Go/Stop for the accepted final plan is required before implementation' }
	return { status: decision.decision === 'Go' ? 'complete' : 'stopped', stage: 'owner-design', routing, requirement: `owner Design ${decision.decision}` }
}

const main = argv => {
	if (argv.length !== 2 || argv[0] !== 'plan') throw new Error('usage: node routing-coordinator.js plan <facts.json>')
	const facts = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'))
	const result = plan_next_action(facts)
	process.stdout.write(`${JSON.stringify(result)}\n`)
	if (['unsatisfied', 'stopped'].includes(result.status)) process.exitCode = 1
	return result
}

module.exports = { STAGES, stage_task_id, validate_started_record, accepted_record, higher_class, assessment_routing, plan_stage, plan_class_action, plan_next_action, main }

if (require.main === module) {
	try {
		main(process.argv.slice(2))
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		process.exitCode = 1
	}
}
