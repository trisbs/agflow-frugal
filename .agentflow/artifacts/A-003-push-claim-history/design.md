# Design — keep historical push descriptions out of current closeout claims

## Identity

- Original Ask: `godev finish tasks we added today`
- Task: `.agentflow/artifacts/A-003-remote-handoff/Task.md` — “Keep historical push descriptions from blocking unrelated closeout”
- Normal journey: close a local task whose prior Ask or RUN history describes an old upstream push behavior, then verify current delivery claims against the observed Git push facts.
- Current source: `skills/agflow-frugal/scripts/round-linter.js`
- Exact plan commit: recorded in Task.md and the A-003 progress log after commit.

## Outcome and scope

Make the closeout check evaluate claims about the current delivery without treating earlier Ask or RUN history as a report that the current task was pushed. A real current Reply or current terminal-output claim that a push succeeded must still match observed push facts.

In scope:

- `skills/agflow-frugal/scripts/round-linter.js`
- `skills/agflow-frugal/scripts/round-linter.test.js`
- `Task.md`
- `.agentflow/devlog.md`
- this design and the resulting A-003 review report

No push, release, installed-copy update, or provider call is part of this task.

## Approach

Use the current non-empty round’s parsed `reply_text` plus the current terminal output as the claim sources for `lint_push_claim`. Do not scan the current round’s Ask or historical RUN/WIP records. Keep the existing assertion, denial, question, hypothetical, and host-result checks unchanged. Add a round-linter fixture with historical push language in an earlier RUN and a current no-push Reply, plus controls proving that an unverified current success claim fails and a success claim with matching host push facts passes.

This uses the round parser already consumed by nearby checks. It requires no new metadata format, persisted state, phrase heuristics, or changed push operation.

## Invariants

- **INV-1 — History is not current delivery evidence.** Given push-success wording only in the Ask or an earlier RUN/WIP, the current delivery check does not treat it as a claim for the current round.
- **INV-2 — Current success claims require matching facts.** Given a current Reply or terminal-output assertion that the work was pushed, the check passes only when the host reports an existing remote and successful push result.
- **INV-3 — Existing claim language stays protected.** Existing tests for denials, questions, promises, hypotheticals, and assertive success claims retain their outcomes.
- **INV-4 — No publication authority changes.** The change affects closeout claim validation only; it does not run or authorize Git push.

## Acceptance criteria

- A deterministic round-linter test places a historical statement such as “the original command pushed to origin” in the prior RUN record and a current Reply saying the current round did not publish; with unsuccessful/no-push host facts, `push_claim_valid` passes. This proves the historical statement no longer blocks the current delivery.
- A current Reply asserting a successful push with unsuccessful host facts fails.
- The same current success assertion with matching remote and exit-code facts passes.
- Existing push-claim cases in `round-linter.test.js` pass unchanged.
- The normal A-003 local close journey passes with the historical RUN intact and no push performed.
- `git diff --check` passes; the review records the exact implementation commit and all three verdicts.

## Minimality check

The smallest sufficient change is to inspect only the active Reply and current terminal output. Removing any current assertion check would weaken push-result validation. Adding a new structured claim field or natural-language history detector would add formats and edge cases without helping this reproduction. The parser already exposes the current round’s `reply_text`, so no new parser or state is needed.

## Routing and review

- Classification: L4 — Basic Direct. The check protects claims about an external publication action; the targeted parser-boundary tests provide deterministic evidence for the bounded change.
- Execution: host implementation; no external worker or paid call.
- Review: one full host review under `prefer-independent` if no separate reviewer capability is available; disclose that it is not independent.
- Source edits remain blocked until exact `Design Go: <unique 7-hex plan commit prefix>` is recorded in the current Ask.

## Open decisions

- None.
