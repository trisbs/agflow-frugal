'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const test = require('node:test')
const ag_settings = require('./ag-settings.js')

const wrapper = `const fs=require('node:fs'),cp=require('node:child_process');
if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(90);
process.stdout.write('Terminal: '+cp.spawnSync('tty',[],{stdio:[0,'pipe','pipe'],encoding:'utf8'}).stdout);
process.stdout.write('Visible input: '+process.env.AGF_JOURNEY_INPUT+'\\n');
const r=cp.spawnSync(process.execPath,JSON.parse(process.env.AGF_JOURNEY_ARGS),{input:process.env.AGF_JOURNEY_INPUT,encoding:'utf8'});
if(process.env.AGF_JOURNEY_CHANNELS==='1')process.stdout.write('CHILD_STDOUT\\n'+(r.stdout||'')+'\\nCHILD_STDERR\\n'+(r.stderr||''));
else{process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');}
process.stdout.write('\\nProcess exit: '+r.status+'\\n');process.exit(r.status??91);`
const expect_script = 'set timeout 30\nlog_user 1\nspawn $env(AGF_JOURNEY_NODE) -e $env(AGF_JOURNEY_WRAPPER)\nexpect eof\nset result [wait]\nexit [lindex $result 3]'
const terminal = (root, script, args, input = '', env_overrides = {}) => {
  const result = spawnSync('/usr/bin/expect', ['-c', expect_script], { cwd: root, encoding: 'utf8', env: {
    ...process.env, CODEX_THREAD_ID: 'inherited-codex', CLAUDE_SESSION_ID: 'inherited-claude',
    AGENTFLOW_SESSION_ID: 'portable-terminal-session',
    AGF_JOURNEY_NODE: process.execPath, AGF_JOURNEY_WRAPPER: wrapper,
    AGF_JOURNEY_ARGS: JSON.stringify(script === null ? args : [path.join(__dirname, script), ...args]), AGF_JOURNEY_INPUT: input,
    ...env_overrides,
  } })
  assert.match(result.stdout, /Terminal: \/dev\/(?:tty|pts\/)/)
  assert.match(result.stdout, /Visible input:/)
  assert.match(result.stdout, new RegExp(`Process exit: ${result.status}`))
  return result
}

