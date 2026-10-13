'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../../..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
test('delegation does not override direct work or prohibit assigned implementation', () => {
	const guide = read('skills/agflow-frugal/references/delegation.md')
	assert.doesNotMatch(guide, /All substantive .*must use this route/)
	assert.match(guide, /implementation worker.*declared source/i)
	assert.match(guide, /reviewer.*read-only/i)
	assert.doesNotMatch(read('skills/agflow-frugal/references/ag.md'), /preserves user changes and writes only its report\/result/)
})

test('adaptive support preserves protections without ranking models or buying repeated retries', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	assert.match(skill, /Task risk determines required checks/)
	assert.match(skill, /one focused correction/)
	assert.match(skill, /No model ranking or paid qualification/)
	assert.match(skill, /comparable work.*verified success/is)
})

test('the always-loaded skill stays within the retained 32 KiB budget', () => {
	const skill = read('skills/agflow-frugal/SKILL.md')
	const bytes = Buffer.byteLength(skill, 'utf8')
	const retained_budget = 32 * 1024
	assert.ok(bytes < retained_budget, `always-loaded skill is ${bytes} bytes`)
	assert.match(skill, /Read `references\/closeout\.md` in full before deciding review requirements/)
	assert.doesNotMatch(skill, /"allowed_paths"/)
	assert.match(read('skills/agflow-frugal/references/closeout.md'), /"allowed_paths"/)
})

test('prompt trace supports persistent checkout-local mode and retires one-shot control', () => {
	const skill = read('skills/agflow-frugal/SKILL.md')
	const hook = read('skills/agflow-frugal/scripts/stop-hook.js')
	const docs = read('skills/agflow-frugal/scripts/README.md')
	assert.match(skill, /Trace toggles are Codex `UserPromptSubmit` controls, not startup tasks/u)
	assert.match(skill, /clean folders need the global hook.*Without a hook acknowledgement, report that setup step instead of running `godev` startup/u)
	assert.match(skill, /Bare `godev trace\[ full\]` is retired/u)
	assert.match(skill, /40–70 tokens\/prompt/u)
	assert.match(skill, /unknown explicit/u)
	assert.match(hook, /\.agentflow', '\.tmp', 'trace-mode\.json'/u)
	assert.match(hook, /ONE-SHOT RETIRED/u)
	assert.match(hook, /!persistent\) return \{\}/u)
	assert.match(docs, /defaults off, survives prompts\/restarts, and is not shared with other checkouts/u)
	assert.match(docs, /retired one-shot prompts `godev trace` and `godev trace full`/u)
})

test('prompt status distinguishes explicit approval gates from work and blockers', () => {
	const skill = read('skills/agflow-frugal/SKILL.md')
	const hook = read('skills/agflow-frugal/scripts/stop-hook.js')
	const readme = read('skills/agflow-frugal/scripts/README.md')
	assert.match(hook, /const status_prompt = prompt => .*godev\\s\+status/u)
	assert.match(hook, /latest RUN\/Reply\).*Awaiting owner approval.*Awaiting work\/checks.*Blocked/is)
	assert.match(hook, /Never infer approval from unfinished work or stale STATUS/u)
	assert.match(readme, /exact `godev status`.*directly linked.*does not infer approval/u)
})

test('consequential Go gates ask for the exact owner decision and explain its effect', () => {
	const skill = read('skills/agflow-frugal/SKILL.md')
	const streams = read('skills/agflow-frugal/references/streams.md')
	const delegation = read('skills/agflow-frugal/references/delegation.md')
	const pipeline = read('skills/agflow-frugal/references/ag.md')
	const closeout = read('skills/agflow-frugal/references/closeout.md')
	assert.match(skill, /At an owner gate, state the blocked action, reason, exact decision and what it authorizes; ask clearly and pause dependent work.*Separate approval from pending checks.*Design Go before edits and Result Go after evidence/iu)
	assert.match(streams, /For `ask`, state the trigger.*ask whether to create the stream.*wait for an affirmative answer/i)
	assert.match(delegation, /owner-selected model\/effort is unavailable, name it and viable choices, ask whether to use a specific alternative or stop, and wait/i)
	assert.match(pipeline, /`ask` blocks complex pipeline jobs until the owner decides.*State the trigger, named questions, reason and route, ask whether to proceed/i)
	assert.match(closeout, /ask the owner for exactly `Result Go: <full-commit>` or `Result Stop: <reason>`.*explain.*Go permits consequential closeout.*Stop keeps it blocked/i)
})

