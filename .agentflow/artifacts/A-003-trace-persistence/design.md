# Persistent prompt trace mode

## Outcome and scope

Change Codex prompt tracing from only a one-prompt trigger into an explicit mode that stays enabled for this checkout until disabled. Keep the existing one-shot commands compatible. This is an L3 — Basic Direct change to the prompt hook, its focused tests, and the relevant user instructions. Record the separate inaccurate-model incident in `Task.md`; fixing model attribution is not included in this implementation.

## Current and proposed behavior

| Current | Proposed |
| --- | --- |
| Only exact `godev trace` / `godev trace full` prompts receive trace context. | `godev trace enable` turns on summary tracing for subsequent prompts in this checkout; `godev trace disable` turns it off. |
| No mode is saved. | A small local state file under ignored `.agentflow/.tmp/` persists the mode across prompts and host restarts without changing tracked project settings. Default is off. |
| Other prompts receive no trace context. | While enabled, each Codex prompt receives the existing bounded trace context and final-line instruction. The enable/disable command itself only confirms the change; disabling takes effect immediately for later prompts. |
| `godev trace` and `godev trace full` are one-shot. | Preserve both one-shot forms; `full` remains bounded and per-invocation. |

The mode is local to this checkout, not shared with other clones or worktrees. Enabling warns once that each traced prompt adds approximately 40–70 tokens; do not repeat the cost estimate in every response. The hook makes no extra model call. Model reporting continues to use only the exact current hook value; the separately recorded model-attribution issue remains open.

## Minimality check

The smallest solution is one local on/off state record, exact enable/disable prompt controls, and a hook check that reuses the existing trace formatter. A tracked `ag.json` setting would make a personal verbosity mode appear as a shared project change; a new general settings schema or a separate routing trace system is unnecessary. Keep the current one-shot route flags and formatter unchanged.

## Invariants

- **INV-1 — Default-off behavior:** starting from no mode file, ordinary prompts behave exactly as before and receive no trace context.
- **INV-2 — Explicit persistence:** after an exact enable command, prompts in the same checkout remain traced until an exact disable command; disabling prevents trace context on subsequent prompts.
- **INV-3 — Checkout isolation:** mode state is confined to the validated checkout's ignored `.agentflow/.tmp/` path and never changes tracked settings or another checkout.
- **INV-4 — Existing trace contract:** one-shot summary/full behavior, redaction, captured current-model source, and worker-count rules remain unchanged; no worker or additional model call is introduced.

## Acceptance criteria

- **AC-1 (INV-1):** hook tests show default-off prompts remain ordinary and do not display/inject trace fields.
- **AC-2 (INV-2):** an enable command persists the mode; a later ordinary prompt traces; disable turns it off for the next prompt. The toggle confirmations are clear and do not claim that the same input was traced.
- **AC-3 (INV-3):** tests prove state is local to the exact checkout, written atomically, defaults off when absent, and fails closed when malformed; no tracked configuration is edited by toggling.
- **AC-4 (INV-4):** existing one-shot trace/redaction contracts pass; trace adds no worker or model call and reports the current model only from the current hook input.
- **AC-5:** prompt-control/compression and focused hook recovery tests pass; `git diff --check` passes. Because this changes a user-facing prompt control, run a real Codex PTY journey if the host supports it; otherwise report the concrete host limitation and use the available integration contract tests.

## Normal journey

In a disposable checkout, run `godev trace enable`, confirm the one-time cost note, submit an ordinary prompt and observe the trace notice plus final trace line, then run `godev trace disable` and verify the next ordinary prompt has no trace context. Also verify `godev trace` and `godev trace full` still trace only their own prompt. Inspect the local mode file and confirm tracked configuration and unrelated worktree paths are unchanged.

## Open decisions

- None. The local checkout scope and default-off behavior are selected to avoid turning a personal trace preference into a shared project setting.