test('prompt-enabled route trace reports observed routing facts in a real terminal without persisting trace state', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agf-trace-pty-')))
  try {
    ag_settings.initialize_project({ repo_root: root, active_host: 'codex' })
    const facts = {
      admission_facts: {
        mechanical: true,
        requirement_clear: true,
        scope_known: true,
        reversible: true,
        deterministic_verification: true,
      },
      task: {
        task_id: 'trace-pty',
        role: 'implementation',
        executor_choice: { kind: 'host', reason: 'Use this terminal host' },
        brief: { goal: 'Verify trace output' },
        work_boundary: ['example.txt'],
        interactive_host: false,
      },
      capabilities: { host: { candidate_id: 'current-host', available: true } },
    }
    const traced = terminal(root, 'agf.js', ['route', 'plan', '--facts-stdin', '--trace'], JSON.stringify(facts), { CLAUDE_SESSION_ID: '', AGF_JOURNEY_CHANNELS: '1' })
    assert.equal(traced.status, 0, traced.stdout + traced.stderr)
    const [child_stdout, child_stderr] = traced.stdout.split(/CHILD_STDERR\r?\n/u)
    assert.match(child_stdout, /CHILD_STDOUT\r?\n\{\r?\n  "status": "selected"/u)
    assert.doesNotMatch(child_stdout, /\[agf trace\]/)
    assert.match(child_stderr, /\[agf trace\] primary \| tier=cheap \| selected=host\/current-host \| model=unknown \| effort=unknown/)
    assert.equal(fs.existsSync(path.join(root, '.agentflow', 'routing')), false)

    const quiet = terminal(root, 'agf.js', ['route', 'plan', '--facts-stdin'], JSON.stringify(facts), { CLAUDE_SESSION_ID: '' })
    assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr)
    assert.doesNotMatch(quiet.stdout, /\[agf trace\]/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const git_mode of [true, false]) test(`real terminal portable host, policy changes, pending handoff and closeout in ${git_mode ? 'Git' : 'plain'} folder`, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agf-transport-pty-')))
  if (git_mode) {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'PTY fixture'], ['config', 'user.email', 'pty@example.invalid']]) execFileSync('git', args, { cwd: root })
  }
  const start = terminal(root, 'agf.js', ['start', '--repo', root, '--host', 'example-agent', '--message-stdin', '--json'], 'portable terminal request\n')
  assert.equal(start.status, 0, start.stdout + start.stderr)
  assert.match(start.stdout, /"status": "not_available"/)
  assert.equal(fs.existsSync(path.join(root, '.codex')), false)
  assert.equal(fs.existsSync(path.join(root, '.claude')), false)
  const config_file = path.join(root, 'ag.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(config_file)).switches['allowed-worker'], ['external', 'internal', 'host'])
  const selection_program = 'const fs=require("node:fs"),route=require(process.argv[1]);const facts=JSON.parse(fs.readFileSync(0,"utf8"));facts.config=JSON.parse(fs.readFileSync("ag.json","utf8"));process.stdout.write(JSON.stringify(route.select_executor_action(facts))+"\\n")'
  for (const allowed of [['external', 'internal', 'host'], ['host', 'internal', 'external']]) {
    const reordered = terminal(root, 'ag-settings.js', ['change', '--repo', root, '--host', 'example-agent', '--set', 'allowed-worker: ' + JSON.stringify(allowed)])
    assert.equal(reordered.status, 0, reordered.stdout)
    const facts = { task: { role: 'implementation', executor_choice: { kind: 'host', reason: 'Reuse task context in the current host' } }, capabilities: { host: { candidate_id: 'host', available: true }, internal: { candidate_id: 'native', available: true } } }
    const chosen = terminal(root, null, ['-e', selection_program, path.join(__dirname, 'delegation-route.js')], JSON.stringify(facts))
    assert.equal(chosen.status, 0, chosen.stdout)
    assert.match(chosen.stdout, /"status":"selected","candidate_id":"host","kind":"host"/)
    assert.deepEqual(JSON.parse(fs.readFileSync(config_file)).switches['allowed-worker'], allowed)
  }
  const change = terminal(root, 'ag-settings.js', ['change', '--repo', root, '--host', 'example-agent', '--set', 'allowed-worker: ["host"]'])
  assert.equal(change.status, 0, change.stdout)
  const valid_config = fs.readFileSync(config_file)
  const invalid = terminal(root, 'ag-settings.js', ['change', '--repo', root, '--host', 'example-agent', '--set', 'allowed-worker: []'])
  assert.equal(invalid.status, 1)
  assert.deepEqual(fs.readFileSync(config_file), valid_config)
  const notebook = '.agentflow/devlog.md'
  const capture = terminal(root, 'notebook-write.js', ['append-input', '--notebook', notebook, '--host', 'example-agent', '--input-stdin'], 'later terminal instruction\n')
  assert.equal(capture.status, 0, capture.stdout)
  assert.match(fs.readFileSync(path.join(root, notebook), 'utf8'), /later terminal instruction/)
  const tasks = path.join(root, '.agentflow', 'planned')
  fs.mkdirSync(tasks)
  const plan_file = path.join(tasks, 'plan-001.md')
  fs.writeFileSync(plan_file, '# Pending plan\n\nCreate pending-product.txt.\n')
  const state_home = path.join(process.env.AGFLOW_TEST_HOME || os.homedir(), 'state')
  const handoff = terminal(root, 'looper.js', ['--tasks-dir', tasks, '--completion-path', notebook], '', { XDG_STATE_HOME: state_home })
  assert.equal(handoff.status, 2, handoff.stdout + handoff.stderr)
  assert.match(handoff.stdout + handoff.stderr, /interactive host/)
  assert.equal(fs.readFileSync(plan_file, 'utf8'), '# Pending plan\n\nCreate pending-product.txt.\n')
  assert.equal(fs.existsSync(path.join(tasks, 'done')), false)
  assert.equal(fs.existsSync(path.join(root, 'pending-product.txt')), false)
  // The queued plan remains a separate pending task; this round proves the
  // portable lifecycle and does not claim that plan's product was completed.
  const manifest = { version: 1, notebook, ask: 'A-001', run_events: [],
    reply: '## [SUMMARY]\n\n- Status: complete.\n- Result: startup, policy validation, manual capture, and handoff passed; the queue remains pending.\n- Owner action: none.\n- Next step: the queued plan remains for the interactive host.\n\n## [FINAL REPORT]\n\n1. Startup, policy validation, manual capture and handoff verified.\n\n```completion-metadata\nHost review: PASS — inspected the fixture and terminal results.\n```\n\n## Questions (batched — each with a suggested default)\n\n- None.\n',
    status: { project: 'portable terminal fixture', notebook, notebook_kind: 'root', current_commit: 'local delivery', tests_scenarios: 'real terminal journey', config_path: 'ag.json', host: 'example-agent', validation: 'validated', proven: 'portable lifecycle', open: 'one pending queue plan', next: 'resume queue in an interactive host', artifacts: '.agentflow/planned/plan-001.md', archived_eras: 'none', streams: [] },
    allowed_paths: [notebook, '.gitignore', 'ag.json'], commit_message: 'verify portable terminal controls', delivery: { mode: 'local' } }
  // Explicit waiver is fixture owner input, not an inferred policy fallback.
  terminal(root, 'notebook-write.js', ['append-input', '--notebook', notebook, '--host', 'example-agent', '--input-stdin'], 'skip-review: bounded terminal fixture\n')
  const close = terminal(root, 'agf.js', ['close', '--manifest-stdin'], JSON.stringify(manifest))
  assert.equal(close.status, 0, close.stdout + close.stderr)
  const text = fs.readFileSync(path.join(root, notebook), 'utf8')
  assert.match(text, /# ← Reply \/ A-001/)
  assert.match(text, /example-agent\/unknown/)
  assert.match(text, /# → Ask \/ A-002/)
  assert.equal(fs.existsSync(path.join(root, '.git')), git_mode)
})

test('generic-host startup outside project skill scope reports host-neutral hook availability', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agf-generic-start-pty-')))
  try {
    const start = terminal(root, 'agf.js', ['start', '--repo', root, '--host', 'example-agent', '--host-family', 'codex', '--message-stdin', '--json'], 'generic host startup\n', { AGF_JOURNEY_CHANNELS: '1' })
    assert.equal(start.status, 0, start.stdout + start.stderr)
    const start_stdout = start.stdout.match(/CHILD_STDOUT\r?\n([\s\S]*?)\r?\nCHILD_STDERR/)?.[1]
    assert.ok(start_stdout, start.stdout)
    const result = JSON.parse(start_stdout)
    assert.equal(result.hooks.status, 'not_available')
    assert.equal(result.hooks.host, 'example-agent')
    assert.equal(result.hooks.reason, 'no_host_hook_integration')
    assert.equal(Object.hasOwn(result.hooks, 'config_path'), false)
    assert.equal(Object.hasOwn(result.hooks, 'scope'), false)
    assert.equal(Object.hasOwn(result.hooks, 'message'), false)
    assert.match(result.hooks.instructions.capture, /capture each owner message/)
    assert.match(result.hooks.instructions.closeout, /agf\.js close/)
    assert.doesNotMatch(JSON.stringify(result.hooks), /\.claude|\.codex|project-scoped/)
    assert.equal(result.hooks_restart_required, false)
    assert.equal(fs.existsSync(path.join(root, '.codex')), false)
    assert.equal(fs.existsSync(path.join(root, '.claude')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
