'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const hook = path.join(__dirname, 'stop-hook.js');
const hook_events = require('./hook-events');
const state_without_event_receipts = directory => fs.readdirSync(directory, { recursive: true })
  .filter(name => !String(name).split(path.sep).includes('hook-events'))
  .filter(name => fs.statSync(path.join(directory, name)).isFile())
  .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]);

test('retired one-shot Codex trace prompts direct owners to persistent mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-trace-'));
  const file = path.join(root, '.agentflow/devlog.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '# → Ask / A-044\n\n+ existing request\n');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];

  const invoke = prompt => spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-session', turn_id: prompt, model: 'gpt-6.1-sol', prompt }),
    env, cwd: root, encoding: 'utf8',
  });
  for (const command of ['godev trace', 'godev trace full']) {
    const retired = invoke(command);
    assert.equal(retired.status, 0, retired.stderr);
    const output = JSON.parse(retired.stdout);
    assert.match(output.systemMessage, /ONE-SHOT RETIRED/);
    assert.match(output.systemMessage, /godev trace enable.*godev trace disable/s);
    assert.doesNotMatch(output.systemMessage, /CURRENT MODEL|TASK CLASS/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /For this godev trace/);
  }

  const ordinary = invoke('godev continue');
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const ordinary_output = JSON.parse(ordinary.stdout);
  assert.equal(Object.hasOwn(ordinary_output, 'systemMessage'), false);
  assert.doesNotMatch(ordinary_output.hookSpecificOutput.additionalContext, /trace task/);
});

test('Codex trace enable persists across prompts until disable without tracing toggle prompts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-trace-mode-'));
  const file = path.join(root, '.agentflow/devlog.md');
  const mode_file = path.join(root, '.agentflow/.tmp/trace-mode.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# → Ask / A-044\n\n+ existing request\n');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  const invoke = prompt => spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-mode-session', turn_id: prompt, model: 'gpt-6.1-sol', prompt }),
    env, cwd: root, encoding: 'utf8',
  });

  const enabled = invoke('godev trace enable');
  assert.equal(enabled.status, 0, enabled.stderr);
  const enabled_output = JSON.parse(enabled.stdout);
  assert.match(enabled_output.systemMessage, /TRACE MODE.*ENABLED/is);
  assert.match(enabled_output.systemMessage, /40.?70 tokens/i);
  assert.match(enabled_output.hookSpecificOutput.additionalContext, /Retain trace=on in this session/);
  assert.match(enabled_output.hookSpecificOutput.additionalContext, /replaces earlier trace instructions/);
  assert.doesNotMatch(enabled_output.hookSpecificOutput.additionalContext, /For this godev trace/);
  assert.deepEqual(JSON.parse(fs.readFileSync(mode_file, 'utf8')), { version: 1, enabled: true });

  const retired = invoke('godev trace');
  assert.equal(retired.status, 0, retired.stderr);
  const retired_output = JSON.parse(retired.stdout);
  assert.match(retired_output.systemMessage, /ONE-SHOT RETIRED/);
  assert.doesNotMatch(retired_output.systemMessage, /CURRENT MODEL|TASK CLASS/);

  const traced = invoke('ordinary task prompt');
  assert.equal(traced.status, 0, traced.stderr);
  const traced_output = JSON.parse(traced.stdout);
  assert.match(traced_output.systemMessage, /AGF TRACE — CURRENT RUN/);
  assert.match(traced_output.hookSpecificOutput.additionalContext, /For this godev trace/);
  assert.match(traced_output.systemMessage, /CURRENT MODEL: \*\*gpt-6\.1-sol\*\*/);

  const disabled = invoke('godev trace disable');
  assert.equal(disabled.status, 0, disabled.stderr);
  const disabled_output = JSON.parse(disabled.stdout);
  assert.match(disabled_output.systemMessage, /TRACE MODE.*DISABLED/is);
  assert.match(disabled_output.hookSpecificOutput.additionalContext, /Retain trace=off in this session/);
  assert.match(disabled_output.hookSpecificOutput.additionalContext, /replaces earlier trace instructions/);
  assert.match(disabled_output.hookSpecificOutput.additionalContext, /Do not print task\/model trace.*until a successful enable/is);
  assert.doesNotMatch(disabled_output.hookSpecificOutput.additionalContext, /For this godev trace/);
  assert.deepEqual(JSON.parse(fs.readFileSync(mode_file, 'utf8')), { version: 1, enabled: false });

  for (const prompt of ['ordinary task after disable', 'second ordinary task after disable']) {
    const ordinary = invoke(prompt);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    const ordinary_output = JSON.parse(ordinary.stdout);
    assert.equal(Object.hasOwn(ordinary_output, 'systemMessage'), false);
    assert.doesNotMatch(ordinary_output.hookSpecificOutput.additionalContext, /trace=|For this godev trace/);
  }

  const reenabled = invoke('godev trace enable');
  assert.equal(reenabled.status, 0, reenabled.stderr);
  assert.match(JSON.parse(reenabled.stdout).hookSpecificOutput.additionalContext, /Retain trace=on in this session/);
  const resumed = invoke('ordinary task after reenable');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(JSON.parse(resumed.stdout).systemMessage, /AGF TRACE — CURRENT RUN/);
});

