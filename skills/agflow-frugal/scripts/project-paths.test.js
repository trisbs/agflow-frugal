'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const settings = require('./ag-settings.js')

const temp_repo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agflow-project-paths-'))
const drop = repo => fs.rmSync(repo, { recursive: true, force: true })
const options = repo => ({ repo_root: repo, active_host: 'codex', executables: ['codex', 'claude'] })

test('canonical project paths keep configuration, queue, locks, and managed worktrees in .agentflow', () => {
  const config = settings.make_template('codex')
  config.switches['workspace-dir'] = 'legacy-workflow-data'
  const paths = settings.project_paths(config)
  assert.deepEqual(paths, {
    workspace: '.agentflow',
    config: '.agentflow/ag.json',
    planned: '.agentflow/planned',
    features: '.agentflow/features',
    startup_lock: '.agentflow/.tmp/start.lock',
    startup_recovery_lock: '.agentflow/.tmp/start.recovery.lock',
    worktrees: '.agentflow/worktrees',
  })
})

test('fresh initialization writes the project config and notebook under .agentflow', () => {
  const repo = temp_repo()
  try {
    const initialized = settings.initialize_project(options(repo))
    assert.equal(path.relative(repo, initialized.config_path).split(path.sep).join('/'), '.agentflow/ag.json')
    assert.equal(path.relative(repo, initialized.notebook_path).split(path.sep).join('/'), '.agentflow/devlog.md')
    assert.equal(fs.existsSync(path.join(repo, 'ag.json')), false)
    assert.equal(fs.existsSync(path.join(repo, '.agentflow/ag.json')), true)
    assert.equal(fs.existsSync(path.join(repo, '.agentflow/devlog.md')), true)
  } finally {
    drop(repo)
  }
})

test('legacy root config migrates without changing settings and is idempotent', () => {
  const repo = temp_repo()
  try {
    const config = settings.make_template('codex')
    config.switches['auto-reply'] = 'on'
    config.switches['workspace-dir'] = 'workflow-data'
    config.switches['target-doc'] = 'notes/main.md'
    const legacy = JSON.stringify(config, null, 2) + '\n'
    const notebook = '# existing notebook bytes\n'
    fs.mkdirSync(path.join(repo, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'notes/main.md'), notebook)
    fs.writeFileSync(path.join(repo, 'ag.json'), legacy)

    const migrated = settings.ensure_configuration(options(repo))
    assert.equal(migrated.config_path, path.join(repo, '.agentflow/ag.json'))
    assert.equal(migrated.config.switches['auto-reply'], 'on')
    assert.equal(migrated.config.switches['workspace-dir'], 'workflow-data')
    assert.equal(migrated.config.switches['target-doc'], 'notes/main.md')
    assert.equal(fs.readFileSync(path.join(repo, '.agentflow/ag.json'), 'utf8'), legacy)
    assert.equal(fs.readFileSync(path.join(repo, 'notes/main.md'), 'utf8'), notebook)
    assert.equal(fs.existsSync(path.join(repo, 'ag.json')), false)

    const second = settings.ensure_configuration(options(repo))
    assert.equal(second.created, false)
    assert.equal(second.config.switches['auto-reply'], 'on')
  } finally {
    drop(repo)
  }
})

