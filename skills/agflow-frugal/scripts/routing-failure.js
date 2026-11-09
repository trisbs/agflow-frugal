'use strict'

const failure_keys = Object.freeze([
	'version',
	'outcome',
	'clue',
	'clue_source',
	'stderr_bytes',
	'stderr_truncated',
	'recovery_hint',
])
const outcomes = new Set(['spawn_error', 'nonzero_exit', 'signaled', 'timed_out', 'stalled', 'cancelled', 'nested_worker_violation', 'adapter_failure', 'unknown'])
const clues = new Set(['unknown', 'read_only_filesystem', 'permission_denied'])
const recovery_hints = Object.freeze({
	unknown: 'Review approved executor diagnostics before authorizing a new attempt.',
	read_only_filesystem: 'Use an executor runtime with writable state, then authorize a new attempt.',
	permission_denied: 'Check executor access to the required files, then authorize a new attempt.',
})
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const clue_from_stderr = stderr => {
	if (/(?:\bEROFS\b|read[\s-]?only (?:file )?system|read[\s-]?only filesystem)/iu.test(stderr)) return 'read_only_filesystem'
	if (/(?:\bEACCES\b|\bEPERM\b|permission denied|operation not permitted)/iu.test(stderr)) return 'permission_denied'
	return 'unknown'
}

const outcome_from_runner = runner => {
	const status = runner?.status
	if (['spawn_error', 'timed_out', 'stalled', 'cancelled', 'nested_worker_violation'].includes(status)) return status
	if (status === 'failed') {
		if (runner.process?.signal) return 'signaled'
		if (Number.isInteger(runner.process?.exit_code) && runner.process.exit_code !== 0) return 'nonzero_exit'
	}
	return 'unknown'
}

const from_runner = (runner, outcome_override) => {
	const stderr = typeof runner?.stderr === 'string' ? runner.stderr : ''
	const outcome = outcomes.has(outcome_override) ? outcome_override : outcome_from_runner(runner)
	const clue = outcome === 'adapter_failure' ? 'unknown' : clue_from_stderr(stderr)
	const stderr_bytes = Number.isSafeInteger(runner?.stderr_bytes) && runner.stderr_bytes >= 0
		? runner.stderr_bytes
		: Buffer.byteLength(stderr, 'utf8')
	return {
		version: 1,
		outcome,
		clue,
		clue_source: clue === 'unknown' ? 'none' : 'stderr_indicator',
		stderr_bytes,
		stderr_truncated: runner?.stderr_truncated === true,
		recovery_hint: recovery_hints[clue],
	}
}

const is_valid = value => {
	if (!is_object(value) || Object.keys(value).length !== failure_keys.length || failure_keys.some(key => !Object.hasOwn(value, key))) return false
	if (value.version !== 1 || !outcomes.has(value.outcome) || !clues.has(value.clue)) return false
	if (value.clue_source !== (value.clue === 'unknown' ? 'none' : 'stderr_indicator')) return false
	if (!Number.isSafeInteger(value.stderr_bytes) || value.stderr_bytes < 0 || typeof value.stderr_truncated !== 'boolean') return false
	return value.recovery_hint === recovery_hints[value.clue]
}

module.exports = { from_runner, is_valid }