test('a failed trace disable preserves enabled state and the retained session instruction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-trace-toggle-fault-'));
  const mode_file = path.join(root, '.agentflow/.tmp/trace-mode.json');
  const preload = path.join(root, 'rename-fault.cjs');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  const invoke = (prompt, fault = false) => spawnSync(process.execPath, [...(fault ? ['--require', preload] : []), hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-toggle-fault', model: 'gpt-6.1-sol', prompt }),
    env, cwd: root, encoding: 'utf8',
  });
  const enabled = invoke('godev trace enable');
  assert.equal(enabled.status, 0, enabled.stderr);
  const before = fs.readFileSync(mode_file, 'utf8');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target === ${JSON.stringify(mode_file)}) throw Object.assign(new Error('injected read-only state'), { code: 'EROFS' });
  return rename(source, target);
};\n`);
  const failed = invoke('godev trace disable', true);
  assert.equal(failed.status, 0, failed.stderr);
  const output = JSON.parse(failed.stdout);
  assert.match(output.systemMessage, /CHANGE FAILED/);
  assert.match(output.hookSpecificOutput.additionalContext, /Keep the last successful session trace state/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Retain trace=off/);
  assert.equal(fs.readFileSync(mode_file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(mode_file)).filter(name => name.endsWith('.tmp')), []);
  const ordinary = invoke('ordinary task after failed disable');
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(JSON.parse(ordinary.stdout).systemMessage, /AGF TRACE — CURRENT RUN/);
});

test('Codex persistent trace controls work in a clean folder without a devlog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-trace-clean-'));
  const mode_file = path.join(root, '.agentflow/.tmp/trace-mode.json');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  const invoke = prompt => spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'clean-trace-session', turn_id: prompt, model: 'gpt-6.1-sol', prompt }),
    env, cwd: root, encoding: 'utf8',
  });

  const enabled = invoke('godev trace enable');
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(JSON.parse(enabled.stdout).systemMessage, /TRACE MODE.*ENABLED/is);
  assert.deepEqual(JSON.parse(fs.readFileSync(mode_file, 'utf8')), { version: 1, enabled: true });

  const traced = invoke('ordinary prompt in a clean folder');
  assert.equal(traced.status, 0, traced.stderr);
  assert.match(JSON.parse(traced.stdout).systemMessage, /AGF TRACE — CURRENT RUN/);
  assert.match(JSON.parse(traced.stdout).hookSpecificOutput.additionalContext, /For this godev trace/);

  const disabled = invoke('godev trace disable');
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(JSON.parse(disabled.stdout).systemMessage, /TRACE MODE.*DISABLED/is);
  assert.deepEqual(JSON.parse(fs.readFileSync(mode_file, 'utf8')), { version: 1, enabled: false });

  const ordinary = invoke('ordinary prompt after disable');
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(ordinary.stdout, '');
});

test('Codex persistent trace defaults off, is checkout-local, and fails closed on malformed state', () => {
  const make_checkout = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-trace-isolation-'));
    const file = path.join(root, '.agentflow/devlog.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# → Ask / A-044\n\n+ existing request\n');
    return root;
  };
  const first = make_checkout();
  const second = make_checkout();
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  const invoke = (root, prompt) => spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-isolation-session', turn_id: prompt, model: 'gpt-6.1-sol', prompt }),
    env, cwd: root, encoding: 'utf8',
  });

  const enabled = invoke(first, 'godev trace enable');
  assert.equal(enabled.status, 0, enabled.stderr);
  const other_checkout = invoke(second, 'ordinary task prompt');
  assert.equal(other_checkout.status, 0, other_checkout.stderr);
  assert.equal(Object.hasOwn(JSON.parse(other_checkout.stdout), 'systemMessage'), false);

  const mode_file = path.join(second, '.agentflow/.tmp/trace-mode.json');
  fs.mkdirSync(path.dirname(mode_file), { recursive: true });
  fs.writeFileSync(mode_file, '{broken');
  const malformed = invoke(second, 'ordinary task after malformed state');
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(Object.hasOwn(JSON.parse(malformed.stdout), 'systemMessage'), false);
  assert.doesNotMatch(JSON.parse(malformed.stdout).hookSpecificOutput.additionalContext, /For this godev trace/);
});

test('Codex status prompt requests a read-only devlog summary with explicit approval gates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-status-'));
  const file = path.join(root, '.agentflow/devlog.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '# → Ask / A-044\n\n+ existing request\n');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  const result = spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'status-session', turn_id: 'status', prompt: 'godev status' }),
    env, cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /configured devlog.*STATUS, open Ask and latest RUN\/Reply/i);
  assert.match(output.hookSpecificOutput.additionalContext, /follow only its direct task\/design links/i);
  assert.match(output.hookSpecificOutput.additionalContext, /Awaiting owner approval.*Awaiting work\/checks.*Blocked/is);
  assert.match(output.hookSpecificOutput.additionalContext, /Never infer approval from unfinished work or stale STATUS/i);
  assert.equal(Object.hasOwn(output, 'systemMessage'), false);
  const ordinary = spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'status-session', turn_id: 'ordinary', prompt: 'godev continue' }),
    env, cwd: root, encoding: 'utf8',
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.doesNotMatch(JSON.parse(ordinary.stdout).hookSpecificOutput.additionalContext, /Awaiting owner approval/);
});

test('Codex persistent trace reports unavailable for secret-shaped model identifiers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-trace-redact-'));
  const file = path.join(root, '.agentflow/devlog.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '# → Ask / A-044\n\n+ existing request\n');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  const enabled = spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-session', turn_id: 'enable', prompt: 'godev trace enable' }),
    env, cwd: root, encoding: 'utf8',
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  const result = spawnSync(process.execPath, [hook, '--host', 'codex'], {
    input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-session', turn_id: 'redact', model: 'access_token-secret', prompt: 'ordinary task prompt' }),
    env, cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /CURRENT MODEL: \*\*unavailable\*\*/);
  assert.doesNotMatch(output.systemMessage + output.hookSpecificOutput.additionalContext, /access_token-secret/);
});

test('Codex persistent trace notice reports unavailable when the current hook omits or malforms its model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-trace-model-unavailable-'));
  const file = path.join(root, '.agentflow/devlog.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '# → Ask / A-044\n\n+ existing request\n');
  const env = { ...process.env };
  for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
  for (const model of [undefined, 'GPT 5', { model: 'gpt-6.1-sol' }]) {
    const enable = spawnSync(process.execPath, [hook, '--host', 'codex'], {
      input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-session', turn_id: 'enable', prompt: 'godev trace enable' }),
      env, cwd: root, encoding: 'utf8',
    });
    assert.equal(enable.status, 0, enable.stderr);
    const input = { cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'trace-session', turn_id: String(model), prompt: 'ordinary task prompt' };
    if (model !== undefined) input.model = model;
    const result = spawnSync(process.execPath, [hook, '--host', 'codex'], {
      input: JSON.stringify(input), env, cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /CURRENT MODEL: \*\*unavailable\*\*/);
    assert.match(output.hookSpecificOutput.additionalContext, /active-model source was unavailable/i);
    assert.doesNotMatch(output.systemMessage + output.hookSpecificOutput.additionalContext, /GPT 5|gpt-6\.1-sol/u);
  }
});

for (const host of ['codex', 'claude']) {
  for (const [label, notebook] of [
    ['completed round', '# → Ask / A-042\n\n+ previous request\n\n# ← Reply / A-042\n\nPrevious answer.\n'],
    ['alternate Reply heading', '# → Ask / A-042\n\n+ previous request\n\n## Reply / A-042 — accepted pilot\n\nPrevious answer.\n'],
    ['missing Ask', '# STATUS\n\nDamaged notebook without an Ask.\n'],
  ]) {
    test(`${host} lets an owner request repair of ${label} without changing history`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-prompt-recovery-'));
      const file = path.join(root, '.agentflow/devlog.md');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, notebook);
      const env = { ...process.env };
      for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
      const input = JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'repair-session', turn_id: 'repair-turn', prompt: 'Fix the missing Ask now.' });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = spawnSync(process.execPath, [hook, '--host', host], { input, env, cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const context = JSON.parse(result.stdout).hookSpecificOutput;
        assert.equal(context.hookEventName, 'UserPromptSubmit');
        assert.match(context.additionalContext, /not saved.*no open Ask/i);
        assert.match(context.additionalContext, /repair/i);
        assert.doesNotMatch(context.additionalContext, /instruction was saved/i);
        assert.equal(fs.readFileSync(file, 'utf8'), notebook);
        assert.deepEqual(state_without_event_receipts(path.dirname(file)), [['devlog.md', notebook]]);
      }
      const receipts = hook_events.read_recent({ root, host });
      assert.equal(receipts.length, 2);
      assert.ok(receipts.every(receipt => receipt.outcome === 'capture_not_saved'));
      assert.equal(JSON.stringify(receipts).includes('Fix the missing Ask now.'), false);
    });
  }
}

for (const host of ['codex', 'claude']) {
  for (const owned of [false, true]) {
    test(host + ' delivers input when notebook ownership is ' + (owned ? 'foreign' : 'unknown'), () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-owner-recovery-'));
      const file = path.join(root, '.agentflow/devlog.md');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, '# → Ask / A-044\n\n+\n');
      if (owned) {
        const env = { ...process.env };
        for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID']) delete env[name];
        const setup = spawnSync(process.execPath, ['-e', "require(process.argv[1]).guard({ root: process.argv[2], notebook: '.agentflow/devlog.md', host: process.argv[3], session: 'other-session' })", path.join(__dirname, 'notebook-owner.js'), root, host], { env, encoding: 'utf8' });
        assert.equal(setup.status, 0, setup.stderr);
      }
      const notebook = '# → Ask / A-044\n\n+ manually entered request\n';
      fs.writeFileSync(file, notebook);
      const snapshot = () => state_without_event_receipts(path.dirname(file));
      const before = snapshot();
      const env = { ...process.env };
      for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
      for (const prompt of ['godev', 'no-ag, fix this hook', 'hello']) {
        const result = spawnSync(process.execPath, [hook, '--host', host], { input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'repair-session', prompt }), env, cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
        assert.match(notice, /not saved.*ownership/i);
        assert.match(notice, /Continue with the submitted request/);
        assert.deepEqual(snapshot(), before);
      }
      const receipts = hook_events.read_recent({ root, host });
      assert.equal(receipts.length, 3);
      assert.ok(receipts.every(receipt => receipt.outcome === 'capture_owner_conflict'));
      assert.doesNotMatch(JSON.stringify(receipts), /godev|no-ag|hello/u);
    });
  }
}

for (const host of ['codex', 'claude']) {
  for (const fault of ['lock contention', 'notebook is a directory', 'oversized input']) {
    test(`${host} delivers repair requests despite ${fault}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-intake-fault-'));
      const file = path.join(root, '.agentflow/devlog.md');
      fs.mkdirSync(path.dirname(file));
      const notebook = '# → Ask / A-044\n\n+\n';
      if (fault === 'notebook is a directory') fs.mkdirSync(file);
      else fs.writeFileSync(file, notebook);
      if (fault === 'lock contention') fs.writeFileSync(file + '.close-round.lock', 'existing lock\n');
      const env = { ...process.env };
      for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
      // A regular stdin descriptor keeps this size-boundary test independent of
      // synchronous pipe transfer in the process-isolated Node test runner.
      const input_file = path.join(root, 'hook-input.json');
      fs.writeFileSync(input_file, JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'repair-session', prompt: fault === 'oversized input' ? 'x'.repeat(65537) : 'no-ag, repair intake' }));
      const input_fd = fs.openSync(input_file, 'r');
      let result;
      try {
        result = spawnSync(process.execPath, [hook, '--host', host], { stdio: [input_fd, 'pipe', 'pipe'], env, cwd: root, encoding: 'utf8', timeout: 30000 });
      } finally { fs.closeSync(input_fd); }
      assert.equal(result.status, 0, result.stderr);
      const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(notice, /capture did not complete/i);
      assert.match(notice, /Continue with the submitted request/);
      assert.doesNotMatch(notice, /instruction was saved/i);
      if (fault !== 'notebook is a directory') assert.equal(fs.readFileSync(file, 'utf8'), notebook);
      if (fault === 'lock contention') assert.equal(fs.readFileSync(file + '.close-round.lock', 'utf8'), 'existing lock\n');
    });
  }
}

for (const host of ['codex', 'claude']) {
  test(`${host} reports uncertain capture after a post-save failure and preserves retry deduplication`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-post-save-'));
    const file = path.join(root, '.agentflow/devlog.md');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '# → Ask / A-044\n\n+\n');
    const preload = path.join(root, 'fault.cjs');
    fs.writeFileSync(preload, `require(${JSON.stringify(path.join(__dirname, 'fast-lane.js'))}).parse_fast_lane = () => { throw Error('synthetic post-save failure'); };\n`);
    const env = { ...process.env };
    for (const name of ['AGENTFLOW_EXTERNAL_DELEGATE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'AGENTFLOW_SESSION_ID', 'CLAUDE_PROJECT_DIR']) delete env[name];
    const input = JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'repair-session', turn_id: 'same-turn', prompt: 'unique saved instruction' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(process.execPath, ['--require', preload, hook, '--host', host], { input, env, cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const notice = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(notice, /may already be saved/);
      assert.equal(fs.readFileSync(file, 'utf8').split('+ unique saved instruction').length - 1, 1);
    }
  });
}
