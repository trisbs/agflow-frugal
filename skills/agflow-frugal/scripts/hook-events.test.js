'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const { begin, finish, read_recent, summarize } = require('./hook-events.js')

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-hook-events-'))
  fs.mkdirSync(path.join(root, '.agentflow'))
  return root
}

test('hook receipts correlate prompt and Stop events without storing session, turn, or prompt text', () => {
  const root = project()
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'private-session-id', turn_id: 'private-turn-id', prompt: 'secret owner prompt' }
  const first = begin({ root, input, host: 'codex' })
  assert.ok(first)
  assert.equal(finish(first, { outcome: 'capture_saved' }), true)
  const second = begin({ root, input: { ...input, hook_event_name: 'Stop' }, host: 'codex' })
  assert.ok(second)
  assert.equal(finish(second, { state: 'blocked', outcome: 'stop_blocked' }), true)

  const receipts = read_recent({ root, host: 'codex' })
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].event, 'Stop')
  assert.equal(receipts[0].state, 'blocked')
  assert.equal(receipts[1].outcome, 'capture_saved')
  assert.equal(receipts[0].correlation_id, receipts[1].correlation_id)
  const serialized = fs.readFileSync(first.file, 'utf8') + fs.readFileSync(second.file, 'utf8')
  assert.doesNotMatch(serialized, /private-session-id|private-turn-id|secret owner prompt/)
  assert.equal(summarize(receipts).Stop.other_event_in_session, true)
})

test('hook receipts identify repeated calls for one host session and turn', () => {
  const root = project()
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'session', turn_id: 'same-turn' }
  const first = begin({ root, input, host: 'codex' })
  const second = begin({ root, input, host: 'codex' })
  finish(first, { outcome: 'capture_saved' })
  finish(second, { outcome: 'capture_duplicate' })
  assert.equal(summarize(read_recent({ root, host: 'codex' })).UserPromptSubmit.repeated_correlation, true)
})

test('stream worktree receipts are visible from the main checkout', () => {
  const root = project()
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'hook-events@example.invalid'])
  git(['config', 'user.name', 'Hook Events'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n')
  git(['add', 'tracked.txt'])
  git(['commit', '-q', '-m', 'fixture'])
  const worktree = path.join(root, '.worktrees', 'stream')
  fs.mkdirSync(path.dirname(worktree), { recursive: true })
  git(['worktree', 'add', '-q', '-b', 'stream', worktree])

  const ticket = begin({ root: worktree, host: 'codex', input: { hook_event_name: 'Stop', session_id: 'stream-session' } })
  assert.ok(ticket)
  finish(ticket, { outcome: 'stop_passed' })
  assert.equal(read_recent({ root, host: 'codex' })[0].outcome, 'stop_passed')
  assert.equal(path.dirname(path.dirname(path.dirname(ticket.file))), path.join(root, '.agentflow'))
})

test('hook receipt writer skips missing Agentflow workspaces and rejects symlinked receipt directories', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-no-workspace-'))
  assert.equal(begin({ root: empty, input: { hook_event_name: 'Stop' }, host: 'codex' }), null)
  assert.equal(fs.existsSync(path.join(empty, '.agentflow')), false)

  const root = project()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-outside-'))
  fs.symlinkSync(outside, path.join(root, '.agentflow', '.tmp'))
  assert.throws(() => begin({ root, input: { hook_event_name: 'Stop' }, host: 'codex' }), /regular local directory/)
  assert.deepEqual(read_recent({ root, host: 'codex' }), [])
  assert.equal(fs.readdirSync(outside).length, 0)
})
