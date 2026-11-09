'use strict'
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { validate_records, validate_linked_files } = require('./initiative-state.js')

const linked_records = ({ task = 'T-11', plan = task, notebook = task, approval = 'approved', state = 'active' } = {}) => ({
  task_text: `- **Agentflow state:** ${approval}; ${state}; current=${task}.\n`,
  plan_text: `- **Agentflow state:** ${approval}; ${state}; current=${plan}.\n`,
	tracker_text: `- **Active Ask:** A-025.\n- **Plan approval:** ${approval}.\n- **State:** ${state}.\n- **Current item:** ${task}.\n- **Active blocker or running process:** ${state === 'blocked' ? 'blocker: shared Git metadata is read-only' : 'None'}.\n- [ ] **${task}:** current work. Source: A-025.\n`,
  notebook_text: `# → Ask / A-025\n\n+ implement reliability\n\n## [RUN-009] Event — 2026-10-14 19:00:00 +0800 (A-025)\n\n- **Initiative state:** ${approval}; ${state}; current=${notebook}\n`,
})

test('linked project records pass when approval, state, Ask, and current task agree', () => {
  const result = validate_records(linked_records())
  assert.deepEqual(result, { status: 'pass', errors: [] })
})

test('a blocker resolution passes when every linked state record moves from blocked to active', () => {
	const records = linked_records({ state: 'active' })
	assert.deepEqual(validate_records(records), { status: 'pass', errors: [] })
})

test('a stale blocked tracker is identified against the authoritative Task.md state', () => {
	const records = linked_records({ state: 'active' })
	records.tracker_text = records.tracker_text
		.replace('- **State:** active.', '- **State:** blocked.')
		.replace('- **Active blocker or running process:** None.', '- **Active blocker or running process:** blocker: shared Git metadata is read-only.')
	const result = validate_records(records)
	assert.equal(result.status, 'fail')
	assert.match(result.errors.join('\n'), /tracker workflow state blocked disagrees with Task\.md workflow state active/i)
	assert.match(result.errors.join('\n'), /Task\.md is authoritative.*update the stale linked record.*rerun validation/i)
})

test('a resolved tracker state cannot retain a current blocker', () => {
	const records = linked_records({ state: 'active' })
	records.tracker_text = records.tracker_text
		.replace('- **Active blocker or running process:** None.', '- **Active blocker or running process:** blocker: shared Git metadata is read-only.')
	const result = validate_records(records)
	assert.equal(result.status, 'fail')
	assert.match(result.errors.join('\n'), /current blocker while its workflow state is active.*clear or resolve the stale blocker field.*rerun validation/i)
})

test('a blocked tracker must name its blocker explicitly', () => {
	const records = linked_records({ state: 'blocked' })
	records.tracker_text = records.tracker_text.replace('blocker: shared Git metadata is read-only.', 'shared Git metadata is read-only.')
	const result = validate_records(records)
	assert.equal(result.status, 'fail')
	assert.match(result.errors.join('\n'), /blocked.*active blocker field lacks a `blocker:` reason.*record the current blocker/i)
})

test('linked project records fail before closeout when current task or approval diverges', () => {
  const result = validate_records(linked_records({ plan: 'T-12', approval: 'approved' }))
  assert.equal(result.status, 'fail')
  assert.match(result.errors.join('\n'), /plan.*current task.*T-12.*Task\.md.*T-11/i)
})

test('linked project records reject an unresolved approval gate after approval was recorded', () => {
  const records = linked_records()
  records.task_text = '- **Agentflow state:** pending; active; current=T-11.\n'
  const result = validate_records(records)
  assert.equal(result.status, 'fail')
  assert.match(result.errors.join('\n'), /approval.*disagrees/i)
})

test('linked-file validation reads only named records and catches a plan drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-initiative-state-'))
  try {
    fs.mkdirSync(path.join(root, 'docs'))
    fs.mkdirSync(path.join(root, '.agentflow'))
    fs.writeFileSync(path.join(root, 'Task.md'), '- **Agentflow state:** approved; active; current=T-11.\n')
    fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '- **Agentflow state:** approved; active; current=T-11.\n')
    fs.writeFileSync(path.join(root, '.agentflow', 'devlog.md'), '# → Ask / A-025\n\n## [RUN-009] Event — now\n- **Initiative state:** approved; active; current=T-11\n')
    const tracker = [
      '- **Active Ask:** A-025.',
      '- **Plan approval:** approved.',
      '- **State:** active.',
      '- **Current item:** T-11.',
      '- **Active blocker or running process:** None.',
      '- **Task file:** Task.md.',
      '- **Plan file:** docs/plan.md.',
      '- **Notebook file:** .agentflow/devlog.md.',
      '- [ ] **T-11:** current work. Source: A-025.',
    ].join('\n')
    assert.deepEqual(validate_linked_files({ repo: root, tracker_text: tracker }), { status: 'pass', errors: [] })
    fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '- **Agentflow state:** approved; active; current=T-12.\n')
    const result = validate_linked_files({ repo: root, tracker_text: tracker })
    assert.equal(result.status, 'fail')
    assert.match(result.errors.join('\n'), /plan current task T-12 disagrees/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linked record paths cannot escape through a symbolic-link directory', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-initiative-state-links-'))
  const root = path.join(parent, 'repo')
  const outside = path.join(parent, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'Task.md'), '- **Agentflow state:** approved; active; current=T-11.\n')
  fs.writeFileSync(path.join(outside, 'plan.md'), '- **Agentflow state:** approved; active; current=T-11.\n')
  fs.mkdirSync(path.join(root, '.agentflow'))
  fs.writeFileSync(path.join(root, '.agentflow', 'devlog.md'), '# → Ask / A-025\n- **Initiative state:** approved; active; current=T-11\n')
  try { fs.symlinkSync(outside, path.join(root, 'docs-link'), 'dir') }
  catch (error) { fs.rmSync(parent, { recursive: true, force: true }); t.skip(`directory symlinks are unavailable: ${error.code}`); return }
  const tracker = [
    '- **Active Ask:** A-025.', '- **Plan approval:** approved.', '- **State:** active.',
    '- **Current item:** T-11.', '- **Task file:** Task.md.', '- **Plan file:** docs-link/plan.md.',
    '- **Notebook file:** .agentflow/devlog.md.', '- [ ] **T-11:** current work. Source: A-025.',
  ].join('\n')
  try {
    const result = validate_linked_files({ repo: root, tracker_text: tracker })
    assert.equal(result.status, 'fail')
    assert.match(result.errors.join('\n'), /plan file path escapes the repository/i)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('linked project records reject duplicate status markers in stable source documents', () => {
  const records = linked_records()
  records.task_text += records.task_text
  const result = validate_records(records)
  assert.equal(result.status, 'fail')
  assert.match(result.errors.join('\n'), /Task\.md.*missing.*marker/i)
})
