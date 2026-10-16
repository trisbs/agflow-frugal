'use strict';

// Tests for install-hook.js: both host targets, idempotent add, clean remove,
// host filtering, quiet mode, and preservation of unrelated settings.
// Each test runs the real script in a throwaway directory (project scope only,
// so the tester's own ~/.claude and ~/.codex are never touched).

const test = require('node:test');
const assert = require('node:assert');
const node_fs = require('node:fs');
const node_os = require('node:os');
const node_path = require('node:path');
const { execFileSync } = require('node:child_process');

const script = node_path.join(__dirname, 'install-hook.js');

const run = (cwd, args, env = process.env) => execFileSync('node', [script, ...args], { cwd, env, encoding: 'utf8' });

const fresh_dir = () => node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), 'agentflow-hook-'));

const read_json = file_path => JSON.parse(node_fs.readFileSync(file_path, 'utf8'));

const has_our_stop_hook = config => Array.isArray(config.hooks && config.hooks.Stop)
  && config.hooks.Stop.some(entry => Array.isArray(entry.hooks)
    && entry.hooks.some(hook => typeof hook.command === 'string' && hook.command.includes('stop-hook.js')));

test('project install writes both host configs', () => {
  const dir = fresh_dir();

  run(dir, ['--project', '--quiet']);

  const claude = read_json(node_path.join(dir, '.claude', 'settings.json'));
  const codex = read_json(node_path.join(dir, '.codex', 'hooks.json'));
  assert.ok(has_our_stop_hook(claude));
  assert.ok(has_our_stop_hook(codex));
  assert.equal(codex.hooks.UserPromptSubmit.length, 1);
  assert.equal(claude.hooks.UserPromptSubmit.length, 1);
  assert.match(claude.hooks.Stop[0].hooks[0].command, /--host claude$/);
  assert.match(codex.hooks.Stop[0].hooks[0].command, /--host codex$/);
});

test('project install does not claim an old host-neutral hook command', () => {
  const dir = fresh_dir();
  const config_path = node_path.join(dir, '.codex', 'hooks.json');
  node_fs.mkdirSync(node_path.dirname(config_path), { recursive: true });
  const old_command = 'node "/old/stop-hook.js"';
  node_fs.writeFileSync(config_path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: old_command }] }] } }));

  run(dir, ['--project', '--host', 'codex', '--quiet']);

  const config = read_json(config_path);
  assert.equal(config.hooks.Stop[0].hooks[0].command, old_command);
  assert.equal(config.hooks.Stop.length, 2);
  assert.match(config.hooks.Stop[1].hooks[0].command, /stop-hook\.js['"] --host codex$/);
});

