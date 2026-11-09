'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const failure_diagnostic = require('./routing-failure.js')

const task_id_valid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9:._-]{0,191}$/u.test(value)
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const persisted_fields = Object.freeze([
	'admission_facts',
	'routing_facts',
	'admission_envelope',
	'source_identity',
	'task',
	'briefs',
	'config',
	'policy',
	'host',
	'capabilities',
	'records',
	'review_facts',
	'owner_design_decision',
	'usage',
	'attempts',
	'attempts_by_stage',
	'launched_candidates',
	'condition_fingerprint',
	'executor_choices',
	'source_root',
	'config_path',
	'resume_identity',
	'input_identity',
])
const forbidden_key = key => {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
	return ['env', 'environment', 'command', 'args', 'arguments', 'prompt', 'message', 'authorization', 'apikey', 'token', 'secret', 'password', 'credential', 'credentials', 'stdout', 'stderr'].includes(normalized)
		|| /(?:token|secret|apikey|password|credential|credentials|bearer|privatekey|cookie|sessionkey|signingkey)(?:value|header|key|data|raw|hash|pem|der|bytes|contents?)?$/u.test(normalized)
		|| normalized.includes('environment')
		|| /env(?:vars?|variables?)$/u.test(normalized)
		|| /(?:command|prompt|message|stdout|stderr)$/u.test(normalized)
		|| normalized.startsWith('authorization')
		|| normalized.includes('runneroptions')
		|| normalized.includes('argumentsbystage')
		|| ['rawargs', 'rawarguments', 'providerargs', 'providerarguments', 'commandargs'].includes(normalized)
}

const redact = value => {
	if (Array.isArray(value)) return value.map(redact)
	if (!is_object(value)) {
		if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 4096) return '[redacted:oversized]'
		return value
	}
	const result = {}
	for (const [key, nested] of Object.entries(value)) {
		if (forbidden_key(key)) continue
		result[key] = redact(nested)
	}
	return result
}

const stable_value = value => {
	if (Array.isArray(value)) return value.map(stable_value)
	if (!is_object(value)) return value
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable_value(value[key])]))
}
const validate_failure_diagnostics = (value, parent_key = '') => {
	if (Array.isArray(value)) {
		for (const item of value) validate_failure_diagnostics(item, parent_key)
		return
	}
	if (!is_object(value)) return
	for (const [key, nested] of Object.entries(value)) {
		if (parent_key === 'transport' && key === 'failure') {
			if (!failure_diagnostic.is_valid(nested)) throw new Error('routing state failure diagnostic is invalid')
		} else {
			validate_failure_diagnostics(nested, key)
		}
	}
}
const content_digest = value => crypto.createHash('sha256').update(JSON.stringify(stable_value(value))).digest('hex')
const valid_digest = value => /^[0-9a-f]{64}$/u.test(value || '')
const identity_for = value => ({ full_digest: content_digest(value), projection_digest: content_digest(redact(value)) })
const frozen_input = (facts, field, stage) => {
	const value = stage === undefined ? facts[field] : facts[field]?.[stage]
	const saved = stage === undefined ? facts.input_identity?.[field] : facts.input_identity?.[field]?.[stage]
	if (!saved) {
		if (JSON.stringify(value)?.includes('\"[redacted:oversized]\"')) return { valid: false, error: 'frozen input identity is missing; the original input must be supplied and frozen again' }
		return { valid: true, complete: true, identity: identity_for(value) }
	}
	if (!valid_digest(saved.full_digest) || !valid_digest(saved.projection_digest)) return { valid: false, error: 'frozen input identity is invalid' }
	const current = content_digest(value)
	if (current !== saved.full_digest && current !== saved.projection_digest) return { valid: false, error: `frozen ${stage || field} input changed; reattach its original content` }
	return { valid: true, complete: current === saved.full_digest, identity: saved }
}
const record_content = record => {
	const { content_identity, content_projection, ...content } = record
	return content
}
const record_digest = record => {
	if (record?.content_projection !== true) return content_digest(record_content(record))
	if (!is_object(record.content_identity) || !valid_digest(record.content_identity.full_digest) || content_digest(record_content(record)) !== record.content_identity.projection_digest) throw new Error('persisted execution content changed')
	return record.content_identity.full_digest
}
const persist_record = record => {
	if (!is_object(record)) return redact(record)
	const full_digest = record_digest(record)
	const projection = redact(record_content(record))
	return { ...projection, content_projection: true, content_identity: { full_digest, projection_digest: content_digest(projection) } }
}
const reattach_inputs = (facts, inputs) => {
	if (!is_object(inputs)) return { valid: false, error: 'frozen input reattachment must be an object' }
	const next = { ...facts, ...(inputs.task ? { task: inputs.task } : {}), ...(inputs.briefs ? { briefs: { ...facts.briefs, ...inputs.briefs } } : {}), ...(inputs.records ? { records: { ...facts.records, ...inputs.records } } : {}) }
	for (const [field, stage] of [...(inputs.task ? [['task']] : []), ...Object.keys(inputs.briefs || {}).map(stage => ['briefs', stage])]) {
		const checked = frozen_input(next, field, stage)
		if (!checked.valid || !checked.complete) return { valid: false, error: checked.error || `reattached ${stage || field} input does not match its full digest` }
	}
	for (const [stage, record] of Object.entries(inputs.records || {})) {
		if (facts.records?.[stage]?.content_identity?.full_digest !== content_digest(record_content(record))) return { valid: false, error: `reattached ${stage} output does not match its full digest` }
		next.records[stage] = record_content(record)
	}
	return { valid: true, facts: next }
}

