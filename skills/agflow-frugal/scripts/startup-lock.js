'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { format_local_timestamp } = require('./local-time.js')

const lock_path_for = repo => path.join(repo, '.agentflow-start.lock')
const recovery_path_for = repo => path.join(repo, '.agentflow-start.recovery.lock')
const same_identity = (left, right) => Boolean(left && right) && left.dev === right.dev && left.ino === right.ino
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const remove_if_owned = (file, expected) => {
  if (!expected) return
  try {
    const current = fs.lstatSync(file)
    if (current.isFile() && !current.isSymbolicLink() && same_identity(identity(current), expected)) fs.unlinkSync(file)
  } catch {}
}

const process_state = pid => {
  try { process.kill(pid, 0); return 'present' } catch (error) {
    if (error.code === 'ESRCH') return 'stale'
    if (error.code === 'EPERM') return 'present'
    return 'unknown'
  }
}

const parse_lock = (text, repo) => {
  const lines = String(text).split(/\r?\n/u).filter(Boolean)
  let header
  const journal = []
  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.type === 'agentflow_start_lock') header = record
    else if (record && typeof record.type === 'string') journal.push(record)
  }
  if (header?.version === 1 && Number.isSafeInteger(header.pid) && header.pid > 0
    && header.repository === repo && typeof header.token === 'string' && /^[a-f0-9]{32}$/u.test(header.token)
    && typeof header.started_at === 'string') {
    const state_record = journal.filter(record => record.type === 'state').at(-1)
    const baseline = journal.filter(record => record.type === 'baseline').at(-1)
    if (baseline && Array.isArray(baseline.paths) && new Set(baseline.paths).size === baseline.paths.length && baseline.paths.every(relative => {
      if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) return false
      const resolved = path.resolve(repo, relative)
      const inside = path.relative(repo, resolved)
      return inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside)
    }) && baseline.before && typeof baseline.before === 'object' && !Array.isArray(baseline.before)
      && Object.keys(baseline.before).length === baseline.paths.length
      && baseline.paths.every(relative => Object.hasOwn(baseline.before, relative))
      && Object.entries(baseline.before).every(([relative, value]) => baseline.paths.includes(relative) && (value === null || (
        value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 7
        && ['dev', 'ino', 'size', 'mode', 'mtime', 'ctime', 'sha256'].every(key => typeof value[key] === 'string')
        && /^[a-f0-9]{64}$/u.test(value.sha256)
      )))) {
      header.baseline = baseline
    }
    header.phases = journal.filter(record => record.type === 'phase').map(record => record.name).filter(name => typeof name === 'string')
    const liveness = process_state(header.pid)
    header.state = liveness === 'stale' && state_record?.state === 'abandoned' ? 'abandoned' : liveness
    return header
  }
  const pid_match = /^pid:\s*(\d+)$/mu.exec(String(text))
  return { state: 'unverified', pid: pid_match ? Number(pid_match[1]) : null, started_at: '', legacy: true, baseline: null, phases: [] }
}

const inspect_lock = (file, repo) => {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'unverified', detail: 'startup lock is not a regular file' }
    const text = fs.readFileSync(file, 'utf8')
    const parsed = parse_lock(text, repo)
    return { ...parsed, status: parsed.state || parsed.status || 'unverified', identity: identity(stat), text }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' }
    return { status: 'unverified', detail: `startup lock could not be read: ${error.message}` }
  }
}

const inspect_recovery_guard = (file, repo) => {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'unverified', detail: 'startup recovery guard is not a regular file' }
    const text = fs.readFileSync(file, 'utf8')
    let header
    try { header = JSON.parse(text.split(/\r?\n/u, 1)[0]) } catch {}
    if (header?.type !== 'agentflow_start_recovery' || header.version !== 1 || header.repository !== repo || !Number.isSafeInteger(header.pid) || header.pid <= 0) {
      return { status: 'unverified', detail: 'startup recovery guard is unreadable or belongs to another repository' }
    }
    const status = process_state(header.pid)
    return {
      status,
      pid: header.pid,
      started_at: header.started_at,
      detail: status === 'present'
        ? 'the recorded process is still present and may be serializing startup recovery'
        : status === 'stale'
          ? 'the recorded process is gone; inspect this guard and remove only this guard before retrying'
          : 'the recorded process state is unknown; inspect this guard before retrying',
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' }
    return { status: 'unverified', detail: `startup recovery guard could not be read: ${error.message}` }
  }
}

