'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const present = file => {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
};

// A failed Git command is not proof of a plain folder. Inspect ancestors too:
// callers may be below a checkout root, and worktrees use a .git file.
const has_metadata = root => {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const marker = path.join(directory, '.git');
    if (present(marker)) {
      // Sandboxed hosts may expose an empty, read-only .git directory at a
      // shared temporary parent. It is not repository metadata. Keep an empty
      // marker at the requested root suspicious, and retain every non-empty
      // marker as evidence so malformed repositories still fail closed.
      const stat = fs.lstatSync(marker);
      if (directory !== root && stat.isDirectory() && fs.readdirSync(marker).length === 0) {
        // Continue looking: a real repository may still be higher in the tree.
      } else {
        return true;
      }
    }
    if (['HEAD', 'objects', 'refs'].every(name => present(path.join(directory, name)))) return true;
    if (path.dirname(directory) === directory) return false;
  }
};

const detect = (project_root, options = {}) => {
  try {
    const root = fs.realpathSync(project_root);
    const env = options.env || process.env;
    const has_git_overrides = Boolean(env.GIT_DIR || env.GIT_WORK_TREE);
    const metadata = typeof options.has_metadata === 'function' ? options.has_metadata(root) : has_metadata(root);
    if (!has_git_overrides && !metadata) return { state: 'plain', root, reason: 'not_a_repository' };
    const run = options.spawn_sync || spawnSync;
    const result = run('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4096,
      env: { ...env, LC_ALL: 'C' },
    });
    if (result.status === 0 && result.stdout.trim()) {
      // An unborn repository is still Git-backed; HEAD is not the discriminator.
      return { state: 'git', root: fs.realpathSync(result.stdout.trim()) };
    }
    const missing = result.error?.code === 'ENOENT';
    const not_repository = !result.error && result.status === 128 && /^fatal: not a git repository\b/u.test(result.stderr);
    if ((missing || not_repository) && !has_git_overrides && !metadata) {
      return { state: 'plain', root, reason: missing ? 'git_not_installed' : 'not_a_repository' };
    }
    return { state: 'error', detail: 'Cannot determine repository state safely; check Git availability, repository metadata, permissions, and Git environment overrides before retrying.' };
  } catch {
    return { state: 'error', detail: 'Cannot inspect the project or its ancestors; check the path and permissions before retrying.' };
  }
};

module.exports = { detect };
