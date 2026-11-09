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
  fs.writeFileSync(notebook, `# Stream\n\nFeature: ${key} — active — test stream\n`)
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

test('root STATUS refuses an active pointer when the stream notebook is closed', t => {
  const fixture = repo_fixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  fs.writeFileSync(fixture.notebook, `# Stream\n\nFeature: ${fixture.key} — closed\n`)
  assert.throws(() => canonicalize_root_streams({
    repo: fixture.root,
    features: fixture.features,
    streams: [{ taskkey: fixture.key, state: 'active', path: `${fixture.features}/${fixture.key}/${fixture.key}.devlog.md` }],
  }), /root STATUS.*active.*stream notebook.*closed.*remove the pointer/i)
})

test('stream status can be recovered in a writable clone after Git worktree metadata is read-only', t => {
  const fixture = repo_fixture()
  const clone_container = fs.mkdtempSync(path.join(os.tmpdir(), 'agf-writable-clone-'))
  const writable_clone = path.join(clone_container, 'repo')
  t.after(() => {
    fs.chmodSync(path.join(fixture.root, '.git', 'worktrees'), 0o755)
    fs.rmSync(clone_container, { recursive: true, force: true })
    fs.rmSync(fixture.root, { recursive: true, force: true })
  })

  const metadata_path = path.join(fixture.root, '.git', 'worktrees')
  const original_mode = fs.statSync(metadata_path).mode & 0o777
  fs.chmodSync(metadata_path, 0o555)
  let read_only_refusal
  try {
    fixture.git(['worktree', 'add', path.join(fixture.root, '.worktrees', 'blocked-probe'), '-b', 'blocked-probe'])
  } catch (error) {
    read_only_refusal = error
  } finally {
    fs.chmodSync(metadata_path, original_mode)
  }
  if (!read_only_refusal) {
    t.skip('filesystem allowed Git metadata writes after the directory was made read-only')
    return
  }

  execFileSync('git', ['clone', '--no-hardlinks', fixture.root, writable_clone], { encoding: 'utf8' })
  const recovered_key = 'recovered-stream'
  const recovered_worktree = path.join(writable_clone, '.worktrees', recovered_key)
  execFileSync('git', ['worktree', 'add', recovered_worktree, '-b', recovered_key], { cwd: writable_clone, encoding: 'utf8' })
  const recovered_notebook = path.join(recovered_worktree, fixture.features, recovered_key, `${recovered_key}.devlog.md`)
  fs.mkdirSync(path.dirname(recovered_notebook), { recursive: true })
  fs.writeFileSync(recovered_notebook, `# Stream\n\nFeature: ${recovered_key} — active — recovered\n`)
  const physical = path.relative(writable_clone, recovered_notebook).split(path.sep).join('/')
  const result = canonicalize_root_streams({
    repo: writable_clone,
    features: fixture.features,
    streams: [{ taskkey: recovered_key, state: 'active', path: physical }],
  })
  assert.deepEqual(result.streams, [{
    taskkey: recovered_key,
    state: 'active',
    path: `${fixture.features}/${recovered_key}/${recovered_key}.devlog.md`,
  }])
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

test('legacy feature settings still recognize a new canonical stream notebook', t => {
  const fixture = repo_fixture()
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }))
  const canonical = `${fixture.features}/${fixture.key}/${fixture.key}.devlog.md`
  const result = canonicalize_root_streams({
    repo: fixture.root, features: 'legacy-records/features',
    streams: [{ taskkey: fixture.key, state: 'active', path: canonical }],
  })
  assert.equal(result.streams[0].path, canonical)
})
