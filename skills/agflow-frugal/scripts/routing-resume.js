'use strict'

const crypto = require('node:crypto')
const child_process = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const stable_value = value => {
	if (Array.isArray(value)) return value.map(stable_value)
	if (!is_object(value)) return value
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable_value(value[key])]))
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable_value(value))).digest('hex')
const same = (left, right) => JSON.stringify(stable_value(left)) === JSON.stringify(stable_value(right))

const valid_source_identity = value => is_object(value) && (
	value.source_kind === 'git' && /^[0-9a-f]{40}$/u.test(value.value || '') ||
	value.source_kind === 'no-git' && /^[0-9a-f]{64}$/u.test(value.value || '')
)

const record_identities = records => {
	if (!is_object(records)) return { valid: true, identities: {} }
	const identities = {}
	for (const [stage, record] of Object.entries(records)) {
		if (!is_object(record) || record.acceptance?.accepted !== true) continue
		if (!/^[0-9a-f]{64}$/u.test(record.brief_digest || '')) {
			return { valid: false, error: `accepted ${stage} record has no valid brief digest` }
		}
		if (!valid_source_identity(record.source_identity)) {
			return { valid: false, error: `accepted ${stage} record has no valid source identity` }
		}
		identities[stage] = {
			brief_digest: record.brief_digest,
			source_identity: stable_value(record.source_identity),
			requested_digest: digest(record.requested || {}),
			candidate_id: record.candidate_id,
			kind: record.kind,
		}
	}
	return { valid: true, identities }
}

const create_snapshot = facts => {
	if (!is_object(facts) || !text(facts.task?.task_id)) return { valid: false, error: 'resume identity requires a stable task_id' }
	if (!valid_source_identity(facts.source_identity)) return { valid: false, error: 'resume identity requires a valid source identity' }
	if (!is_object(facts.config)) return { valid: false, error: 'resume identity requires routing configuration' }
	const records = record_identities(facts.records)
	if (!records.valid) return records
	return {
		valid: true,
		snapshot: {
			version: 1,
			task_id: facts.task.task_id,
			source_identity: stable_value(facts.source_identity),
			config_digest: digest(facts.config),
			records: records.identities,
		},
	}
}

const observe_source_identity = (source_root, expected) => {
	if (!text(source_root) || !valid_source_identity(expected)) return { valid: false, error: 'resume requires a source root and expected source identity' }
	if (expected.source_kind !== 'git') return { valid: false, error: 'automatic no-git source observation is unavailable' }
	let value
	try {
		value = child_process.execFileSync('git', ['-C', source_root, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim()
	} catch {
		return { valid: false, error: 'current Git source identity could not be observed' }
	}
	return /^[0-9a-f]{40}$/u.test(value)
		? { valid: true, source_identity: { source_kind: 'git', value } }
		: { valid: false, error: 'current Git source identity is invalid' }
}

const read_current_config = (source_root, config_path) => {
	if (!text(source_root) || !text(config_path)) return { valid: false, error: 'resume requires a source root and configuration path' }
	let root
	let target
	try {
		root = fs.realpathSync(source_root)
		target = fs.realpathSync(path.resolve(config_path))
	} catch {
		return { valid: false, error: 'current routing configuration could not be read' }
	}
	if (target !== root && !target.startsWith(`${root}${path.sep}`)) return { valid: false, error: 'routing configuration path escapes the source root' }
	try {
		const config = JSON.parse(fs.readFileSync(target, 'utf8'))
		return is_object(config)
			? { valid: true, config }
			: { valid: false, error: 'current routing configuration must be an object' }
	} catch {
		return { valid: false, error: 'current routing configuration is invalid' }
	}
}

const validate_snapshot = (expected, current) => {
	if (!is_object(expected) || expected.version !== 1) return { valid: false, error: 'persisted resume identity is missing or unsupported' }
	if (!is_object(current) || current.task_id !== expected.task_id) return { valid: false, error: 'resume task identity changed' }
	if (!same(current.source_identity, expected.source_identity)) return { valid: false, error: 'resume source identity changed' }
	if (current.config_digest !== expected.config_digest) return { valid: false, error: 'resume configuration identity changed' }
	if (!same(current.records, expected.records)) return { valid: false, error: 'resume brief or requested-control identity changed' }
	return { valid: true }
}

const validate_loaded_state = (state, dependencies = {}) => {
	if (!is_object(state) || !is_object(state.resume_identity)) return { valid: false, error: 'persisted state has no resume identity' }
	const source = typeof dependencies.observe_source_identity === 'function'
		? dependencies.observe_source_identity(state.source_root, state.resume_identity.source_identity)
		: observe_source_identity(state.source_root, state.resume_identity.source_identity)
	if (!source?.valid) return source || { valid: false, error: 'current source identity could not be observed' }
	const configuration = typeof dependencies.read_current_config === 'function'
		? dependencies.read_current_config(state.source_root, state.config_path)
		: read_current_config(state.source_root, state.config_path)
	if (!configuration?.valid) return configuration || { valid: false, error: 'current configuration could not be observed' }
	const records = typeof dependencies.observe_record_identities === 'function'
		? dependencies.observe_record_identities(state)
		: record_identities(state.records)
	if (!records?.valid) return records || { valid: false, error: 'current record identities could not be observed' }
	return validate_snapshot(state.resume_identity, {
		task_id: state.task?.task_id,
		source_identity: source.source_identity,
		config_digest: digest(configuration.config),
		records: records.identities,
	})
}

module.exports = {
	digest,
	record_identities,
	create_snapshot,
	observe_source_identity,
	read_current_config,
	validate_snapshot,
	validate_loaded_state,
}