test('project initialization migrates a legacy config instead of recreating root ag.json', () => {
  const repo = temp_repo()
  try {
    const config = settings.make_template('codex')
    config.switches['target-doc'] = '.agentflow/devlog.md'
    fs.mkdirSync(path.join(repo, '.agentflow'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.agentflow/devlog.md'), '# existing notebook\n')
    const bytes = `${JSON.stringify(config, null, 2)}\n`
    fs.writeFileSync(path.join(repo, 'ag.json'), bytes)

    const initialized = settings.initialize_project(options(repo))

    assert.equal(initialized.config_path, path.join(repo, '.agentflow/ag.json'))
    assert.equal(fs.readFileSync(initialized.config_path, 'utf8'), bytes)
    assert.equal(fs.existsSync(path.join(repo, 'ag.json')), false)
    assert.equal(fs.readFileSync(path.join(repo, '.agentflow/devlog.md'), 'utf8'), '# existing notebook\n')
  } finally {
    drop(repo)
  }
})

test('conflicting root and canonical configs stop without changing either file', () => {
  const repo = temp_repo()
  try {
    const legacy = JSON.stringify(settings.make_template('codex'), null, 2) + '\n'
    const canonical_config = settings.make_template('codex')
    canonical_config.switches['auto-reply'] = 'on'
    const canonical = JSON.stringify(canonical_config, null, 2) + '\n'
    fs.mkdirSync(path.join(repo, '.agentflow'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.agentflow/devlog.md'), '# STATUS\n')
    fs.writeFileSync(path.join(repo, 'ag.json'), legacy)
    fs.writeFileSync(path.join(repo, '.agentflow/ag.json'), canonical)

    assert.throws(() => settings.ensure_configuration(options(repo)), /conflict.*ag\.json|ag\.json.*conflict/i)
    assert.equal(fs.readFileSync(path.join(repo, 'ag.json'), 'utf8'), legacy)
    assert.equal(fs.readFileSync(path.join(repo, '.agentflow/ag.json'), 'utf8'), canonical)
  } finally {
    drop(repo)
  }
})

test('failed legacy config copy leaves the root source recoverable', () => {
  const repo = temp_repo()
  try {
    const config = settings.make_template('codex')
    const legacy = JSON.stringify(config, null, 2) + '\n'
    fs.mkdirSync(path.join(repo, '.agentflow'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.agentflow/devlog.md'), '# STATUS\n')
    fs.writeFileSync(path.join(repo, 'ag.json'), legacy)
    const failing_fs = { ...fs, renameSync: () => { throw new Error('injected destination rename failure') } }

    assert.throws(() => settings.ensure_configuration({ ...options(repo), fs: failing_fs }), /could not be written atomically/)
    assert.equal(fs.readFileSync(path.join(repo, 'ag.json'), 'utf8'), legacy)
    assert.equal(fs.existsSync(path.join(repo, '.agentflow/ag.json')), false)
  } finally {
    drop(repo)
  }
})

test('failed post-copy verification preserves the legacy source for recovery', () => {
  const repo = temp_repo()
  try {
    const legacy = `${JSON.stringify(settings.make_template('codex'), null, 2)}\n`
    fs.mkdirSync(path.join(repo, '.agentflow'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.agentflow/devlog.md'), '# STATUS\n')
    fs.writeFileSync(path.join(repo, 'ag.json'), legacy)
    const failing_fs = {
      ...fs,
      renameSync: (source, destination) => {
        fs.renameSync(source, destination)
        fs.writeFileSync(destination, 'corrupted after rename\n')
      },
    }

    assert.throws(() => settings.ensure_configuration({ ...options(repo), fs: failing_fs }), error => error.code === 'AG_CONFIG_MIGRATION_VERIFY')
    assert.equal(fs.readFileSync(path.join(repo, 'ag.json'), 'utf8'), legacy)
    assert.equal(fs.readFileSync(path.join(repo, '.agentflow/ag.json'), 'utf8'), 'corrupted after rename\n')
  } finally {
    drop(repo)
  }
})

const legacy_runtime_fixture = repo => {
  const config = settings.make_template('codex')
  config.switches['workspace-dir'] = 'legacy notes'
  config.switches['target-doc'] = 'legacy notes/devlog.md'
  fs.mkdirSync(path.join(repo, 'legacy notes'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'legacy notes/devlog.md'), '# → Ask / A-001\n\n+\n')
  fs.writeFileSync(path.join(repo, 'ag.json'), JSON.stringify(config))
  settings.ensure_configuration(options(repo))
  return { root: repo, notebook: config.switches['target-doc'], host: 'portable', session: 'contained-fixture' }
}

test('legacy custom workspace routes new owner, input and completion state under .agentflow', () => {
  const repo = temp_repo()
  try {
    const f = legacy_runtime_fixture(repo)
    const writer = require('./notebook-write')
    writer.append_input({ ...f, text: 'preserve the legacy notebook' })
    const owner = require('./notebook-owner').location(f)
    const completion = require('./completion-record').location({ project_root: repo, notebook_path: f.notebook, ask: 'A-001' })
    assert.ok(path.relative(repo, owner.file).startsWith('.agentflow/'))
    assert.ok(path.relative(repo, completion.file).startsWith('.agentflow/'))
    assert.equal(fs.existsSync(path.join(repo, 'legacy notes/.tmp')), false)
    assert.ok(fs.readdirSync(path.join(repo, '.agentflow/.tmp')).some(name => name.startsWith('agentflow-input-portable-')))
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.agentflow/ag.json'))).switches['target-doc'], f.notebook)
  } finally { drop(repo) }
})

test('legacy owner remains fenced and migrates only for its authorized writer', () => {
  const repo = temp_repo()
  try {
    const f = legacy_runtime_fixture(repo)
    const writer = require('./notebook-write')
    const owner = require('./notebook-owner')
    writer.append_input({ ...f, text: 'original request' })
    const canonical = owner.location(f).file
    assert.ok(path.relative(repo, canonical).startsWith('.agentflow/'))
    const legacy = path.join(repo, 'legacy notes/.tmp', path.basename(canonical))
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.renameSync(canonical, legacy)
    const original = fs.readFileSync(legacy)
    fs.writeFileSync(path.join(repo, 'legacy notes/owner-file.txt'), 'keep\n')
    assert.throws(() => writer.append_input({ ...f, session: 'foreign', text: 'must refuse' }), /belongs to portable session/)
    assert.deepEqual(fs.readFileSync(legacy), original)
    assert.equal(fs.existsSync(canonical), false)
    writer.append_input({ ...f, text: 'authorized continuation' })
    assert.deepEqual(fs.readFileSync(canonical), original)
    assert.equal(fs.existsSync(legacy), false)
    assert.equal(fs.readFileSync(path.join(repo, 'legacy notes/owner-file.txt'), 'utf8'), 'keep\n')
  } finally { drop(repo) }
})

test('conflicting canonical and legacy owners stop without changing either record', () => {
  const repo = temp_repo()
  try {
    const f = legacy_runtime_fixture(repo)
    const writer = require('./notebook-write')
    const owner = require('./notebook-owner')
    writer.append_input({ ...f, text: 'original request' })
    const canonical = owner.location(f).file
    assert.ok(path.relative(repo, canonical).startsWith('.agentflow/'))
    const legacy = path.join(repo, 'legacy notes/.tmp', path.basename(canonical))
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    const first = fs.readFileSync(canonical)
    const conflict = { ...JSON.parse(first), session: 'another-writer' }
    fs.writeFileSync(legacy, JSON.stringify(conflict) + '\n')
    const second = fs.readFileSync(legacy)
    assert.throws(() => writer.append_input({ ...f, text: 'must stop' }), /conflict.*owner|owner.*conflict/i)
    assert.deepEqual(fs.readFileSync(canonical), first)
    assert.deepEqual(fs.readFileSync(legacy), second)
  } finally { drop(repo) }
})

test('failed owner migration leaves the legacy owner and notebook unchanged', t => {
  const repo = temp_repo()
  try {
    const f = legacy_runtime_fixture(repo)
    const writer = require('./notebook-write')
    const owner = require('./notebook-owner')
    writer.append_input({ ...f, text: 'original request' })
    const canonical = owner.location(f).file
    const legacy = path.join(repo, 'legacy notes/.tmp', path.basename(canonical))
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.renameSync(canonical, legacy)
    const original = fs.readFileSync(legacy)
    const notebook = fs.readFileSync(path.join(repo, f.notebook))
    const replace = writer.atomic_replace
    t.mock.method(writer, 'atomic_replace', (file, ...args) => {
      if (file === canonical) throw Error('injected canonical owner write failure')
      return replace(file, ...args)
    })
    assert.throws(() => writer.append_input({ ...f, text: 'must not capture' }), /injected canonical owner/)
    assert.deepEqual(fs.readFileSync(legacy), original)
    assert.deepEqual(fs.readFileSync(path.join(repo, f.notebook)), notebook)
    assert.equal(fs.existsSync(canonical), false)
  } finally { t.mock.restoreAll(); drop(repo) }
})

test('legacy input receipts preserve deduplication when a new receipt is written canonically', () => {
  const repo = temp_repo()
  try {
    const f = legacy_runtime_fixture(repo)
    const writer = require('./notebook-write')
    writer.append_input({ ...f, text: 'original request', message_id: 'original' })
    const name = fs.readdirSync(path.join(repo, '.agentflow/.tmp')).find(name => name.startsWith('agentflow-input-portable-'))
    const canonical = path.join(repo, '.agentflow/.tmp', name)
    const legacy = path.join(repo, 'legacy notes/.tmp', name)
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.renameSync(canonical, legacy)
    const original = fs.readFileSync(legacy)
    const before = fs.readFileSync(path.join(repo, f.notebook))
    writer.append_input({ ...f, text: 'original request', message_id: 'original' })
    assert.deepEqual(fs.readFileSync(path.join(repo, f.notebook)), before)
    writer.append_input({ ...f, text: 'new request', message_id: 'new' })
    assert.ok(fs.existsSync(canonical))
    assert.deepEqual(fs.readFileSync(legacy), original)
    assert.equal((fs.readFileSync(path.join(repo, f.notebook), 'utf8').match(/original request/g) || []).length, 1)
  } finally { drop(repo) }
})

test('legacy completion evidence remains readable and new metadata is written canonically', () => {
  const repo = temp_repo()
  try {
    const f = legacy_runtime_fixture(repo)
    require('./notebook-write').append_input({ ...f, text: 'save evidence' })
    const completion = require('./completion-record')
    const ctx = { project_root: repo, notebook_path: f.notebook, ask: 'A-001', host: f.host, session: f.session }
    const reply = '## [SUMMARY]\n\nSaved evidence.\n\n```completion-metadata\nInformational document: note.txt — fixture evidence\n```\n'
    const published = completion.publish_reply(reply, ctx)
    const canonical = completion.location(ctx)
    const legacy = path.join(repo, 'legacy notes/.tmp/A-001')
    fs.mkdirSync(legacy, { recursive: true })
    const legacy_file = path.join(legacy, 'completion.json')
    fs.renameSync(canonical.file, legacy_file)
    fs.renameSync(canonical.reference_file, path.join(legacy, 'completion.ref.json'))
    const old = fs.readFileSync(legacy_file)
    const read = require('./round-linter').completion_metadata
    assert.equal(read(published, ctx).error, '')
    assert.equal(completion.publish_reply(reply, { ...ctx, read_only: true }), published)
    assert.equal(fs.existsSync(canonical.file), false)
    const changed = completion.publish_reply(reply.replace('note.txt', 'next.txt'), ctx)
    assert.ok(fs.existsSync(canonical.file))
    assert.match(read(changed, ctx).text, /next.txt/)
    assert.deepEqual(fs.readFileSync(legacy_file), old)
    const digest = require('node:crypto').createHash('sha256').update(old).digest('hex')
    const linked = `Completion record: [A-001](.tmp/A-001/completion.json) sha256:${digest}\n`
    assert.equal(read(linked, ctx).error, '')
    assert.match(read(linked, ctx).text, /note.txt/)
  } finally { drop(repo) }
})
