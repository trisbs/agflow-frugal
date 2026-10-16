'use strict';

// Agentflow Stop-hook referee.
//
// The host CLI runs this after the model ends its turn. It is an independent
// final check of the facts that the host can read, and it fails open if its own
// infrastructure has an error. The same completion-context collector is used
// by the earlier candidate check, but this invocation gathers its own final
// snapshot after the Reply has been written.

const node_fs = require('node:fs');
const node_path = require('node:path');
const { lint_round, parse_devlog } = require('./round-linter');
const { collect } = require('./completion-context');

const external_delegate_marker_pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const retired_trace_prompt = prompt => /^\s*\/?godev\s+trace(?:\s+full)?\s*$/iu.test(String(prompt || ''));
const trace_mode_command = prompt => {
  const match = /^\s*\/?godev\s+trace\s+(enable|disable)\s*$/iu.exec(String(prompt || ''));
  return match ? match[1].toLowerCase() === 'enable' : null;
};
const status_prompt = prompt => /^\s*\/?godev\s+status\s*$/iu.test(String(prompt || ''));
const help_prompt = prompt => /^\s*\/?godev\s+help\s*$/iu.test(String(prompt || ''));
const help_usage = [
	'Agentflow usage',
	'',
	'- Start or describe work: `godev` followed by your request.',
	'- Resume the current task: `godev continue` or `godev next`.',
	'- Show this help: `godev help` or `/godev help`.',
	'- Keep one task with the main assistant: `fast-lane <task>`.',
	'- Check the current task: `godev status`.',
	'- In Codex, enable or disable prompt tracing: `godev trace enable` or `godev trace disable`.',
	'- Start a feature workspace: `new-feature: <name>` followed by the requested work.',
].join('\n');

const status_context = input => input.hook_event_name === 'UserPromptSubmit' && status_prompt(input.prompt)
  ? 'For this godev status request, read the configured devlog (STATUS, open Ask and latest RUN/Reply); follow only its direct task/design links for approval gates. Summarize the task, latest evidence and next action. Separate Awaiting owner approval (explicit unresolved gates only) from Awaiting work/checks and Blocked. Never infer approval from unfinished work or stale STATUS; flag STATUS/round conflicts. Say “None found” when none is pending. Read-only beyond normal capture; no workers or extra tools solely for status.'
  : '';

const trace_mode_path = project_dir => node_path.join(project_dir, '.agentflow', '.tmp', 'trace-mode.json');

const read_trace_mode = project_dir => {
  const file = trace_mode_path(project_dir);
  try {
    const file_stat = node_fs.lstatSync(file);
    if (!file_stat.isFile() || file_stat.isSymbolicLink()) return false;
    const mode = JSON.parse(node_fs.readFileSync(file, 'utf8'));
    return mode?.version === 1 && mode.enabled === true;
  } catch (error) {
    return false;
  }
};