test('owned hook parsing recognizes shell-literal paths with metacharacters and apostrophes', () => {
  const hooks = require('./install-hook.js');
  const script_path = "/tmp/agentflow-$draft`id`'quote/stop-hook.js";
  const escaped = `'${script_path.replaceAll("'", "'\\''")}'`;
  const parsed = hooks.parse_owned_command(`node ${escaped} --host claude`);
  assert.equal(parsed.host, 'claude');
  assert.equal(parsed.script, node_path.resolve(script_path));
  assert.match(hooks.hook_command_for('claude'), /^node '/);
});

test('running twice never duplicates the entry', () => {
  const dir = fresh_dir();

  run(dir, ['--project', '--quiet']);
  run(dir, ['--project', '--quiet']);

  const claude = read_json(node_path.join(dir, '.claude', 'settings.json'));
  const codex = read_json(node_path.join(dir, '.codex', 'hooks.json'));

  assert.strictEqual(claude.hooks.Stop.length, 1);
  assert.strictEqual(codex.hooks.Stop.length, 1);
  assert.strictEqual(codex.hooks.UserPromptSubmit.length, 1);
});

test('project install replaces stale worktree hooks and collapses owned duplicates', () => {
  const dir = node_fs.realpathSync(fresh_dir());
  const config_path = node_path.join(dir, '.codex', 'hooks.json');
  const stale = `node "${node_path.join(dir, '.worktrees', 'fix-2', 'skills', 'agentflow', 'scripts', 'stop-hook.js')}" --host codex`;
  const current = `node '${node_path.join(__dirname, 'stop-hook.js')}' --host codex`;
  const foreign = { type: 'command', command: 'foreign-command --keep' };
  node_fs.mkdirSync(node_path.dirname(config_path), { recursive: true });
  node_fs.writeFileSync(config_path, `${JSON.stringify({ hooks: { Stop: [
    { matcher: 'stale', hooks: [{ type: 'command', command: stale }, foreign] },
    { hooks: [{ type: 'command', command: current }] }
  ] } }, null, 2)}\n`);

  run(dir, ['--project', '--host', 'codex', '--quiet']);

  const config = read_json(config_path);
  assert.strictEqual(config.hooks.Stop.length, 1);
  assert.deepEqual(config.hooks.Stop[0], {
    matcher: 'stale',
    hooks: [{ type: 'command', command: current }, foreign]
  });
});

test('--off removes the entry from both hosts', () => {
  const dir = fresh_dir();

  run(dir, ['--project', '--quiet']);
  run(dir, ['--project', '--off', '--quiet']);

  assert.ok(!has_our_stop_hook(read_json(node_path.join(dir, '.claude', 'settings.json'))));
  assert.ok(!has_our_stop_hook(read_json(node_path.join(dir, '.codex', 'hooks.json'))));
});

test('--host codex touches only the codex config', () => {
  const dir = fresh_dir();

  run(dir, ['--project', '--host', 'codex', '--quiet']);

  assert.ok(has_our_stop_hook(read_json(node_path.join(dir, '.codex', 'hooks.json'))));
  assert.ok(!node_fs.existsSync(node_path.join(dir, '.claude', 'settings.json')));
});

test('verify reports missing hooks and an explicit installation command without writing config', () => {
  const dir = fresh_dir();
  const result = require('./install-hook.js').verify({ cwd: dir, hosts: ['codex'], scope: 'project' });
  assert.equal(result.status, 'missing');
  assert.equal(result.config_path, node_path.join(dir, '.codex', 'hooks.json'));
  assert.deepEqual(result.missing_events, ['Stop', 'UserPromptSubmit']);
  assert.match(result.message, /agf hooks --project --host codex/u);
  assert.equal(node_fs.existsSync(result.config_path), false, 'verification must not write host configuration');
});

test('verify respects installation scope and reports malformed config without modifying it', () => {
  const dir = fresh_dir();
  run(dir, ['--project', '--host', 'codex', '--quiet']);
  assert.equal(require('./install-hook.js').verify({ cwd: dir, hosts: ['codex'], scope: 'project' }).status, 'available');
  assert.equal(require('./install-hook.js').verify({ cwd: dir, hosts: ['codex'], scope: 'global' }).status, 'missing');
  const file = node_path.join(dir, '.codex', 'hooks.json');
  node_fs.writeFileSync(file, '{broken');
  const invalid = require('./install-hook.js').verify({ cwd: dir, hosts: ['codex'], scope: 'project' });
  assert.equal(invalid.status, 'missing');
  assert.equal(invalid.reason, 'invalid_config');
  assert.equal(node_fs.readFileSync(file, 'utf8'), '{broken');
});

test('global install and verification use only the disposable home config', () => {
  const home = fresh_dir();
  const cwd = fresh_dir();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  run(cwd, ['--global', '--host', 'codex', '--quiet'], env);
  const global_path = node_path.join(home, '.codex', 'hooks.json');
  assert.ok(has_our_stop_hook(read_json(global_path)));
  assert.equal(node_fs.existsSync(node_path.join(cwd, '.codex', 'hooks.json')), false);
  assert.equal(require('./install-hook.js').verify({ cwd, home, hosts: ['codex'], scope: 'global' }).config_path, global_path);
  assert.equal(require('./install-hook.js').verify({ cwd, home, hosts: ['codex'], scope: 'global' }).status, 'available');
});

test('scope detection distinguishes global installs, project boundaries, and unrelated folders', () => {
  const root = fresh_dir();
  const home = fresh_dir();
  const project_skill = node_path.join(root, '.agents', 'skills', 'agflow-frugal');
  const global_skill = node_path.join(home, '.agents', 'skills', 'agflow-frugal');
  const detect = require('./install-hook.js').scope_for_skill;
  assert.equal(detect({ skill_dir: project_skill, cwd: node_path.join(root, 'nested'), home }).scope, 'project');
  assert.equal(detect({ skill_dir: project_skill, cwd: fresh_dir(), home }).scope, 'outside_project');
  assert.equal(detect({ skill_dir: global_skill, cwd: fresh_dir(), home }).scope, 'global');
});

test('project scope includes linked worktrees of the installed project only', () => {
  const root = fresh_dir();
  const foreign = fresh_dir();
  const home = fresh_dir();
  const project_skill = node_path.join(root, '.agents', 'skills', 'agflow-frugal');
  const detect = require('./install-hook.js').scope_for_skill;
  const git = (cwd, args) => require('node:child_process').execFileSync('git', args, { cwd, stdio: 'ignore' });
  for (const dir of [root, foreign]) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'scope@example.invalid']);
    git(dir, ['config', 'user.name', 'Scope test']);
    node_fs.writeFileSync(node_path.join(dir, 'tracked.txt'), 'scope test\n');
    git(dir, ['add', 'tracked.txt']);
    git(dir, ['commit', '-q', '-m', 'initial']);
  }
  const linked = node_path.join(root, 'linked-worktree');
  git(root, ['worktree', 'add', '-q', '-b', 'stream', linked]);
  try {
    assert.equal(detect({ skill_dir: project_skill, cwd: linked, home }).scope, 'project');
    assert.equal(detect({ skill_dir: project_skill, cwd: foreign, home }).scope, 'outside_project');
  } finally {
    require('node:child_process').execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: root, stdio: 'ignore' });
  }
});

