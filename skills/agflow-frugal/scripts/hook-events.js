'use strict'

const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { format_local_timestamp } = require('./local-time.js')

const SAFE_HOST = /^[a-z0-9][a-z0-9_-]{0,127}$/u
const EVENTS = new Set(['UserPromptSubmit', 'Stop'])
const OUTCOMES = new Set([
  'capture_saved', 'capture_duplicate', 'capture_not_saved', 'capture_owner_conflict',
  'no_notebook', 'stop_passed', 'stop_warning', 'stop_blocked', 'stop_skipped',
  'stop_retry_passed', 'stop_retry_report_failed', 'stop_retry_unchecked', 'stop_duplicate', 'stop_report_incomplete',
  'hook_error', 'completed', 'unknown',
])
const LIMIT = 200
const STOP_FEEDBACK_PREFIX = 'stop-feedback-'

const receipt_root = root => path.join(root, '.agentflow', '.tmp', 'hook-events')

const event_root = root => {
  const resolved = fs.realpathSync(root)
  if (path.basename(path.dirname(resolved)) !== '.worktrees') return resolved
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: resolved, encoding: 'utf8', timeout: 3000 })
  if (git.status === 0 && git.stdout.trim()) return path.dirname(path.resolve(resolved, git.stdout.trim()))
  return resolved
}

