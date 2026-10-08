# Keep stream creation local unless push is explicitly authorized

## Outcome and scope

`agf new` must create and commit a stream branch/worktree, notebook, and adjacent configuration locally without pushing to any remote merely because one is configured. A later push remains a separate action and requires an explicit owner request. Do not change stream delivery, merge-back, cleanup, or release push behavior in this task.

## Accepted approach

Remove the automatic remote-detection/push step from `agf new`; retain its existing local stream creation and continuation output. Update the stream rulebook and focused CLI tests to state and prove the local-only behavior. Prefer this over adding a flag, setting, or another command: the owner can request a separate push through the existing authorized Git workflow, and no new surface is required to prevent the unintended side effect.

## Minimality check

The smallest outcome is that `agf new` never writes to a remote. Removing its push block and adding a regression test with a configured local bare remote proves the boundary. A new setting/flag or stream push subcommand is unnecessary for this fix and would expand the interface; no remote delivery path is needed to satisfy the ask.

## Invariants

- **INV-1 — Local stream creation:** starting a stream preserves the local branch, worktree, stream notebook/configuration, and opening commit; with or without a configured remote, it makes no push attempt and creates no remote branch.
- **INV-2 — Explicit publication boundary:** this change does not invoke or authorize any push. A future push is a distinct owner-authorized action; existing explicitly requested delivery paths remain outside this task.
- **INV-3 — Existing workspace safety:** do not alter the current main notebook, unrelated dirty files, or installed skill copy.

## Acceptance criteria

- **AC-1 (INV-1):** the `agf new` integration test with a configured bare `origin` succeeds locally, leaves the remote feature ref absent, and confirms the worktree is clean with the stream-open commit present.
- **AC-2 (INV-1, INV-2):** tests pass for creation both with and without a remote; implementation contains no push invocation in the `new` path.
- **AC-3 (INV-2):** stream documentation states that creation is local-only and does not imply remote publication.
- **AC-4 (INV-3):** focused Agentflow tests and `git diff --check` pass; unrelated existing changes and the installed copy remain untouched.

## Normal journey

On a repository with a bare `origin`, run the public `agf new` flow for a unique task key. Verify the local branch/worktree and opening commit exist, `git ls-remote origin refs/heads/<taskkey>` is empty, and the stream worktree is clean. Repeat the focused case without a remote. No network push is run.

## Open decisions

- None. The exact plan must be approved by `Design Go: <7-hex-commit-prefix>` before source or test edits.
