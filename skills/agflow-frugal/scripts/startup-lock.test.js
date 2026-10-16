'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const startup_lock = require('./startup-lock.js')

test('startup lock ownership is exclusive and release removes only its own lock', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-start-lock-'))
  try {
    const first = startup_lock.acquire(repo)
    assert.equal(first.existing, undefined)
    const active = startup_lock.acquire(repo)
    assert.equal(active.existing, true)
    assert.equal(active.status, 'present')
    assert.equal(active.pid, process.pid)
    assert.equal(startup_lock.release(first), '')
    assert.equal(fs.existsSync(path.join(repo, '.agentflow-start.lock')), false)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('startup journal append retries after a partial syscall write', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-start-lock-partial-write-'))
  const lock = startup_lock.acquire(repo)
  const original_write = fs.writeSync
  let partial_writes = 0
  fs.writeSync = function (...args) {
    const [descriptor, buffer, offset, length] = args
    if (descriptor !== lock.descriptor) return original_write.apply(fs, args)
    assert.ok(Buffer.isBuffer(buffer))
    partial_writes += 1
    return original_write.call(fs, descriptor, buffer, offset, Math.min(length, 4))
  }
  try {
    startup_lock.append(lock, { type: 'phase', name: 'ownership_checked' })
  } finally {
    fs.writeSync = original_write
  }
  try {
    assert.ok(partial_writes > 1, `expected short-write retries, got ${partial_writes} write`)
    const records = fs.readFileSync(lock.path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.at(-1), { type: 'phase', name: 'ownership_checked' })
    assert.equal(startup_lock.release(lock), '')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('startup lock recovery preserves baseline and phase evidence from a dead owner', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-start-lock-recover-'))
  try {
    const header = { type: 'agentflow_start_lock', version: 1, pid: 2147483647, started_at: '2026-10-14 12:00:00 +0800', repository: repo, token: 'b'.repeat(32) }
    const baseline = { type: 'baseline', paths: ['ag.json'], before: { 'ag.json': null } }
    const phase = { type: 'phase', name: 'configuration_initialized' }
    fs.writeFileSync(path.join(repo, '.agentflow-start.lock'), `${[header, baseline, phase].map(record => JSON.stringify(record)).join('\n')}\n`)

    const recovered = startup_lock.acquire(repo)

    assert.equal(recovered.existing, undefined)
    assert.deepEqual(recovered.recovered, { pid: header.pid, started_at: header.started_at, baseline, phases: ['configuration_initialized'] })
    assert.equal(startup_lock.release(recovered), '')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('startup lock recovery leaves legacy locks in place', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-start-lock-legacy-'))
  try {
    const file = path.join(repo, '.agentflow-start.lock')
    fs.writeFileSync(file, 'Agentflow startup lock\npid: 123\n')
    const existing = startup_lock.acquire(repo)
    assert.equal(existing.existing, true)
    assert.equal(existing.status, 'unverified')
    assert.equal(fs.readFileSync(file, 'utf8'), 'Agentflow startup lock\npid: 123\n')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('startup recovery guard blocks a competing stale-lock recovery without changing either lock', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-start-lock-guard-'))
  try {
    const stale = { type: 'agentflow_start_lock', version: 1, pid: 2147483647, started_at: '2026-10-14 12:00:00 +0800', repository: repo, token: 'e'.repeat(32) }
    const guard = { type: 'agentflow_start_recovery', version: 1, pid: process.pid, started_at: '2026-10-14 12:00:01 +0800', repository: repo, token: 'f'.repeat(32) }
    const stale_file = startup_lock.lock_path_for(repo)
    const guard_file = startup_lock.recovery_path_for(repo)
    fs.writeFileSync(stale_file, `${JSON.stringify(stale)}\n`)
    fs.writeFileSync(guard_file, `${JSON.stringify(guard)}\n`)

    const blocked = startup_lock.acquire(repo)

    assert.equal(blocked.existing, true)
    assert.equal(blocked.status, 'recovery_in_progress')
    assert.equal(blocked.pid, process.pid)
    assert.equal(fs.readFileSync(stale_file, 'utf8'), `${JSON.stringify(stale)}\n`)
    assert.equal(fs.readFileSync(guard_file, 'utf8'), `${JSON.stringify(guard)}\n`)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('a leftover recovery guard stays for inspection when its recorded process is gone', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-start-lock-stale-guard-'))
  try {
    const guard = { type: 'agentflow_start_recovery', version: 1, pid: 2147483647, started_at: '2026-10-14 12:00:01 +0800', repository: repo, token: 'a'.repeat(32) }
    const file = startup_lock.recovery_path_for(repo)
    fs.writeFileSync(file, `${JSON.stringify(guard)}\n`)

    const blocked = startup_lock.acquire(repo)

    assert.equal(blocked.existing, true)
    assert.equal(blocked.status, 'recovery_guard_unverified')
    assert.equal(blocked.pid, guard.pid)
    assert.match(blocked.detail, /recorded process is gone.*remove only this guard/u)
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(guard)}\n`)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