const ensure_local_directory = (root, directory) => {
  const workspace = path.join(root, '.agentflow')
  const workspace_stat = fs.lstatSync(workspace)
  if (!workspace_stat.isDirectory() || workspace_stat.isSymbolicLink()) throw new Error('Agentflow workspace is not a regular directory')
  const relative = path.relative(workspace, directory)
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('hook receipt path escapes the Agentflow workspace')
  let parent = workspace
  for (const segment of ['.tmp', 'hook-events']) {
    const candidate = path.join(parent, segment)
    try { fs.mkdirSync(candidate) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = fs.lstatSync(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('hook receipt path is not a regular local directory')
    parent = candidate
  }
  return directory
}

const correlation_for = (input, host) => {
  const session = typeof input.session_id === 'string' && input.session_id.length > 0 ? input.session_id : ''
  const turn = typeof input.turn_id === 'string' && input.turn_id.length > 0 ? input.turn_id : ''
  const scope = turn ? 'turn' : session ? 'session' : 'unavailable'
  const hash = material => crypto.createHash('sha256').update(material).digest('hex')
  if (scope === 'unavailable') return { scope, id: null, session_id: null }
  const session_id = session ? hash(JSON.stringify([host, session])) : null
  const id = hash(JSON.stringify([host, session, turn]))
  return { scope, id, session_id }
}

const write_atomic = (file, record) => {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  let descriptor
  let renamed = false
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, file)
    renamed = true
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    if (!renamed) {
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}

const prune_stop_feedback = directory => {
  const files = fs.readdirSync(directory).filter(name => name.startsWith(STOP_FEEDBACK_PREFIX) && name.endsWith('.json')).map(name => {
    const file = path.join(directory, name)
    try {
      const stat = fs.lstatSync(file)
      return stat.isFile() && !stat.isSymbolicLink() ? { file, mtime: stat.mtimeMs } : null
    } catch { return null }
  }).filter(Boolean).sort((left, right) => right.mtime - left.mtime)
  for (const stale of files.slice(LIMIT)) {
    try { fs.unlinkSync(stale.file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

// Multiple matching Codex Stop registrations can run for one turn. Claim the
// continuation atomically so one malformed report creates at most one prompt.
const claim_stop_feedback = ({ root, input, host }) => {
  const correlation = correlation_for(input, host)
  if (input?.hook_event_name !== 'Stop' || correlation.scope !== 'turn' || !correlation.id) return true
  const storage_root = event_root(root)
  const directory = ensure_local_directory(storage_root, receipt_root(storage_root))
  const file = path.join(directory, `${STOP_FEEDBACK_PREFIX}${correlation.id}.json`)
  let descriptor
  try {
    descriptor = fs.openSync(file, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, host, created_at_ms: Date.now() })}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    try { prune_stop_feedback(directory) } catch {}
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
  }
}

const prune = directory => {
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    const file = path.join(directory, name)
    try {
      const stat = fs.lstatSync(file)
      return stat.isFile() && !stat.isSymbolicLink() ? { file, mtime: stat.mtimeMs } : null
    } catch { return null }
  }).filter(Boolean).sort((left, right) => right.mtime - left.mtime)
  for (const stale of files.slice(LIMIT)) {
    try { fs.unlinkSync(stale.file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

const begin = ({ root, input, host }) => {
  if (!SAFE_HOST.test(String(host || '')) || !EVENTS.has(input?.hook_event_name)) return null
  const storage_root = event_root(root)
  const workspace = path.join(storage_root, '.agentflow')
  if (!fs.existsSync(workspace)) return null
  const directory = ensure_local_directory(storage_root, receipt_root(storage_root))
  const id = crypto.randomUUID()
  const correlation = correlation_for(input, host)
  const record = {
    version: 1,
    id,
    host,
    event: input.hook_event_name,
    correlation_scope: correlation.scope,
    correlation_id: correlation.id,
    session_correlation_id: correlation.session_id,
    state: 'running',
    outcome: 'unknown',
    started_at: format_local_timestamp(),
    started_at_ms: Date.now(),
  }
  const file = path.join(directory, `${Date.now()}-${id}.json`)
  write_atomic(file, record)
  try { prune(directory) } catch {}
  return { file, record }
}

const finish = (ticket, { state = 'completed', outcome = 'completed' } = {}) => {
  if (!ticket || !OUTCOMES.has(outcome) || !['completed', 'blocked', 'failed'].includes(state)) return false
  try {
    const stat = fs.lstatSync(ticket.file)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const record = { ...ticket.record, state, outcome, finished_at: format_local_timestamp(), finished_at_ms: Date.now() }
    write_atomic(ticket.file, record)
    return true
  } catch { return false }
}

const read_recent = ({ root, host, limit = 20 } = {}) => {
  if (!SAFE_HOST.test(String(host || ''))) return []
  let directory
  try { directory = receipt_root(event_root(root)) } catch { return [] }
  let parent = path.dirname(path.dirname(directory))
  try {
    const workspace_stat = fs.lstatSync(parent)
    if (!workspace_stat.isDirectory() || workspace_stat.isSymbolicLink()) return []
  } catch { return [] }
  for (const segment of ['.tmp', 'hook-events']) {
    parent = path.join(parent, segment)
    try {
      const stat = fs.lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return []
    } catch { return [] }
  }
  let names
  try { names = fs.readdirSync(directory).filter(name => name.endsWith('.json')) } catch { return [] }
  return names.map(name => {
    const file = path.join(directory, name)
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
      const record = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (record?.version !== 1 || record.host !== host || !EVENTS.has(record.event)
        || typeof record.id !== 'string' || typeof record.started_at !== 'string'
        || !['turn', 'session', 'unavailable'].includes(record.correlation_scope)
        || (record.correlation_id !== null && typeof record.correlation_id !== 'string')
        || (record.session_correlation_id !== null && typeof record.session_correlation_id !== 'string')
        || !OUTCOMES.has(record.outcome) || !['running', 'completed', 'blocked', 'failed'].includes(record.state)) return null
      return { ...record, _mtime: stat.mtimeMs }
    } catch { return null }
  }).filter(Boolean).sort((left, right) => right._mtime - left._mtime).slice(0, Math.max(1, Math.min(LIMIT, limit))).map(({ _mtime, ...record }) => record)
}

const summarize = records => {
  const by_event = {}
  for (const event of EVENTS) {
    const matches = records.filter(record => record.event === event)
    const latest = matches[0]
    const correlated = matches.filter(record => record.correlation_id && record.correlation_id === latest?.correlation_id)
    by_event[event] = {
      invocations: matches.length,
      latest: latest ? { state: latest.state, outcome: latest.outcome, at: latest.finished_at || latest.started_at, correlation_scope: latest.correlation_scope } : null,
      repeated_correlation: correlated.length > 1,
      other_event_in_session: Boolean(latest?.session_correlation_id && records.some(record => record.event !== event && record.session_correlation_id === latest.session_correlation_id)),
    }
  }
  return by_event
}

module.exports = { begin, finish, read_recent, summarize, receipt_root, event_root, correlation_for, claim_stop_feedback, LIMIT }