test('project authorization overrides the global diff-approval rule and names the L3 display', () => {
	const skill = read('skills/agflow-frugal/SKILL.md')
	const project_policy_path = path.join(root, 'AGENTS.md')
	if (fs.existsSync(project_policy_path)) {
		const project_policy = read('AGENTS.md')
		assert.match(project_policy, /global instruction file `\/home\/tristan\/\.codex\/AGENTS\.md`, under `## Code Change Approval`/u)
		assert.match(project_policy, /authorized without per-diff or per-commit approval.*do not wait for approval or require `CMD:auto-approve`/is)
		assert.match(project_policy, /push.*release.*paid.*installed/isu)
	}
	assert.match(skill, /Exception: `\/home\/tristan\/\.codex\/AGENTS\.md` § `Code Change Approval`/i)
	const task_path = path.join(root, 'Task.md')
	if (fs.existsSync(task_path)) {
		const task = read('Task.md')
		assert.match(task, /TASK CLASS: \*\*L3 — Basic Direct\*\*.*CURRENT MODEL: \*\*.*WORKER MODEL\/STATUS: \*\*.*WORKERS STARTED:/s)
	}
})

test('the always-loaded skill routes advanced machinery on demand', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	assert.match(skill, /canonical startup command.*agf\.js start.*message-stdin/i)
	assert.match(skill, /first and only startup call.*exact owner message.*standard input/is)
	assert.match(skill, /Never make an empty or probe startup call/is)
	assert.match(skill, /references\/streams\.md.*before any feature/i)
	assert.match(skill, /references\/ag\.md.*all-in.*make-plans/i)
	assert.match(skill, /references\/delegation\.md.*before selecting, briefing, or starting a worker/i)
	assert.match(skill, /`run-looper` means: read `references\/looper\.md`/i)
	assert.doesNotMatch(skill, /eval\/evaluation-harness\.md/i)
})

test('the slim front door retains the owner, scope, evidence, and Git boundaries', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	assert.match(skill, /exact owner message.*standard input/i)
	assert.match(skill, /Scope discipline — implement exactly the ask/i)
	assert.match(skill, /Worker findings never expand scope/i)
	assert.match(skill, /Facts require direct command output or file inspection/i)
	assert.match(skill, /failing test.*smallest green change.*complete relevant suite/i)
	assert.match(skill, /Never force-push/i)
})

test('every workflow stop explains status, cause, owner action, and next step', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	assert.match(skill, /At every stop, state completion, result, cause, exact owner action and next step; name what approval unlocks/i)
	assert.match(skill, /If a gate prevents completion, say plainly that the task is incomplete; distinguish an error \(and its effect\) from approval, missing input, unavailable capability, or a pending check.*exact owner action or approval needed.*what happens next/is)
	assert.match(skill, /Never imply completion while acceptance work remains/i)
})

test('show-diff requires justified, human-scannable unified diff hunks', () => {
	const skill = read('skills/agflow-frugal/SKILL.md')
	const writing = read('skills/agflow-frugal/references/writing.md')
	assert.match(skill, /references\/writing\.md.*show-diff/i)
	assert.match(writing, /each logical change.*`Reason:`.*fenced `diff` hunk/is)
	assert.match(writing, /unified-diff markers.*verified old\/new line numbers/is)
	assert.match(writing, /insertions contain only added lines.*deletions only removed lines/is)
})

test('general writing guidance preserves requirements refresh history outside advisor-only paths', () => {
	const writing = read('skills/agflow-frugal/references/writing.md')
	assert.match(writing, /requirements refreshes.*append-only question history.*(?:one|single) replaceable `# Final requirements summary`/i)
})