const input_identities = value => {
	const identities = {}
	if (Object.hasOwn(value, 'task')) {
		const checked = frozen_input(value, 'task')
		if (!checked.valid) return checked
		identities.task = checked.identity
	}
	if (is_object(value.briefs)) {
		identities.briefs = {}
		for (const stage of Object.keys(value.briefs)) {
			const checked = frozen_input(value, 'briefs', stage)
			if (!checked.valid) return checked
			identities.briefs[stage] = checked.identity
		}
	}
	return { valid: true, identities }
}

const persistable_state = value => {
	if (!is_object(value)) throw new Error('routing state must be an object')
	validate_failure_diagnostics(value)
	const result = {}
	for (const field of persisted_fields) {
		if (Object.hasOwn(value, field)) result[field] = redact(value[field])
	}
	const input_identity = input_identities(value)
	if (!input_identity.valid) throw new Error(input_identity.error)
	result.input_identity = input_identity.identities
	if (is_object(value.records)) result.records = Object.fromEntries(Object.entries(value.records).map(([stage, record]) => [stage, persist_record(record)]))
	return result
}

const public_projection = value => persistable_state(value)

const assert_no_symlink_components = target => {
	const absolute = path.resolve(target)
	const parsed = path.parse(absolute)
	let current = parsed.root
	for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		if (!fs.existsSync(current)) continue
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error('routing state path must not contain a symbolic link')
	}
}

const ensure_directory = target => {
	const absolute = path.resolve(target)
	assert_no_symlink_components(absolute)
	const parsed = path.parse(absolute)
	let current = parsed.root
	for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
		if (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory()) {
			throw new Error('routing state path must contain only real directories')
		}
	}
}

const state_path = (workspace, task_id) => {
	if (!task_id_valid(task_id)) throw new Error('routing task_id is invalid')
	const root = path.resolve(workspace)
	assert_no_symlink_components(root)
	const target = path.resolve(root, 'routing', task_id, 'state.json')
	if (!target.startsWith(`${root}${path.sep}`)) throw new Error('routing state path escapes workspace')
	assert_no_symlink_components(path.dirname(target))
	return target
}

const read_payload = target => {
	if (!fs.existsSync(target)) return null
	assert_no_symlink_components(target)
	const payload = JSON.parse(fs.readFileSync(target, 'utf8'))
	if (!payload || payload.version !== 1 || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || typeof payload.digest !== 'string' || digest(payload.state) !== payload.digest) {
		throw new Error('routing state integrity check failed')
	}
	if (payload.prior_digest !== undefined && payload.prior_digest !== null && typeof payload.prior_digest !== 'string') throw new Error('routing state prior digest is invalid')
	validate_failure_diagnostics(payload.state)
	return { ...payload, prior_digest: payload.prior_digest ?? null }
}

const fsync_directory = directory => {
	const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
	try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

const save = (workspace, task_id, state, options = {}) => {
	const target = state_path(workspace, task_id)
	const directory = path.dirname(target)
	ensure_directory(directory)
	const current = read_payload(target)
	const expected_revision = options.expected_revision === undefined ? 0 : options.expected_revision
	if (!Number.isSafeInteger(expected_revision) || expected_revision < 0) throw new Error('routing state expected_revision must be a non-negative safe integer')
	const current_revision = current?.revision || 0
	if (expected_revision !== current_revision) throw new Error(`routing state revision is stale: expected ${expected_revision}, current ${current_revision}`)
	const persisted = persistable_state(state)
	const payload = {
		version: 1,
		revision: current_revision + 1,
		prior_digest: current?.digest || null,
		digest: digest(persisted),
		state: persisted,
	}
	const temporary = path.join(directory, `.state-${process.pid}-${crypto.randomUUID()}.tmp`)
	const descriptor = fs.openSync(temporary, 'wx', 0o600)
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`)
		fs.fsyncSync(descriptor)
	} finally {
		fs.closeSync(descriptor)
	}
	try {
		fs.renameSync(temporary, target)
		fsync_directory(directory)
	} catch (error) {
		try { fs.unlinkSync(temporary) } catch {}
		throw error
	}
	return { path: target, ...payload }
}

const load = (workspace, task_id) => {
	const target = state_path(workspace, task_id)
	const payload = read_payload(target)
	if (!payload) return null
	return { path: target, ...payload }
}

module.exports = {
	input_identities,
	record_content,
	stable_value,
	content_digest,
	frozen_input,
	record_digest,
	reattach_inputs,
	persisted_fields,
	task_id_valid,
	redact,
	persistable_state,
	public_projection,
	assert_no_symlink_components,
	state_path,
	save,
	load,
}