test('--off removes only the owned nested command and preserves siblings and entry metadata', () => {
  const dir = fresh_dir();
  const config_path = node_path.join(dir, '.claude', 'settings.json');
  const owned_command = `node "${node_path.join(__dirname, 'stop-hook.js')}" --host claude`;
  const retained_entry = {
    matcher: 'mixed',
    description: 'keep this metadata',
    hooks: [
      { type: 'command', command: owned_command },
      { type: 'command', command: 'foreign-command --keep' },
    ],
  };
  const other_entry = { matcher: 'other', hooks: [{ type: 'command', command: 'other-command --keep' }] };
  node_fs.mkdirSync(node_path.dirname(config_path), { recursive: true });
  node_fs.writeFileSync(config_path, `${JSON.stringify({ hooks: { Stop: [retained_entry, other_entry] } }, null, 2)}\n`);

  run(dir, ['--project', '--host', 'claude', '--off', '--quiet']);

  const config = read_json(config_path);
  assert.deepEqual(config.hooks.Stop, [
    { ...retained_entry, hooks: [retained_entry.hooks[1]] },
    other_entry,
  ]);
});

test('--off retains a same-filename foreign Stop command', () => {
  const dir = fresh_dir();
  const config_path = node_path.join(dir, '.claude', 'settings.json');
  const foreign = `node "/foreign/stop-hook.js" --host claude`;
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } };
  node_fs.mkdirSync(node_path.dirname(config_path), { recursive: true });
  node_fs.writeFileSync(config_path, `${JSON.stringify(original, null, 2)}\n`);

  run(dir, ['--project', '--host', 'claude', '--off', '--quiet']);

  assert.deepEqual(read_json(config_path), original);
});

test('unrelated settings survive an install and a removal', () => {
  const dir = fresh_dir();
  const settings_path = node_path.join(dir, '.claude', 'settings.json');

  node_fs.mkdirSync(node_path.dirname(settings_path), { recursive: true });
  node_fs.writeFileSync(settings_path, JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ hooks: [] }] } }));

  run(dir, ['--project', '--quiet']);
  run(dir, ['--project', '--off', '--quiet']);

  const config = read_json(settings_path);

  assert.strictEqual(config.model, 'opus');
  assert.ok(Array.isArray(config.hooks.PostToolUse));
  assert.ok(!has_our_stop_hook(config));
});