const write_trace_mode = (project_dir, enabled) => {
  const project_root = node_fs.realpathSync(project_dir);
  const workspace = node_path.join(project_root, '.agentflow');
  const local_state = node_path.join(workspace, '.tmp');
  for (const directory of [workspace, local_state]) {
    node_fs.mkdirSync(directory, { recursive: true });
    const directory_stat = node_fs.lstatSync(directory);
    if (!directory_stat.isDirectory() || directory_stat.isSymbolicLink()) throw new Error('trace mode path is not a local directory');
  }
  const file = trace_mode_path(project_root);
  try {
    const file_stat = node_fs.lstatSync(file);
    if (!file_stat.isFile() || file_stat.isSymbolicLink()) throw new Error('trace mode file is not a regular local file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = node_fs.openSync(temporary, 'wx', 0o600);
    node_fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, enabled })}\n`);
    node_fs.fsyncSync(descriptor);
    node_fs.closeSync(descriptor);
    descriptor = undefined;
    node_fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) node_fs.closeSync(descriptor);
    try { node_fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
};

const trace_mode_notice = (enabled, failed = false) => {
  if (failed) return {
    systemMessage: 'AGF TRACE MODE — CHANGE FAILED',
    traceContext: 'The requested persistent trace-mode change failed. Keep the last successful session trace state. Do not claim that tracing was enabled or disabled; report that the local mode could not be updated.',
  };
  return {
    systemMessage: enabled
      ? 'AGF TRACE MODE — ENABLED\nApplies to later Codex prompts in this checkout until `godev trace disable`. Adds approximately 40–70 tokens per traced prompt; no extra model call.'
      : 'AGF TRACE MODE — DISABLED\nLater prompts in this checkout will not include persistent trace context.',
    traceContext: `${enabled
      ? 'Retain trace=on in this session; this successful toggle replaces earlier trace instructions. Trace later prompts using their current hook model.'
      : 'Retain trace=off in this session; this successful toggle replaces earlier trace instructions. Do not print task/model trace on this response or later responses until a successful enable.'} This control prompt itself is not traced. Confirm the setting and its checkout scope; do not classify this control as an ordinary task.`,
  };
};

const retired_trace_notice = () => ({
  systemMessage: 'AGF TRACE — ONE-SHOT RETIRED\nUse `godev trace enable` to trace later prompts until `godev trace disable`.',
  traceContext: 'The owner used the retired one-shot trace command. Do not claim this prompt was traced; explain the persistent enable/disable commands.',
});

const trace_notice = (input, persistent = false) => {
  if (input.hook_event_name !== 'UserPromptSubmit' || !persistent) return {};
  const model = require('./routing-trace.js').active_model(input.model);
  return {
    systemMessage: [
      'AGF TRACE — CURRENT RUN',
      'TASK CLASS: **PENDING (L0–L5)**',
      `CURRENT MODEL: **${model}**`,
      'WORKER MODEL/STATUS: **NOT STARTED**',
      'WORKERS STARTED: **0**',
    ].join('\n'),
    traceContext: `For this godev trace, classify the task as L0, L1, L2, L3, L4, or L5 after assessment. Then emit one scannable line with plain keys and bold values: TASK CLASS: **Lx** | CURRENT MODEL: **...** | WORKER MODEL/STATUS: **...** | WORKERS STARTED: **N**. Hook model value: ${model}. Use this value exactly for CURRENT MODEL. If it is unavailable, say the active-model source was unavailable; do not substitute or infer a model name. Say pending/not started as warranted; distinguish configured from observed. Count only workers actually launched; the submit-time count is 0. Do not use emoji key markers or repeat token-cost information in the result.`,
  };
};

const prompt_trace_notice = (input, active_host, project_dir) => {
  if (input.hook_event_name !== 'UserPromptSubmit') return {};
  const trace_command = active_host === 'codex' ? trace_mode_command(input.prompt) : null;
  if (trace_command !== null) {
    try {
      write_trace_mode(project_dir, trace_command);
      return trace_mode_notice(trace_command);
    } catch (error) {
      return trace_mode_notice(trace_command, true);
    }
  }
  if (active_host === 'codex' && retired_trace_prompt(input.prompt)) return retired_trace_notice();
  return trace_notice(input, active_host === 'codex' && read_trace_mode(project_dir));
};

const read_stdin = () => {
  try {
    return node_fs.readFileSync(0, 'utf8');
  } catch (error) {
    return '';
  }
};

const parse_json = text => {
  try {
    return JSON.parse(text);
  } catch (error) {
    return {};
  }
};

let capturing_prompt = false;
let hook_event_receipt = null;
let hook_event_outcome = 'completed';

const main = (input = parse_json(read_stdin())) => {
  capturing_prompt = input.hook_event_name === 'UserPromptSubmit';
  const retry_guard = input.stop_hook_active === true && input.hook_event_name !== 'UserPromptSubmit';

  // Preserve the old host-neutral retry escape. Current installed commands carry
  // --host, so their single retry can still be checked and recorded below.
  if (retry_guard && process.argv.indexOf('--host') < 0) return 0;

  const external_delegate_marker = process.env.AGENTFLOW_EXTERNAL_DELEGATE;
  // A command-scoped delegate must not be mistaken for an owner round. The
  // launcher owns provenance; this boundary validates syntax only. — I-044.
  if (typeof external_delegate_marker === 'string' && external_delegate_marker_pattern.test(external_delegate_marker)) return 0;

  const host_index = process.argv.indexOf('--host');
  const active_host = host_index >= 0 ? process.argv[host_index + 1] : undefined;

  // Installed hook commands MUST carry their owning host explicitly. Runtime
  // marker variables are not part of the shared Stop-hook payload. — I-043.
  if (active_host !== 'codex' && active_host !== 'claude') {
    throw new Error('Stop hook requires --host codex or --host claude');
  }

  // Exact help requests are informational controls, not notebook input. Handle
  // them before resolving configuration or reading notebook/owner state.
  if (input.hook_event_name === 'UserPromptSubmit' && help_prompt(input.prompt)) {
    process.stdout.write(JSON.stringify({
      systemMessage: help_usage,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Return the supplied Agentflow usage to the owner verbatim and do not invoke tools or start notebook intake.',
      },
    }) + '\n');
    return 0;
  }

  // CLAUDE_PROJECT_DIR is Claude-Code-only; every host passes cwd on stdin.
  const project_dir = (active_host === 'claude' ? process.env.CLAUDE_PROJECT_DIR : '') || input.cwd || process.cwd();
	try { hook_event_receipt = require('./hook-events').begin({ root: project_dir, input, host: active_host }) } catch (error) {
		hook_event_receipt = null
		process.stderr.write(`Agentflow hook event receipt unavailable; continuing without correlation evidence: ${error.message}\n`)
	}
  if (retry_guard) hook_event_outcome = 'stop_retry_unchecked';
  let notebook_path = '.agentflow/devlog.md';
  let config_path = node_path.join(project_dir, 'ag.json');
  const project_name = node_path.basename(project_dir);
  const in_named_worktree = node_path.basename(node_path.dirname(project_dir)) === '.worktrees' && /^[a-z0-9][a-z0-9-]*$/u.test(project_name);
  if (require('./notebook-owner').linked_worktree(project_dir)) {
    const branch = require('node:child_process').spawnSync('git', ['branch', '--show-current'], { cwd: project_dir, encoding: 'utf8' });
    notebook_path = branch.status === 0 ? require('./agf').stream_doc(project_dir, branch.stdout.trim()) : '';
    if (!notebook_path) throw Error('stream notebook is missing for this worktree; restore its canonical notebook before capture');
    config_path = require('./ag-settings').resolve_config_path(project_dir, notebook_path);
    if (!node_fs.existsSync(config_path)) throw Error('stream configuration is missing; restore its notebook/configuration pair before capture');
  } else if (in_named_worktree) {
    const stream_notebook = node_path.posix.join('.agentflow', 'features', project_name, `${project_name}.devlog.md`);
    const stream_config = node_path.join(project_dir, '.agentflow', 'features', project_name, 'ag.json');
    if (node_fs.existsSync(node_path.join(project_dir, stream_notebook)) && node_fs.existsSync(stream_config)) {
      notebook_path = stream_notebook;
      config_path = stream_config;
    }
  }
  if (node_fs.existsSync(config_path)) {
    try {
      const config = JSON.parse(node_fs.readFileSync(config_path, 'utf8'));
      if (typeof config?.switches?.['target-doc'] === 'string') notebook_path = config.switches['target-doc'];
    } catch (error) {
      // The linter reports malformed established configuration.
    }
  }
  const devlog_path = node_path.join(project_dir, notebook_path);

  const trace = prompt_trace_notice(input, active_host, project_dir);

  // Trace controls are checkout-local host controls and remain available in a
  // clean folder without an Agentflow notebook. Other hook behavior still
  // requires a configured devlog.
  if (!node_fs.existsSync(devlog_path)) {
		hook_event_outcome = 'no_notebook';
    if (input.hook_event_name === 'UserPromptSubmit' && (trace.systemMessage || trace.traceContext)) {
      process.stdout.write(JSON.stringify({ ...(trace.systemMessage ? { systemMessage: trace.systemMessage } : {}), hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: trace.traceContext || '',
      } }) + '\n');
    }
    return 0;
  }

  if (input.hook_event_name === 'UserPromptSubmit') {
    const status = status_context(input);
    const current = parse_devlog(node_fs.readFileSync(devlog_path, 'utf8')).rounds.at(-1);
    if (!current || current.reply_text.trim()) {
			hook_event_outcome = 'capture_not_saved';
      // Missing bookkeeping must not prevent the owner from requesting repair.
      // Leave history and ownership untouched; the agent receives the prompt.
      process.stdout.write(JSON.stringify({ ...(trace.systemMessage ? { systemMessage: trace.systemMessage } : {}), hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `The user's instruction was not saved in ${notebook_path}: the notebook has no open Ask. Continue with the submitted request. Repair the missing Ask and capture the instruction before further notebook writes, preserving prior history and other sessions' ownership. Do not record this hook notice as user input.${trace.traceContext ? ` ${trace.traceContext}` : ''}${status ? ` ${status}` : ''}`,
      } }) + '\n');
      return 0;
    }
    let result;
    try {
      result = require('./notebook-write.js').append_input({
        root: project_dir, notebook: notebook_path, text: input.prompt,
        host: active_host,
        session: input.session_id,
        message_id: input.turn_id ? `${input.session_id || ''}:${input.turn_id}` : undefined,
      });
    } catch (error) {
      if (error.code !== 'AG_NOTEBOOK_OWNER') throw error;
			hook_event_outcome = 'capture_owner_conflict';
      // Refuse unauthorized notebook writes, not delivery of the owner's request.
      const continuing_native_task = ['codex', 'claude'].includes(active_host) && /^\s*\/?godev(?:\s|$)/iu.test(String(input.prompt || '')) && /belongs to (?:codex|claude) session/u.test(error.message);
      const ownership_guidance = continuing_native_task
        ? ' Continue through the normal `agf start` workflow with this exact owner message; a `godev` start from Codex or Claude will atomically inherit the open native-host task when its owner-token and notebook-hash snapshot is still current. No separate authentication prompt is needed. Do not edit owner metadata directly.'
        : ' Do not mutate this notebook or adopt ownership without resolving the ownership conflict. Inspect ownership before notebook recovery.';
      process.stdout.write(JSON.stringify({ ...(trace.systemMessage ? { systemMessage: trace.systemMessage } : {}), hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `The user's instruction was not saved in ${notebook_path}: notebook ownership prevented capture. Continue with the submitted request, including any no-ag instruction.${ownership_guidance} Diagnostic: ${error.message}. Do not record this hook notice as user input.${trace.traceContext ? ` ${trace.traceContext}` : ''}${status ? ` ${status}` : ''}`,
      } }) + '\n');
      return 0;
    }
		hook_event_outcome = result.inserted ? 'capture_saved' : 'capture_duplicate';
    const round = parse_devlog(node_fs.readFileSync(devlog_path, 'utf8')).rounds.at(-1);
    const fast_lane = require('./fast-lane.js').parse_fast_lane(round?.owner_text);
    const route_notice = fast_lane ? ` Fast-lane ${fast_lane.state}: work directly without AG, delegation, new streams, external review, or pipeline approval/artifact requirements. Keep host self-review, necessary tests, trackers, timed WIP checkpoints, detailed reports, and integrity checks. ${fast_lane.state === 'pending' ? 'Wait for the task; leave this Ask open without a Reply or closeout.' : 'This applies through this task’s closeout, then expires.'}` : '';
    const capture_state = result.inserted ? 'was saved' : 'was already present; no duplicate was written'
    const session_notice = input.session_id ? ` Hook session: ${input.session_id}.` : ''
    process.stdout.write(JSON.stringify({ ...(trace.systemMessage ? { systemMessage: trace.systemMessage } : {}), hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `The user's instruction ${capture_state} in ${notebook_path}, ${result.ask}.${session_notice} Read the current Ask and address all its instructions together. Do not record this hook notice as user input.${route_notice}${trace.traceContext ? ` ${trace.traceContext}` : ''}${status ? ` ${status}` : ''}`,
    } }) + '\n');
    return 0;
  }

  const devlog_text = node_fs.readFileSync(devlog_path, 'utf8');
  const rounds = parse_devlog(devlog_text).rounds;
	if (rounds.length === 1 && ['', '+'].includes(rounds[0].ask_text.trim()) && !rounds[0].reply_text.trim() && !rounds[0].wip_text.trim()) {
		hook_event_outcome = 'stop_skipped';
		return 0;
	}
  const context = collect({
    project_root: project_dir,
    notebook_path,
    config_path: node_fs.existsSync(config_path) ? config_path : undefined,
    active_host,
    devlog_text,
    transcript_path: input.transcript_path,
    last_assistant_message: input.last_assistant_message,
    stop_event: input.hook_event_name !== 'UserPromptSubmit',
    require_status_projection: true,
    now_ms: Date.now()
  });
  const result = lint_round(context);

  if (retry_guard) {
    const report_check = result.checks.find(check => check.id === 'active_stop_report');
    if (report_check?.status === 'fail') {
      hook_event_outcome = 'stop_retry_report_failed';
      // The single correction already ran. Record a failed retry without
      // exposing another checker message or starting a correction loop.
    } else if (report_check?.status === 'pass') {
      hook_event_outcome = 'stop_retry_passed';
    }
    return 0;
  }

  if (result.ok) {
		hook_event_outcome = 'stop_passed';
    const cleanup = require('./completion-cleanup').sweep_completion_records({ project_root: project_dir, notebook_path, config_path });
    if (cleanup.status === 'error') process.stderr.write('Agentflow completion cleanup skipped: ' + cleanup.reason + '\n');
    return 0;
  }

  const parsed = parse_devlog(devlog_text);
  const current_round = parsed.rounds.filter(round => round.text === parsed.last_round).at(-1);
  const active_round = current_round !== undefined && current_round.reply_text.trim() === '';
  // A Codex Stop block turns its reason into a user-visible continuation prompt.
  // Keep stop-report validation diagnostic-only so internal formatting feedback
  // is never injected into the user's chat. Other active-round invariants remain
  // blocking as before.
  const active_blocking_ids = new Set(['round_boundaries', 'configuration_valid']);
  const failed = result.checks.filter(check => check.status === 'fail' && (!active_round || active_blocking_ids.has(check.id)));
  if (failed.length === 0) {
		hook_event_outcome = result.checks.some(check => check.id === 'active_stop_report' && check.status === 'fail')
			? 'stop_report_incomplete'
			: 'stop_warning';
    const warnings = result.checks.filter(check => check.status === 'fail' && check.id !== 'active_stop_report');
    if (warnings.length > 0) {
      process.stderr.write('Agentflow active-round warning — editable progress records need attention:\n');
      warnings.forEach(check => process.stderr.write(`  - ${check.id}: ${check.detail}\n`));
    }
    return 0;
  }
	hook_event_outcome = 'stop_blocked';
  process.stderr.write('Agentflow round-linter blocked this round — a checked rule was broken:\n');
  failed.forEach(check => process.stderr.write(`  - ${check.id}: ${check.detail}\n`));
  process.stderr.write('Keep the current round open, fix these facts, and run the completion check again.\n');
  return 2;
};

// Fail-open: a bug in the referee must never brick the owner session.
let exit_code = 0;
try {
	exit_code = main(parse_json(read_stdin()));
} catch (error) {
	hook_event_outcome = 'hook_error';
  // Logging infrastructure must not prevent the owner from requesting repair.
  process.stderr.write(`Agentflow hook error: ${error.message}\n`);
  if (capturing_prompt) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: `Automatic notebook capture did not complete. Continue with the submitted request, including any no-ag instruction. The instruction may already be saved if a later step failed; inspect the current Ask before retrying capture. Preserve history, existing locks and other sessions' ownership; do not force a notebook write or ownership takeover. Diagnostic: ${error.message}. Do not record this hook notice as user input.`,
  } }) + '\n');
  exit_code = 0;
}

if (hook_event_receipt) {
	const state = hook_event_outcome === 'hook_error' || hook_event_outcome === 'stop_retry_report_failed'
		? 'failed'
		: exit_code === 2 ? 'blocked' : 'completed';
	if (!require('./hook-events').finish(hook_event_receipt, { state, outcome: hook_event_outcome })) {
		process.stderr.write('Agentflow hook event receipt could not record completion; the hook result above remains authoritative.\n')
	}
}

process.exit(exit_code);
