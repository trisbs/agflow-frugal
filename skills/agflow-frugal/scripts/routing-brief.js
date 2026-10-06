'use strict'

const crypto = require('node:crypto')

const stages = new Set(['assessment', 'primary', 'review', 'debate-a', 'debate-b', 'synthesis'])
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

const build = input => {
	if (!is_object(input) || !stages.has(input.stage) || !is_object(input.task) || !text(input.task.task_id) || !is_object(input.source_identity)) throw new TypeError('routing brief requires a known stage, task_id, and source_identity')
	const read_only = input.stage === 'assessment' || input.read_only === true
	const brief = {
		version: 1,
		stage: input.stage,
		task_id: input.task.task_id,
		source_identity: input.source_identity,
		goal: input.goal || input.task.brief?.goal || input.task.frozen_brief?.goal || '',
		work_boundary: Array.isArray(input.task.work_boundary) ? [...input.task.work_boundary] : [],
		requested_tier: input.task.requested_tier || input.tier || 'basic',
		write_authority: read_only ? { source: 'none', result: 'structured-output-only' } : { source: 'declared-boundary', result: 'structured-output' },
		verification: Array.isArray(input.verification) ? [...input.verification] : [],
		output_contract: input.stage === 'assessment' ? 'assessment-envelope-v1' : input.stage === 'review' ? 'review-envelope-v1' : 'stage-result-v1',
		no_delegation: true,
	}
	return { brief, digest: digest(brief) }
}

module.exports = { stages, digest, build }
