'use strict'

const fs = require('node:fs')
const path = require('node:path')
const usage_policy = require('./usage-policy.js')
const delegation_route = require('./delegation-route.js')
const routing_contract = require('./routing-contract.js')

const STAGES = Object.freeze({
	assessment: { tier: () => 'basic', role: 'explore', review: false },
	primary: { tier: routing => routing.primary_tier, role: 'implementation', review: false },
	review: { tier: () => 'better', role: 'cross-check', review: true },
	'debate-a': { tier: () => 'better', role: 'cross-check', review: true },
	'debate-b': { tier: () => 'better', role: 'cross-check', review: true },
	synthesis: { tier: () => 'basic', role: 'spec', review: false },
})

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty_text = value => typeof value === 'string' && value.trim().length > 0
const accepted_record = (record, task_id) => {
	const error = delegation_route.validate_execution_record(record)
	if (error) return error
	if (record.task_id !== task_id) return `execution record task_id must be ${task_id}`
	if (record.state !== 'completed' || record.acceptance.accepted !== true) return 'execution record must be completed and accepted'
	return null
}

const stage_task_id = (base, stage) => `${base}:${stage}`
const higher_class = (left, right) => usage_policy.EXECUTION_CLASSES[
	Math.max(usage_policy.EXECUTION_CLASSES.indexOf(left), usage_policy.EXECUTION_CLASSES.indexOf(right))
]

const assessment_routing = (admission, assessment, usage = {}) => {
	const classification = usage_policy.classify_escalated_task(assessment)
	if (!classification.valid) return classification
	const execution_class = higher_class(admission.floor_class, classification.execution_class)
	return usage_policy.route_task({ ...assessment, execution_class }, usage)
}

const plan_stage = (facts, routing, stage) => {
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
		role: definition.role,
		review: definition.review,
		requested_tier: definition.tier(routing),
		brief,
		...(stage === 'assessment' ? { require_read_only: true, enforced_read_only: true } : {}),
		...(executor_choice ? { executor_choice } : {}),
	}
	delete task.tier
	const selection = delegation_route.select_executor_action({
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

const require_record = (facts, stage) => {
	const task_id = stage_task_id(facts.task.task_id, stage)
	const record = facts.records?.[stage]
	if (!record) return { missing: true, task_id }
	const error = accepted_record(record, task_id)
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
	const admission = usage_policy.admit_cheap(admission_facts)
	if (!admission.valid) return { status: 'unsatisfied', requirement: admission.error, routing: admission }
	if (admission.admitted) {
		const routing = usage_policy.route_task(admission_facts, facts.usage)
		if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
		if (routing.route === 'STOP') return { status: 'stopped', routing, requirement: routing.stop_reason }
		const primary = require_record(facts, 'primary')
		if (primary.missing) return plan_stage(facts, routing, 'primary')
		if (primary.error) return { status: 'unsatisfied', stage: 'primary', routing, requirement: primary.error }
		return { status: 'complete', routing }
	}

	const preliminary_routing = usage_policy.route_task({ ...admission_facts, execution_class: admission.floor_class }, facts.usage)
	if (!preliminary_routing.valid) return { status: 'unsatisfied', requirement: preliminary_routing.error, routing: preliminary_routing }
	if (preliminary_routing.route === 'STOP') return { status: 'stopped', routing: preliminary_routing, requirement: preliminary_routing.stop_reason }
	const assessment = require_record(facts, 'assessment')
	if (assessment.missing) return plan_stage(facts, preliminary_routing, 'assessment')
	if (assessment.error) return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: assessment.error }
	if (assessment.record.changed_paths.length > 0) {
		return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: 'assessment must not modify files' }
	}
	let routing_assessment = assessment.record.outputs.routing_assessment
	if (assessment.record.outputs.routing_assessment_envelope !== undefined) {
		const contract = routing_contract.validate_assessment(assessment.record.outputs.routing_assessment_envelope, { task_id: assessment.task_id, source_identity: facts.source_identity })
		if (!contract.valid) return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: contract.error }
		routing_assessment = contract.facts
	}
	if (!is_object(routing_assessment)) {
		return { status: 'unsatisfied', stage: 'assessment', routing: preliminary_routing, requirement: 'assessment must return outputs.routing_assessment' }
	}
	let routing = assessment_routing(admission, routing_assessment, facts.usage)
	if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
	if (routing.route === 'STOP') return { status: 'stopped', routing, requirement: routing.stop_reason }

	const primary = require_record(facts, 'primary')
	if (primary.missing) return plan_stage(facts, routing, 'primary')
	if (primary.error) return { status: 'unsatisfied', stage: 'primary', routing, requirement: primary.error }

	if (routing.execution_class === 'L5' && !routing.review) {
		return {
			status: 'awaiting-routing-facts',
			routing,
			requirement: 'L5 requires explicit material-risk and deterministic-verification facts before review',
		}
	}

	if (routing.review) {
		const review = require_record(facts, 'review')
		if (review.missing) return plan_stage(facts, routing, 'review')
		if (review.error) return { status: 'unsatisfied', stage: 'review', routing, requirement: review.error }
	}

	if (routing.execution_class !== 'L5') return { status: 'complete', routing }
	let review_facts = facts.review_facts
	if (facts.records.review?.outputs?.review_envelope !== undefined) {
		const contract = routing_contract.validate_review(facts.records.review.outputs.review_envelope, { task_id: stage_task_id(facts.task.task_id, 'review'), source_identity: facts.source_identity, review_accepted: true })
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
	routing = usage_policy.route_task({ ...routing_assessment, ...review_facts, execution_class: routing.execution_class }, facts.usage)
	if (!routing.valid) return { status: 'unsatisfied', requirement: routing.error, routing }
	if (review_facts.reviewer_material_disagreement === false) return { status: 'complete', routing }
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
	if (!routing.debate) return { status: 'complete', routing }

	for (const stage of ['debate-a', 'debate-b', 'synthesis']) {
		const record = require_record(facts, stage)
		if (record.missing) return plan_stage(facts, routing, stage)
		if (record.error) return { status: 'unsatisfied', stage, routing, requirement: record.error }
	}
	return { status: 'complete', routing }
}

const main = argv => {
	if (argv.length !== 2 || argv[0] !== 'plan') throw new Error('usage: node routing-coordinator.js plan <facts.json>')
	const facts = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'))
	const result = plan_next_action(facts)
	process.stdout.write(`${JSON.stringify(result)}\n`)
	if (['unsatisfied', 'stopped'].includes(result.status)) process.exitCode = 1
	return result
}

module.exports = { STAGES, stage_task_id, accepted_record, higher_class, assessment_routing, plan_next_action, main }

if (require.main === module) {
	try {
		main(process.argv.slice(2))
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		process.exitCode = 1
	}
}
