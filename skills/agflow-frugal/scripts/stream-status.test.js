'use strict'
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { canonicalize_root_streams } = require('./stream-status.js')
const { close_status_text } = require('./notebook-write.js')
const settings = require('./ag-settings.js')

const repo_fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agf-stream-status-')))
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'initial'])
  const key = 'godev-help-delivery'
  const worktree = path.join(root, '.worktrees', key)
  git(['worktree', 'add', worktree, '-b', key])
  const features = '.agentflow/features'
  const notebook = path.join(worktree, features, key, `${key}.devlog.md`)
  fs.mkdirSync(path.dirname(notebook), { recursive: true })
  fs.writeFileSync(notebook, '# stream\n')
  return { root, key, worktree, features, notebook, git }
}

test('root STATUS canonicalizes a registered physical worktree path', t => {
  const fixture = repo_fixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  const physical = path.relative(fixture.root, fixture.notebook).split(path.sep).join('/')
  const result = canonicalize_root_streams({
    repo: fixture.root,
    features: fixture.features,
    streams: [{ taskkey: fixture.key, state: 'active', path: physical }],
  })
  assert.deepEqual(result, { streams: [{ taskkey: fixture.key, state: 'active', path: `${fixture.features}/${fixture.key}/${fixture.key}.devlog.md` }] })
})

test('root STATUS rejects a missing or unregistered stream before writing it', t => {
  const fixture = repo_fixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  assert.throws(() => canonicalize_root_streams({
    repo: fixture.root,
    features: fixture.features,
    streams: [{ taskkey: 'other-stream', state: 'active', path: 'elsewhere/other-stream.devlog.md' }],
  }), /no registered worktree.*other-stream/i)
})


test('close-round rewrites a registered physical stream path into the canonical root workspace', t => {
  const fixture = repo_fixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  const config = settings.make_template('codex')
  config.switches['target-doc'] = '.agentflow/devlog.md'
  fs.writeFileSync(path.join(fixture.root, 'ag.json'), `${JSON.stringify(config, null, 2)}\n`)
  const physical = path.relative(fixture.root, fixture.notebook).split(path.sep).join('/')
  const status = close_status_text({
    project: 'fixture', notebook: '.agentflow/devlog.md', notebook_kind: 'root', current_commit: 'test',
    tests_scenarios: 'test', config_path: 'ag.json', host: 'codex', validation: 'validated',
    proven: 'test', open: 'none', next: 'await owner', artifacts: 'none', archived_eras: 'none',
    streams: [{ taskkey: fixture.key, state: 'active', path: physical }],
  }, '# STATUS\n', fixture.root)
  assert.match(status, new RegExp(`stream: ${fixture.key} — active — ${fixture.features}/${fixture.key}/${fixture.key}\\.devlog\\.md`))
  assert.equal(settings.validate_status_projection(status).valid, true)
  assert.doesNotMatch(status, /\.worktrees\//)
  assert.throws(() => close_status_text({
    project: 'fixture', notebook: '.agentflow/devlog.md', notebook_kind: 'root', current_commit: 'test',
    tests_scenarios: 'test', config_path: 'ag.json', host: 'codex', validation: 'validated',
    proven: 'test', open: 'none', next: 'await owner', artifacts: 'none', archived_eras: 'none',
    streams: [{ taskkey: fixture.key, state: 'active', path: 'elsewhere/wrong.devlog.md' }],
  }, '# STATUS\n', fixture.root), /does not match its registered worktree/i)
})
