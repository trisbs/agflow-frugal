'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const parse_worktrees = output => String(output).trim().split(/\r?\n\s*\r?\n/u).filter(Boolean).map(block => {
  const record = {}
  for (const line of block.split(/\r?\n/u)) {
    const split = line.indexOf(' ')
    if (split < 0) record[line] = true
    else record[line.slice(0, split)] = line.slice(split + 1)
  }
  return record
})

const registered_worktrees = repo => {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8', timeout: 5000 })
  if (result.error || result.status !== 0) {
    const detail = result.error?.code === 'ENOENT' ? 'Git is unavailable' : 'Git worktree registration could not be read'
    throw new Error(`${detail}; verify Git and the repository, then repair the stream pointer`)
  }
  return parse_worktrees(result.stdout)
}

const regular_notebook = (worktree, relative, taskkey) => {
  const candidate = path.resolve(worktree, ...relative.split('/'))
  const inside = path.relative(path.resolve(worktree), candidate)
  if (inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) throw new Error(`stream ${taskkey} has an unsafe configured notebook path`)
  try {
    const stat = fs.lstatSync(candidate)
    const real_root = fs.realpathSync(worktree)
    const real_file = fs.realpathSync(candidate)
    const real_inside = path.relative(real_root, real_file)
    if (!stat.isFile() || stat.isSymbolicLink() || real_inside.startsWith(`..${path.sep}`) || real_inside === '..' || path.isAbsolute(real_inside)) {
      throw new Error('not a regular notebook inside its registered worktree')
    }
  } catch (error) {
    throw new Error(`stream ${taskkey} notebook is unavailable in its registered worktree: ${error.message}`)
  }
}

const canonicalize_root_streams = ({ repo, features, streams }) => {
  if (!Array.isArray(streams)) throw new Error('root STATUS streams must be an array')
  const feature_root = path.posix.normalize(String(features || '').replaceAll('\\', '/'))
  if (!feature_root || feature_root === '.' || feature_root.startsWith('/') || feature_root === '..' || feature_root.startsWith('../')) {
    throw new Error('configured stream workspace must be a repository-relative path')
  }
  const active = streams.filter(stream => stream && stream.state === 'active')
  const keys = new Set()
  if (active.length === 0) return { streams }
  const worktrees = registered_worktrees(repo)
  const normalized = streams.map(stream => {
    if (!stream || stream.state !== 'active') return stream
    const key = String(stream.taskkey || '')
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(key)) throw new Error(`root STATUS has an invalid active stream key: ${key || '(missing)'}`)
    if (keys.has(key)) throw new Error(`root STATUS repeats active stream ${key}`)
    keys.add(key)
    const canonical = `${feature_root}/${key}/${key}.devlog.md`
    const worktree = worktrees.find(record => record.branch === `refs/heads/${key}`)
    if (!worktree?.worktree) throw new Error(`no registered worktree exists for active stream ${key}; expected ${canonical}`)
    regular_notebook(worktree.worktree, canonical, key)
    const physical = path.relative(repo, path.join(worktree.worktree, ...canonical.split('/'))).split(path.sep).join('/')
    if (stream.path !== canonical && stream.path !== physical) {
      throw new Error(`active stream ${key} path does not match its registered worktree; expected ${canonical}; re-read Git worktree status and correct the STATUS pointer`)
    }
    return { ...stream, path: canonical }
  })
  return { streams: normalized }
}

module.exports = { canonicalize_root_streams, parse_worktrees }
