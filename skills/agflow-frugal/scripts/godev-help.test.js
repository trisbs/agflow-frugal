'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const ag_settings = require('./ag-settings.js');

const skill_root = path.resolve(__dirname, '..');
const hook = path.join(__dirname, 'stop-hook.js');
const agf = path.join(__dirname, 'agf.js');

const make_project = (host = 'codex') => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-godev-help-'));
	fs.mkdirSync(path.join(root, '.agentflow'), { recursive: true });
	fs.writeFileSync(path.join(root, '.agentflow/devlog.md'), `# STATUS

Project: godev help contract fixture.

Notebook: .agentflow/devlog.md — root.

Current commit: fixture.

Tests/scenarios: none.

Configuration: ag.json — schema v${ag_settings.schema_version}; validated for codex this round.

Proven: fixture ready.

Open: none.

Next: await the owner.

Artifacts: none.

Archived eras: none.

Streams: none.

---

# → Ask / A-001

+
`);
	ag_settings.write_config_atomic(path.join(root, 'ag.json'), ag_settings.make_template(host), {
		repo_root: root,
		active_host: host,
		executables: ['codex', 'claude'],
	});
	return root;
};

const invoke = (script, root, args, input) => {
	const env = { ...process.env };
	for (const markers of Object.values(ag_settings.host_markers)) {
		for (const marker of markers) delete env[marker];
	}
	delete env.AGENTFLOW_EXTERNAL_DELEGATE;
	env.AGENTFLOW_SESSION_ID = 'godev-help-session';
	return spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		encoding: 'utf8',
		input,
		env,
	});
};

const snapshot_tree = root => {
	const result = {};
	const visit = directory => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			const relative = path.relative(root, file).split(path.sep).join('/');
			if (entry.isDirectory()) visit(file);
			else result[relative] = fs.readFileSync(file);
		}
	};
	visit(root);
	return result;
};

test('exact godev help forms show usage without touching notebook, STATUS, or owner/session state', () => {
	for (const host of ['codex', 'claude']) {
		const root = make_project(host);
		const captured = invoke(hook, root, ['--host', host], JSON.stringify({
			cwd: root,
			hook_event_name: 'UserPromptSubmit',
			session_id: 'godev-help-session',
			turn_id: 'seed',
			prompt: 'original task',
		}));
		assert.equal(captured.status, 0, captured.stderr);
		const before = snapshot_tree(root);

		for (const [index, prompt] of ['godev help', '/godev help'].entries()) {
			const result = invoke(hook, root, ['--host', host], JSON.stringify({
				cwd: root,
				hook_event_name: 'UserPromptSubmit',
				session_id: 'godev-help-session',
				turn_id: `help-${index}`,
				prompt,
			}));
			assert.equal(result.status, 0, result.stderr);
			const output = JSON.parse(result.stdout);
			assert.match(output.systemMessage, /Agentflow usage/i);
			assert.match(output.systemMessage, /godev continue/);
			assert.match(output.systemMessage, /godev trace enable/);
			assert.match(output.systemMessage, /godev help.*\/godev help/s);
			assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
			assert.match(output.hookSpecificOutput.additionalContext, /return.*usage.*do not invoke tools.*notebook intake/i);
			assert.deepEqual(snapshot_tree(root), before, `${host} ${prompt} changed project or owner/session files`);
		}
	}
});

test('help-like task requests still use normal capture', () => {
	const root = make_project();
	const seed = invoke(hook, root, ['--host', 'codex'], JSON.stringify({
		cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'godev-help-session', turn_id: 'seed', prompt: 'original task',
	}));
	assert.equal(seed.status, 0, seed.stderr);
	const prompt = 'godev help me write a migration plan';
	const result = invoke(hook, root, ['--host', 'codex'], JSON.stringify({
		cwd: root, hook_event_name: 'UserPromptSubmit', session_id: 'godev-help-session', turn_id: 'request', prompt,
	}));
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /Agentflow usage/u);
	assert.match(fs.readFileSync(path.join(root, '.agentflow/devlog.md'), 'utf8'), /\+ godev help me write a migration plan/u);
});

test('godev continue remains an ordinary captured prompt and resumes through startup', () => {
	const root = make_project();
	const first = invoke(hook, root, ['--host', 'codex'], JSON.stringify({
		cwd: root,
		hook_event_name: 'UserPromptSubmit',
		session_id: 'godev-help-session',
		turn_id: 'seed',
		prompt: 'original task',
	}));
	assert.equal(first.status, 0, first.stderr);

	const prompt = 'godev continue';
	const captured = invoke(hook, root, ['--host', 'codex'], JSON.stringify({
		cwd: root,
		hook_event_name: 'UserPromptSubmit',
		session_id: 'godev-help-session',
		turn_id: 'continue',
		prompt,
	}));
	assert.equal(captured.status, 0, captured.stderr);
	assert.match(captured.stdout, /instruction was saved/);

	const notebook = fs.readFileSync(path.join(root, '.agentflow/devlog.md'), 'utf8');
	assert.match(notebook, /\+ original task/u);
	assert.match(notebook, /\+ godev continue/u);
	const resumed = invoke(agf, root, ['start', '--repo', root, '--host', 'codex', '--message-stdin', '--json'], prompt);
	assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
	const result = JSON.parse(resumed.stdout);
	assert.equal(result.current_ask_identifier, 'A-001');
	assert.equal(result.message.inserted, false);
	assert.match(fs.readFileSync(path.join(root, '.agentflow/devlog.md'), 'utf8'), /\+ godev continue/u);
});

test('operational skill routes exact help requests before startup and keeps continuation on normal workflow', () => {
	const skill = fs.readFileSync(path.join(skill_root, 'SKILL.md'), 'utf8');
	const help_start = skill.indexOf('For an exact `godev help`');
	const startup = skill.indexOf('## Start here');
	assert.notEqual(help_start, -1, 'skill must document the help fast path');
	assert.ok(help_start < startup, 'help routing must precede startup instructions');
	const help_rule = skill.slice(help_start, startup);
	assert.match(help_rule, /`godev help`.*`\/godev help`/s);
	assert.match(help_rule, /without starting intake, capturing an Ask/is);
	assert.match(help_rule, /godev continue.*normal notebook workflow/is);
});