const create_lock = repo => {
  const file = lock_path_for(repo)
  const token = crypto.randomBytes(16).toString('hex')
  const header = { type: 'agentflow_start_lock', version: 1, pid: process.pid, started_at: format_local_timestamp(), repository: repo, token }
  let descriptor
  let opened_identity
  try {
    descriptor = fs.openSync(file, 'wx', 0o600)
    opened_identity = identity(fs.fstatSync(descriptor))
    fs.writeFileSync(descriptor, `${JSON.stringify(header)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    return { path: file, descriptor, token, identity: opened_identity, header, baseline: null, phases: [] }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    if (error.code !== 'EEXIST') remove_if_owned(file, opened_identity)
    if (error.code === 'EEXIST') return null
    throw error
  }
}

const acquire_recovery_guard = repo => {
  const file = recovery_path_for(repo)
  const token = crypto.randomBytes(16).toString('hex')
  const header = { type: 'agentflow_start_recovery', version: 1, pid: process.pid, started_at: format_local_timestamp(), repository: repo, token }
  let descriptor
  let opened_identity
  try {
    descriptor = fs.openSync(file, 'wx', 0o600)
    opened_identity = identity(fs.fstatSync(descriptor))
    fs.writeFileSync(descriptor, `${JSON.stringify(header)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    return { path: file, descriptor, header, identity: opened_identity }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    if (error.code !== 'EEXIST') remove_if_owned(file, opened_identity)
    if (error.code !== 'EEXIST') throw error
    const current = inspect_recovery_guard(file, repo)
    const status = current.status === 'present' ? 'recovery_in_progress' : 'recovery_guard_unverified'
    return { path: file, existing: true, status, pid: current.pid || null, started_at: current.started_at || '', detail: current.detail || 'startup recovery guard already exists; no startup lock was changed' }
  }
}

const release_recovery_guard = guard => {
  try {
    const current = fs.lstatSync(guard.path)
    if (!current.isFile() || current.isSymbolicLink() || !same_identity(identity(current), guard.identity)) {
      fs.closeSync(guard.descriptor)
      return `startup recovery guard changed while owned; left ${guard.path} in place for inspection`
    }
    const text = fs.readFileSync(guard.path, 'utf8')
    if (!text.startsWith(`${JSON.stringify(guard.header)}\n`)) {
      fs.closeSync(guard.descriptor)
      return `startup recovery guard owner token changed; left ${guard.path} in place for inspection`
    }
    fs.closeSync(guard.descriptor)
    fs.unlinkSync(guard.path)
    return ''
  } catch (error) {
    try { fs.closeSync(guard.descriptor) } catch {}
    return `could not clear startup recovery guard ${guard.path}: ${error.message}`
  }
}

const append = (lock, record) => {
  if (!lock || lock.existing || !record || typeof record.type !== 'string') throw new Error('startup transaction journal is unavailable')
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  let offset = 0
  while (offset < bytes.length) {
    const written = fs.writeSync(lock.descriptor, bytes, offset, bytes.length - offset)
    if (!Number.isInteger(written) || written <= 0) throw new Error('startup transaction journal write did not make progress')
    offset += written
  }
  fs.fsyncSync(lock.descriptor)
  if (record.type === 'baseline') lock.baseline = record
  if (record.type === 'phase' && typeof record.name === 'string') lock.phases.push(record.name)
  if (record.type === 'state') lock.state = record.state
}

const close_descriptor = lock => {
  if (!lock || lock.descriptor === undefined) return
  const descriptor = lock.descriptor
  lock.descriptor = undefined
  fs.closeSync(descriptor)
}

const release = lock => {
  if (!lock || lock.existing) return ''
  try {
    const current = fs.lstatSync(lock.path)
    if (!current.isFile() || current.isSymbolicLink() || !same_identity(identity(current), lock.identity)) {
      close_descriptor(lock)
      return `startup lock changed while this process owned it; left ${lock.path} in place for inspection`
    }
    const text = fs.readFileSync(lock.path, 'utf8')
    if (!text.startsWith(`${JSON.stringify(lock.header)}\n`)) {
      close_descriptor(lock)
      return `startup lock owner token changed; left ${lock.path} in place for inspection`
    }
    close_descriptor(lock)
    fs.unlinkSync(lock.path)
    return ''
  } catch (error) {
    try { close_descriptor(lock) } catch {}
    return `could not clear startup lock ${lock.path}: ${error.message}`
  }
}

const abandon = (lock, phase, changed_paths) => {
  let detail = ''
  try { append(lock, { type: 'state', state: 'abandoned', phase, changed_paths }) }
  catch (error) { detail = `startup recovery journal could not be updated: ${error.message}` }
  try { close_descriptor(lock) } catch (error) { detail = [detail, `startup lock could not be closed: ${error.message}`].filter(Boolean).join('; ') }
  return detail
}

const acquire = (repo, { recover_related_lock } = {}) => {
  const guard = acquire_recovery_guard(repo)
  if (guard.existing) return guard
  let result
  let operation_error = null
  try {
    const first = create_lock(repo)
    if (first) result = first
    else {
      const file = lock_path_for(repo)
      const previous = inspect_lock(file, repo)
      if (previous.status !== 'stale' && previous.status !== 'abandoned') result = { path: file, existing: true, ...previous }
      else {
        const verified = inspect_lock(file, repo)
        if (!same_identity(previous.identity, verified.identity) || previous.text !== verified.text) {
          result = { path: file, existing: true, status: 'changed', detail: 'startup lock changed during stale-lock recovery' }
        } else {
          const related = recover_related_lock?.(previous)
          if (related && related.recovered === false) {
            result = { path: related.path || file, existing: true, status: 'related_lock_unresolved', detail: related.detail || 'related notebook-writer lock could not be recovered safely' }
          }
          if (!result) {
            try { fs.unlinkSync(file) } catch (error) {
              result = { path: file, existing: true, status: 'stale_unrecovered', pid: previous.pid, started_at: previous.started_at, phases: previous.phases, detail: `stale startup lock could not be removed: ${error.message}` }
            }
            if (!result) {
              const recovered = create_lock(repo)
              if (!recovered) {
                result = { path: file, existing: true, ...inspect_lock(file, repo) }
              } else {
                recovered.recovered = { pid: previous.pid, started_at: previous.started_at, baseline: previous.baseline || null, phases: previous.phases || [] }
                result = recovered
              }
            }
          }
        }
      }
    }
  } catch (error) {
    operation_error = error
  }
  const guard_error = release_recovery_guard(guard)
  if (operation_error || guard_error) {
    const lock_error = result && !result.existing ? release(result) : ''
    throw new Error([operation_error?.message, guard_error, lock_error].filter(Boolean).join('; '))
  }
  return result
}

module.exports = { lock_path_for, recovery_path_for, process_state, parse_lock, inspect_lock, inspect_recovery_guard, acquire, append, release, abandon }