test('the front door makes activation and closeout one-shot operations', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	const english = read('skills/agflow-frugal/docs/AG_GUIDE.md')
	const chinese = read('skills/agflow-frugal/docs/AG_GUIDE.zh-tw.md')
	assert.match(skill, /bare `godev`.*`activation_only`.*`activation_placeholder_repaired`.*Development workflow ready\..*do not.*close/is)
	assert.match(skill, /bare `godev`.*`already_present`.*read the current Ask.*resume/is)
	assert.match(english, /Ask is still empty|Ask is empty|Ask is still empty/is)
	assert.match(english, /Development workflow ready\..*Ask already contains your request.*reads it/is)
	assert.match(chinese, /Ask 仍然是空的.*Development workflow ready\..*Ask 已經有你的請求.*讀取內容/is)
	assert.match(skill, /do not (?:search for|read).*AGENTS\.md.*agf\.js.*notebook-write\.js/is)
	assert.match(skill, /compose.*in memory.*--manifest-stdin/is)
	assert.match(skill, /never create.*`close-manifest\.json`/is)
	assert.match(skill, /single-quoted heredoc.*without base64.*`btoa`.*`TextEncoder`/is)
	assert.match(skill, /Close with one `agf close --manifest-stdin`; never add `--repo`/i)
	assert.match(skill, /Run it once/i)
	assert.match(skill, /use `run_events: \[\]` only when none remain/is)
	assert.match(skill, /writer owns numbering and time/is)
	assert.match(skill, /`agf close` alone adds.*next empty Ask scaffold/is)
	assert.match(skill, /Do not include that scaffold in `reply`/u)
})

test('the slim front door retains notebook compaction and concise Reply evidence', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/progress.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	const english = read('skills/agflow-frugal/docs/AG_GUIDE.md')
	const chinese = read('skills/agflow-frugal/docs/AG_GUIDE.zh-tw.md')
	assert.match(skill, /Startup and input capture automatically compact eligible completed rounds when a notebook exceeds 1,000 lines or reaches 768 KiB/is)
	assert.match(english, /after 1,000 lines/i)
	assert.match(chinese, /超過 1,000 行/i)
	assert.match(skill, /Do not use a fixed evidence-and-delivery checklist/i)
	assert.match(skill, /Omit the redundant literal `Host gate: PASS`/i)
	assert.match(skill, /structured `host_gate` evidence/i)
	assert.match(skill, /Host review: PASS.*inspected scope, evidence and findings/i)
})

test('advanced feature rulebooks remain complete and mechanically bounded', () => {
	const pipeline = read('skills/agflow-frugal/references/ag.md')
	const delegation = read('skills/agflow-frugal/references/delegation.md')
	const streams = read('skills/agflow-frugal/references/streams.md')
	const looper = read('skills/agflow-frugal/references/looper.md')
	assert.match(pipeline, /requirements.*specification.*implementation.*acceptance/s)
	assert.match(pipeline, /all-in.*every optional advisor/i)
	assert.match(delegation, /external-runner-v1/)
	assert.match(delegation, /independent disposable Git clone with no remotes/i)
	assert.match(streams, /finish --prep/)
	assert.match(streams, /finish --deliver/)
	assert.match(looper, /select_frozen_ready_plans/)
})

test('completion does not require or advertise an audit side file', () => {
	const skill = read('skills/agflow-frugal/SKILL.md') + '\n' + read('skills/agflow-frugal/references/closeout.md')
	const completion = read('skills/agflow-frugal/scripts/completion-context.js')
	const writer = read('skills/agflow-frugal/scripts/notebook-write.js')
	const streams = read('skills/agflow-frugal/references/streams.md')
	assert.doesNotMatch(skill, /\.devlog\.audit\.md|Historical audit files/)
	assert.doesNotMatch(completion, /readFileSync\(audit_path/)
	assert.match(streams, /never creates a new audit side file/i)
	assert.doesNotMatch(streams, /staging only its notebook and audit record/i)
	assert.match(writer, /active_config_path\(repository_root, repository_notebook\)/)
	assert.match(completion, /skip-review/)
})

test('worker output and evaluation evidence retain exact safety boundaries', () => {
	for (const name of ['requirements', 'codewalk', 'explore', 'spike', 'spec', 'security-scan', 'acceptance', 'learn']) {
		const source = read(`skills/agflow-frugal/references/advisors/${name}.md`)
		assert.match(source, /Self-check:/)
	}
})
