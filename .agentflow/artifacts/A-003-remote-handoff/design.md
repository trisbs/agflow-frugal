# Remote-session continuation without manual handoff

## Outcome

Let a fresh supported host session continue the current unfinished Ask from its canonical notebook with one explicit `godev` startup. No manual owner token, notebook hash, or adoption command. Keep one writer and fence the previous session after transfer.

## Scope

- Extend the existing Codex-only startup handoff to supported native hosts with verified host/session identity.
- Transfer only the configured canonical notebook's current open Ask on explicit `godev` startup.
- Preserve same-session behavior, prompt capture, completion, and linked-worktree path rules.
- Keep bounded handoff history. Never infer stale ownership from age or process state.
- No installed-copy update, publication, push, or unrelated changes.

## Proposed behavior

1. Before waiting for the serialized startup/write lock, read a snapshot of the owner token and notebook hash.
2. Same-owner startup uses the existing path. Cross-session transfer requires an exact `godev` startup, the current open Ask, verified native identity, and an unchanged pre-lock snapshot.
3. Under the lock, compare token and hash again; only then rotate the owner token, record the bounded handoff event, and capture the message. A stale contender refuses without mutation and is told to retry against current state.
4. Existing guards fence all later writes from the previous owner. Hooks and ordinary writers never transfer ownership.
5. Closed/non-current asks, ambiguous paths, unverified generic identities, and unowned legacy notebooks remain on explicit recovery paths.

## Invariants

- **INV-1 — One active writer:** at most one host/session owns an open Ask; token rotation fences the former owner from inputs, progress, and completion evidence.
- **INV-2 — Freshness:** transfer requires the pre-lock token and notebook hash to remain unchanged under lock; stale contenders cannot overwrite newer state.
- **INV-3 — Explicit continuation:** only owner-submitted `godev` startup can request automatic transfer; hooks and ordinary writers cannot.
- **INV-4 — Scope:** only the canonical notebook's current open Ask can transfer; never a closed Ask or another worktree's notebook.
- **INV-5 — Identity:** use verified native host/session markers or an explicit retained session; never infer identity from a generic host name, dirty file, or PID.
- **INV-6 — No manual credential exchange:** routine continuation requires no copied token/hash or adoption command; explicit adoption remains for unowned or ambiguous recovery.

## Minimality check

- Smallest outcome: explicit startup transfers the current open Ask to the verified session and fences the previous one.
- Simpler alternative considered: ignore ownership and permit every session to write the shared notebook. Rejected because concurrent or delayed writers could change the same Ask without fencing.
- Retained mechanisms: pre-lock snapshot plus under-lock comparison resolves racing claims; token rotation fences stale writers; exact `godev` provides intent; canonical-path checks prevent cross-notebook takeover.

## Acceptance criteria

- A fresh native Codex or Claude session resumes an active Ask with one `godev` startup, no separate authorization, token/hash, or adoption command. Prove with host-specific startup tests.
- The owner record names old and new identities; old-session writes fail without changing notebook bytes. Prove with transfer and stale-writer tests.
- Same-session startup remains unchanged and creates no false handoff event. Prove with a regression test.
- Two sessions racing from the same snapshot produce at most one transfer; the loser mutates nothing and gets a retry instruction. A later fresh startup can continue. Prove with a barrier-based concurrent-start test.
- Missing/ambiguous identity, changed token/hash, closed/non-current Ask, or non-`godev` startup fails closed without notebook mutation. Prove with negative tests.
- Run focused ownership/startup suites and the full relevant script suite; run a PTY journey if supported. Do not update installed files, push, or release.

## Gate

This design is proposed. Do not edit implementation source until `Design Go: <full design commit>`. That decision authorizes an explicit `godev` startup to fence the previous session without another confirmation; do not use time-based staleness.