test('--quiet prints nothing; normal mode prints per-host lines', () => {
  const quiet_output = run(fresh_dir(), ['--project', '--quiet']);
  const loud_output = run(fresh_dir(), ['--project']);

  assert.strictEqual(quiet_output, '');
  assert.match(loud_output, /claude: added/);
  assert.match(loud_output, /codex: added/);
  assert.match(loud_output, /not a repository — the pre-commit devlog guard was skipped/);
});

// ---------- the git pre-commit devlog guard ----------

const fresh_repo = () => {
  const dir = fresh_dir();

  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });

  return dir;
};

const pre_commit_path = dir => node_path.join(dir, '.git', 'hooks', 'pre-commit');

test('project install writes the pre-commit guard in a git repo, idempotently', () => {
  const dir = fresh_repo();

  run(dir, ['--project', '--quiet']);

  const written = node_fs.readFileSync(pre_commit_path(dir), 'utf8');

  assert.match(written, /agentflow devlog-guard/);
  assert.match(written, /devlog-guard\.js/);
  assert.ok(node_fs.statSync(pre_commit_path(dir)).mode & 0o100, 'the hook is executable');

  run(dir, ['--project', '--quiet']);
  assert.strictEqual(node_fs.readFileSync(pre_commit_path(dir), 'utf8'), written);
});

test('--off removes the guard; a foreign pre-commit hook is never touched', () => {
  const dir = fresh_repo();

  run(dir, ['--project', '--quiet']);
  run(dir, ['--project', '--off', '--quiet']);
  assert.ok(!node_fs.existsSync(pre_commit_path(dir)));

  node_fs.writeFileSync(pre_commit_path(dir), '#!/bin/sh\necho mine\n', { mode: 0o755 });

  const output = run(dir, ['--project']);

  assert.match(output, /left untouched/);
  assert.strictEqual(node_fs.readFileSync(pre_commit_path(dir), 'utf8'), '#!/bin/sh\necho mine\n');

  run(dir, ['--project', '--off', '--quiet']);
  assert.strictEqual(node_fs.readFileSync(pre_commit_path(dir), 'utf8'), '#!/bin/sh\necho mine\n');
});

test('--off leaves a changed Agentflow guard untouched and gives manual-removal instructions', () => {
  const dir = fresh_repo();

  run(dir, ['--project', '--quiet']);
  const changed = `${node_fs.readFileSync(pre_commit_path(dir), 'utf8')}echo user command\n`;
  node_fs.writeFileSync(pre_commit_path(dir), changed, { mode: 0o755 });

  const output = run(dir, ['--project', '--off']);

  assert.match(output, /left untouched/i);
  assert.match(output, /manual/i);
  assert.strictEqual(node_fs.readFileSync(pre_commit_path(dir), 'utf8'), changed);
});

test('inspect lists only verified owned hooks and --off removes a stale project-worktree Stop hook', () => {
  const dir = fresh_repo();
  const config_path = node_path.join(dir, '.codex', 'hooks.json');
  const stale = `node "${node_path.join(dir, '.worktrees', 'old', 'skills', 'agentflow', 'scripts', 'stop-hook.js')}" --host codex`;
  node_fs.mkdirSync(node_path.dirname(config_path), { recursive: true });
  node_fs.writeFileSync(config_path, `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: stale }] }] } }, null, 2)}\n`);

  assert.deepEqual(require('./install-hook.js').inspect({ cwd: dir, hosts: ['codex'] }), [
    `remove the verified Agentflow Stop hook from ${config_path}`,
  ]);
  run(dir, ['--project', '--host', 'codex', '--off', '--quiet']);
  assert.deepEqual(require('./install-hook.js').inspect({ cwd: dir, hosts: ['codex'] }), []);
});
