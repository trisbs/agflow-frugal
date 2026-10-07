# Agentflow Frugal Profile

## Status

This repository implements a compatibility-first, ChatGPT Plus-oriented Agentflow profile. The policy is an engineering optimization, not a claim that Agentflow can read a user's remaining ChatGPT Plus quota.

The governing rule is:

> Route each task directly to the cheapest reasoning level capable of completing it safely.

The escalation rule is:

> Spend another model call only when its expected information or correctness gain clearly justifies the usage.

## Persistent installation preference — retain this rule

- Do not automatically install, update, replace, or synchronize the user's installed Agentflow version as part of project startup, development, testing, or release preparation. Changes to this repository do not authorize changes to an installed copy.
- Update the installed version only after the user explicitly asks for that update. Until then, leave installed skill files and installation paths unchanged.
- This is a persistent owner preference, not a temporary release checklist item. Preserve it when reorganizing or pruning `Task.md`; do not delete or weaken it.

## P0 — Resolve nested Git subprocess `EPERM` before release — fixed for reproduced case

**Status: implementation fixed for the reproduced failure; release remains gated on the complete suite.** The immediate cause was an empty read-only `/tmp/.git` sentinel exposed by this Codex environment. `repository-state.js` treated every ancestor `.git` directory as repository metadata, so plain-folder checks unnecessarily invoked Git; deeper test/PTY process trees then produced `EPERM`. It now ignores only empty `.git` directories above the requested project root. An empty `.git` at the requested root, non-empty/broken repository metadata, and environment overrides still fail closed. Minimal reproduction: a plain directory below an empty ancestor `.git` previously returned `state: error`; after the change it returns `state: plain` without invoking Git. The focused regression and affected closeout/hook/PTY suites pass. A complete suite run is still needed after resolving its separate non-EPERM failures; do not release or mark R8 complete until all acceptance checks pass.

### Upstream comparison: original Agentflow

The imported baseline identifies upstream as [`agfnow/agentflow`](https://github.com/agfnow/agentflow) (the repository README says `npx skills add agfnow/agentflow`; baseline snapshot `4b4a31a` records upstream commit `8527813`). In that baseline, `stop-hook.js` directly runs Git through `execFileSync` to gather push facts and catches failures as empty/unknown facts; it does not first classify repository state through the newer dedicated `repository-state.js` contract. Its tests also run child Node commands for hook fixtures, so this comparison does **not** prove that the original avoids every nested-process restriction. The Frugal redesign added stronger repository-state validation and plain-folder closeout coverage. In this environment, an empty `/tmp/.git` sentinel was mistakenly treated as repository metadata, which made plain-folder checks invoke Git inside deeper test/PTY process trees and exposed `EPERM`. The filesystem-only sentinel check now avoids that unnecessary call while preserving fail-closed handling of actual or suspicious metadata. This explains the reproduced failure; it does not prove every environment-specific nested-process failure has the same cause.

## Architecture

The ordinary workflow has four conditional capabilities:

1. **Understand** — combine requirements with a targeted codewalk.
2. **Resolve Uncertainty** — use only for a named unresolved question.
3. **Execute** — follow the selected execution class directly.
4. **Verify** — prefer deterministic evidence over another model invocation.

The common path is `Understand → Execute → Deterministic Verify → Done`.

Existing Agentflow notebook, ownership, Git, parsing, validation, settings, and closeout infrastructure remains intact.

## Target staged routing

The agreed target separates inexpensive task admission from substantive execution. The main session applies a conservative Cheap gate that returns only L0, L1, or `ESCALATE`; it does not distinguish the higher execution classes. Any missing fact, ambiguity, risk signal, or unverifiable assumption escalates to a no-write `basic` assessment. That assessment returns structured routing facts and classifies L2-L5 before execution. It cannot lower a risk floor already established by the Cheap gate.

The target flow is:

1. **L0/L1:** launch the configured `cheap` executor only when scope, reversibility, impact, and deterministic verification are all established.
2. **Escalated assessment:** launch `basic` without write authority; require structured routing facts for L2-L5 before planning execution.
3. **L2:** launch `basic`; it performs the reasoning, execution, and verification directly.
4. **L3:** launch `basic`; it plans and executes the bounded work without routine additional delegation.
5. **L4:** launch `basic` as the primary executor or coordinator. Launch one `better` worker only when material risk remains after deterministic verification.
6. **L5:** launch `basic`, require an accepted `better` review, then use two `better` perspectives only when the complete Debate gate passes; finish with one accepted `basic` synthesis.

The main session remains the orchestration owner. A worker reports a structured escalation request; it does not recursively start another worker. `cheap`, `basic`, and `better` are provider-independent tier names resolved through the selected worker profile. This keeps worker depth, retries, cost, and cancellation observable. `best` is not a routing level in this design. If the configuration schema still requires a `best` entry, it is a compatibility-only alias of `better`, and no pipeline role requests it.

The routing gate may classify work as L0/L1 only when all of the following are true:

- the requirement has one clear interpretation;
- the change is reversible and has no material consequence;
- authentication, authorization, payment, deployment, data migration, destructive data handling, and other high-risk signals are absent;
- the affected boundary is known;
- deterministic verification is available; and
- no required information is missing.

Failure to prove any condition escalates to `basic`. A model-reported confidence score is not sufficient evidence. L0/L1 execution uses `cheap`; it is not tied to Luna.

### Model profiles before GPT-6.1 Sol is available

| Responsibility | Model and effort | Use |
| --- | --- | --- |
| Main session | `gpt-5.6-luna/medium` | Conservative routing gate, orchestration, and final delivery |
| `cheap` | `gpt-5.6-luna/low` | Codex-profile L0/L1 execution; another provider may map `cheap` to a different model |
| `basic` | `gpt-5.6-terra/medium` | L2/L3 primary execution and L4/L5 coordination |
| `better` | `gpt-5.6-sol/low` | Conditional L4 review and L5 Debate work |
| `best` | alias of `better` if schema-required | Never selected by routing |

### Model profiles after GPT-6.1 Sol is available

| Responsibility | Model and effort | Use |
| --- | --- | --- |
| Main session | `gpt-6-luna/medium` | Conservative routing gate, orchestration, and final delivery |
| `cheap` | `gpt-6-luna/low` | Codex-profile L0/L1 execution; another provider may map `cheap` to a different model |
| `basic` | `gpt-6.1-sol/low` | L2/L3 primary execution and L4/L5 coordination |
| `better` | `gpt-6.1-sol/medium` | Conditional L4 review and L5 Debate work; this is the maximum quality tier |
| `best` | alias of `better` if schema-required | Never selected by routing |

These Codex mappings are routing targets. Other worker profiles may map the same tiers to different model families.

## Execution classes

- **L0 Mechanical:** Cheap Direct only after every admission safety condition is proven.
- **L1 Simple:** Cheap Direct only after every admission safety condition is proven.
- **L2 Reasoning:** Basic Direct for uncertainty, diagnosis, planning, incomplete information, or an unproven cheap-admission condition.
- **L3 Reasoning plus mechanical execution:** Basic Direct for reasoning followed by substantial bounded execution.
- **L4 High Risk:** Basic Direct; add one Better review only when deterministic verification cannot resolve material risk.
- **L5 Exceptional Deliberation:** Basic Coordinator; use Better workers only when the complete Debate hard gate passes.

Classification is domain-neutral and conservative. Explicit metadata may raise a class but cannot lower the class implied by verified facts. Ambiguous work and missing information use L2 Basic Direct.

## Deterministic policy

`skills/agflow-frugal/scripts/usage-policy.js` provides pure functions for classification, routing, review and Debate gates, budget pressure, and telemetry records. It makes no model call and writes no state.

`skills/agflow-frugal/scripts/routing-coordinator.js` first consumes Cheap admission facts. For escalated work it requires an accepted, no-write Basic assessment record with `outputs.routing_assessment`, preserves the Cheap risk floor, then consumes the resulting decision one stage at a time. It selects the configured tier through the existing transport-neutral selector and refuses to advance without accepted execution evidence. L5 review facts are supplied separately after the review is accepted.

## Detailed implementation roadmap

The deterministic Usage Policy, coordinator, lifecycle, version-1 contracts, frozen brief digests, redacted atomic state, resume identity checks, profile-backed CLI planning, usage budgets, settled-failure handling, and external transport attribution are implemented.

Current status as of 2026-10-07: R1-R7 have focused contract coverage, and R8 remains in progress. The routing, external-runner, and provider-adapter regression passed 96/96; focused provider-adapter tests passed 4/4. Current Codex CLI 0.160.1 and Claude Code 2.1.266 help output confirms the adapter flags are recognized; no authenticated provider call was made. R8.4 validates a version-1 recipe's provider family and exact configured cheap-tier model/effort, confirms a cheap-tier plan before warning or launch, applies provider model/effort flags, parses structured output, and retains unknown actual attribution when output does not expose it. The empty-ancestor `.git` false-positive is fixed; the affected repository-state, stop-hook, recovery, and PTY suites pass 76 tests with one filesystem-specific skip. The complete suite now runs but has separate non-EPERM failures in existing guide and round-linter assertions; R8 is not complete. The actual installed shortcut was unavailable in this shell and has not been verified. The routing work is still **not production-ready**.

The active project `ag.json` uses `cheap: gpt-6-luna/low`, `basic: gpt-6.1-sol/low`, and `better: gpt-6.1-sol/medium`; `best` aliases `better`. Planning roles use Basic and security scan uses Better. This changes project worker settings; template defaults and the interactive main-session model have not been changed.

Native and host execution remain explicit adapter boundaries because this repository cannot fabricate real native handles or host-session controls. The live-provider file remains default-deny and opt-in. Deterministic tests prove command construction and conservative parsing, not authenticated provider execution, real cost behavior, or remote cancellation. No paid provider call belongs in the default test suite.

The implementation is divided into ordered phases. A later phase must not duplicate or bypass the contracts established by an earlier phase.

## Review remediation plan

The following stacks must be completed in order before the routing implementation is treated as production-ready. Each stack begins with focused failing tests, preserves compatibility unless the contract intentionally changes, and ends with focused tests plus `git diff --check`.

### Stack R1 — Fail-closed coordinator acceptance

Status: completed at the focused-contract level. Coordinator acceptance requires observed checks, scope inspection, valid output, and accepted evidence; rejected attempts cannot advance lifecycle state. Final confirmation remains part of R8's consolidated journeys.

Goal: prevent successful process completion or nonempty worker output from becoming automatic acceptance.

Required logic:

```text
raw transport result
    → normalize settled attempt
    → validate task, source, and brief identities
    → validate stage output contract
    → inspect actual changed paths
    → run coordinator-owned verification commands
    → validate requested transport controls
    → construct accepted execution record or rejected attempt
```

Implementation requirements:

1. remove defaults that infer `checks_run`, `coordinator_inspected`, or `accepted` from process completion;
2. require every changed path to be contained by the frozen `work_boundary`;
3. require named verification commands to have coordinator-observed results;
4. keep worker claims separate from coordinator evidence;
5. return the exact failed acceptance requirement;
6. allow only accepted execution records to advance lifecycle state.

Tests:

- a completed runner with an out-of-bound change is rejected;
- a completed runner without coordinator checks is rejected;
- worker-supplied `accepted: true` has no authority;
- a valid attempt advances exactly one stage.

### Stack R2 — Provable read-only assessment

Status: completed at the fixture-contract level. Literal provider recipe evidence is separated from post-run zero-change checks and from unproven OS/network/credential isolation. Live-provider proof remains an R8 item.

Goal: treat read-only as an observed transport property rather than a requested task flag.

Implementation requirements:

1. add a provider-recipe contract describing the concrete read-only control;
2. record the literal dispatch arguments or native control evidence used;
3. reject assessment selection when the chosen provider cannot prove source read-only operation;
4. verify after execution that source identity is unchanged and `changed_paths` is empty;
5. distinguish provider-enforced read-only, post-run zero-change verification, and unproven OS, network, or credential isolation;
6. never derive `transport.read_only` from `task.require_read_only`.

Tests:

- requested read-only without transport proof is rejected;
- transport proof with a changed source path is rejected;
- an unavailable read-only capability produces a settled `unavailable` attempt;
- a proven read-only assessment may advance to classification.

### Stack R3 — Safe and minimal routing persistence

Status: completed for the single-file state implementation. `state.json` is the sole authoritative persisted object; stage briefs, attempts, accepted records, and usage are fields in its validated, redacted state. Allowlisted redaction, symlink rejection, atomic replacement, interrupted replacement, revision chaining, and stale-writer rejection have focused tests.

Goal: prevent path escape, secret persistence, partial writes, and stale concurrent updates.

Implementation requirements:

1. validate every path component below the configured workspace and reject symlinks before directory creation or file replacement;
2. verify the resolved routing root remains inside the resolved workspace;
3. persist an explicit allowlisted state schema instead of copying full routing facts;
4. exclude environment maps, credentials, tokens, raw provider arguments, unrestricted prompts, and other secret-bearing runner options;
5. store bounded redacted diagnostics separately from durable coordinator evidence;
6. write temporary files in the destination directory, fsync, atomically rename, and fsync the parent directory;
7. store a monotonic revision and prior-state digest;
8. reject stale writers through compare-and-swap validation;
9. make `inspect` return only the public, redacted projection.

Tests:

- a symlink in any routing path component is rejected;
- routing state cannot be written outside the workspace;
- environment values and credentials never appear in persisted files or `inspect`;
- interrupted writes preserve the last valid state;
- a stale revision cannot overwrite newer state.

### Stack R4 — Resume identity revalidation

Status: completed at the focused-contract level. Resume re-observes source/configuration identity and rejects stale or tampered evidence before launch. The interrupted-lifecycle journey without repeated accepted work remains to be proven end to end in R8.

Goal: resume only when current external state still matches the accepted evidence.

Required resume checks:

```text
persisted state digest is valid
AND current source identity is freshly observed
AND current configuration digest matches
AND every accepted record matches its frozen brief digest
AND requested transport controls still match
AND native or host handles remain valid when applicable
```

Implementation requirements:

1. observe repository identity at resume time rather than copying it from persisted facts;
2. compute and compare configuration and brief digests;
3. reject changed work boundaries, verification commands, model requirements, or transport controls;
4. return `invalid` with a machine-readable mismatch reason;
5. never repeat an already accepted stage after a valid resume.

Tests:

- stale source identity is rejected;
- changed configuration or brief digest is rejected;
- a valid interrupted task resumes at the next unaccepted stage;
- tampered state is rejected before any adapter launch.

### Stack R5 — Usage budgets and settled failure handling

Status: completed. Coordinator-owned launch and accepted-stage counters are persisted with routing state; settled failures remain visible, and only `unavailable` can enter finite fallback. Verified by routing lifecycle, runner, state, resume, read-only, and execution suites.

Goal: make policy limits and fallback decisions reflect real attempts.

Implementation requirements:

1. update workflow usage only from coordinator-observed launches and accepted stages;
2. count external workers, reviews, Debate perspectives, syntheses, retries, discovery iterations, and expensive calls at their defined boundaries;
3. evaluate pressure and budget before planning the next action;
4. persist every settled unsuccessful attempt;
5. preserve `unavailable`, `task-failed`, `cancelled`, and `uncertain` as distinct states;
6. allow fallback only after a settled `unavailable` attempt;
7. prevent automatic relaunch after `task-failed`, `cancelled`, or `uncertain`;
8. enforce the six-action lifecycle ceiling independently of policy budgets.

Tests:

- an L5 path updates every applicable counter;
- a reached limit stops before another worker launch;
- only `unavailable` may enter the finite fallback selector;
- unsuccessful attempts remain visible after resume;
- `uncertain` and `cancelled` never relaunch automatically.

### Stack R6 — CLI and profile integration

Status: completed for the direct Node CLI contract. `agf route` accepts the documented stdin/task forms, resolves external candidates exclusively from `ag.json`, and returns structured JSON with deterministic exit codes. Generated wrappers now pass `route` directly to Node; installed shortcut fixtures verify stdout, stderr, exit codes, unchanged routing cwd, and preserved stream directory changes. R8.1 still requires the actual installed routing CLI journey rather than a substitute fixture `agf.js`.

Goal: make the documented `agf route` interface and configured worker profiles authoritative.

Required interface:

```text
agf route plan    --facts-stdin
agf route run     --facts-stdin
agf route resume  --task <task-id>
agf route inspect --task <task-id>
```

Implementation requirements:

1. read initial facts from standard input for `plan` and `run`;
2. resolve `cheap`, `basic`, and `better` through the existing `ag.json` worker-profile configuration;
3. reject unknown profiles, unsupported provider recipes, and incompatible model or effort settings;
4. print exactly one structured JSON result to standard output;
5. send human diagnostics only to standard error;
6. map terminal states to documented deterministic exit codes;
7. preserve existing non-routing `agf` command behavior.

Tests:

- documented CLI forms work without positional substitutes;
- profile mappings select the configured provider, model, and effort;
- malformed standard input fails closed;
- standard output remains machine-readable;
- existing command tests remain unchanged and passing.

### Stack R7 — Actual transport attribution

Status: completed. External records now bind source identity to the observed clone HEAD, preserve an observed process PID when exposed, distinguish requested from observed model/effort, and fail closed for exact-identity gaps, source mismatch, and uncertain settlement. Verified by a real-child independent-clone fixture and the routing suites.

Goal: distinguish requested execution properties from properties observed from the provider or host.

Implementation requirements:

1. record requested and actual model or effort separately;
2. obtain actual source identity from the execution checkout or native host;
3. retain real process, task, thread, or session handles when exposed;
4. record fresh-context, read-only, cancellation, and process-settlement evidence only when observed;
5. mark unavailable evidence as unknown rather than copying requested values;
6. reject exact-model requirements when actual model evidence is missing or mismatched;
7. never fabricate native, host, or external transport fields.

Tests:

- requested model values cannot masquerade as actual values;
- clone HEAD mismatch is rejected;
- lost native or process ownership becomes `uncertain`;
- unavailable provider metadata remains explicitly unknown.

### Stack R8 — End-to-end and regression verification

Status: **R8 acceptance complete; release not performed.** `routing-journey.test.js` contains 19 passing real-process cases and covers Phase 9 items 1-12, including both L4 branches, both L5 outcomes, full L5 synthesis, settled-unavailable fallback, timed-out and owner-cancelled processes saved without relaunch, and positive CLI-level interrupted resume from accepted assessment to primary. The routing/external-runner/provider-adapter regression passes 96/96. `ag-settings.test.js` passed 82/82, and `agf.test.js` passed 175/175. R8.3 documents the single `state.json` authority and tests interrupted atomic replacement. R8.4 implements versioned Codex/Claude recipe checks, exact configured cheap-tier matching, preflight cheap-tier planning, provider-specific model/effort flags, structured-output parsing, and unknown-attribution fallback. The latest full script suite passes outside the restricted process sandbox. The installed shortcut/PTY journey passed against a valid disposable repository and its expected fail-closed result. Final diff review and `git diff --check` passed. No live provider was called; paid live-provider behavior remains unverified and is not claimed production-ready.

Goal: prove the complete workflow through real process boundaries and close existing regressions.

Work:

1. implement all twelve deterministic fixture journeys listed in Phase 9;
2. use an actual child process, independent no-remote clone, persisted attempts, accepted records, and resume;
3. add negative journeys for boundary escape, forged read-only evidence, secret persistence, exhausted budgets, and stale concurrent state;
4. fix the locale fallback so an `und` locale resolves to the documented English fallback across supported Node versions;
5. separate genuine test failures from sandbox-only `spawnSync git EPERM` failures;
6. run every routing test, the unchanged Agentflow script suite, and `git diff --check`;
7. keep the paid live-provider gate explicit and opt-in.

Completion criteria:

- none of the R1–R7 negative tests can advance lifecycle state;
- all twelve Phase 9 journeys pass deterministically;
- resume never repeats an accepted stage;
- persisted state contains no forbidden secret-bearing fields;
- documentation describes actual CLI and transport behavior;
- no production-readiness claim remains unsupported by deterministic evidence.

#### R8 remaining implementation plan

Complete these items in order; do not mark R8 complete from the existing focused tests alone.

1. **R8.1 — Installed CLI boundary**

   - Implemented: zsh/bash and fish wrappers pass `route` through directly and preserve the Node exit status; stream commands retain directory-changing behavior.

   - Verified: setup fixtures install shortcuts into disposable homes and check one JSON value, stderr diagnostics, exit codes, and routing cwd. All 44 setup tests pass in the combined run.

   - Installed copy updated on 2026-10-07 after the owner's explicit request; replaced files were backed up under `/tmp/agflow-frugal-installed-backup-20261007`, and extra installed-only files were preserved. The installed `setup.js` configured a disposable zsh home to use the actual installed scripts; its subsequent `setup.js --quiet` check exited 0. `/usr/bin/expect` invoked `agf route plan --facts-stdin` in a disposable no-Git repository with valid `ag.json` and facts. The PTY showed structured `unsatisfied` output and preserved exit 5 because no checked executor recipe was available. This confirms shortcut dispatch, stdin, terminal output, exit status, and fail-closed behavior; it does not claim successful execution. No user shell configuration or Codex hook was changed.

2. **R8.2 — Deterministic twelve-journey harness**

   - Keep the real-process journey harness; it now has 19 saved cases, including the prior six-case expansion.

   - Completed: all twelve Phase 9 fixture journeys, including both L4 branches, both L5 outcomes, settled-unavailable fallback, uncertain and owner-cancelled no-relaunch behavior, interrupted resume, and stale identity rejection. Do not count budget-blocked paths as successful full L4/L5 journeys.

   - Apply the resolved P1 budget change below; verify the full review/Debate paths without live provider calls. Continue independent negative, settlement, and resume work.

   - Implemented: the CLI API reloads and validates current `ag.json`, rehydrates the allowlisted stage briefs and launched-profile IDs from state, and accepts fresh transient provider recipes/adapters at resume time. The process journey stops after accepted assessment, reloads state, continues at primary, and proves the assessment was neither relaunched nor charged again. Provider command arguments, environment values, credentials, and adapters are not persisted.

   - Assert stage order, tier, observed launches, persisted attempts, records, and counters. Resume must start at the next unaccepted stage without relaunching or charging an accepted stage again.

3. **R8.3 — Persistence and documentation reconciliation**

   - Resolved: `state.json` is the sole authoritative durable object. The persisted allowlist contains frozen task/stage inputs, attempts, accepted records, and usage; no separate `briefs/`, `attempts/`, or `records/` files are promised. A failure-injected interrupted replacement preserves the last valid revision, and existing saved-byte checks reject prompt, command, raw-argument, environment, and credential values.

4. **R8.4 — Live-provider gate hardening**

   - Implemented: the version-1 recipe binds provider family and exact `cheap` tier/model/effort to the current configured profile; unsupported families and mismatches fail before launch. The gate validates current `ag.json`, plans before launch, refuses a non-cheap selection, and warns before invoking the provider. The adapter builds Codex and Claude command flags separately, parses their output formats, observes a single Claude model identifier if present, and leaves unavailable model/effort facts as `unknown`. CLI help and deterministic fake-provider tests verify command shape; no authenticated provider call was made.

   - Print authentication and possible-cost warnings to stderr before launch, require explicit `--run`, select the configured low-cost tier, and refuse any repository with a remote in the disposable execution checkout.

   - Record observed provider/model/effort facts only when provider output exposes them. Missing credentials settle as unavailable; missing identity remains unknown and fails exact-model/exact-effort requirements, never becoming a copied request value.

   - Keep one versioned provider-neutral recipe shape and validate each supported provider family independently; do not assume Codex and Claude flags or output formats are interchangeable.

5. **R8.5 — Regression and release evidence**

   - Passed after current changes: the complete Agentflow script suite (`node --test --test-reporter=dot skills/agflow-frugal/scripts/*.test.js`, exit 0); routing/external-runner/provider-adapter suite (96/96); provider-adapter suite (4/4); round-linter suite (320/320); prompt-compression suite (12/12); and affected repository-state/stop-hook/recovery/PTY suites (76 passed, one case-sensitive-filesystem skip, zero failed). `/usr/bin/expect` is present; PTY assertions accept both `/dev/tty*` and Linux `/dev/pts/*` paths.

   - Fixed the observed nested Git failure by ignoring only empty ancestor `.git` sentinels. Preserve fail-closed handling for explicit-root, non-empty, malformed, missing-Git-with-metadata, and Git-override cases. The latest full suite passed outside the restricted process sandbox; owner tests can hang or return `EPERM` inside it because they start nested Node/Git processes.

   - Updated the script reference, user-facing guide, and this file to match observed CLI, persistence, cancellation, and live-provider limitations. Native/host dispatch remains an explicit adapter boundary; real host handles are not fabricated.

   - Only after all checks pass may the status change to production-ready.

#### Plan controls and open decision

Outcome: complete R8 with reproducible process-boundary evidence and accurate documentation. Scope: the routing harness, defects exposed by its journeys, installed CLI validation, persistence contract, live-provider refusal checks, and final regression evidence. Keep unrelated notebook changes and provider settings intact.

Minimality check: extend the current fixture harness and existing adapters rather than add another routing engine. Prefer documenting the actual single-state-file layout unless a separate artifact is needed to satisfy a concrete invariant. No paid provider call is needed for deterministic coverage.

#### Release readiness decision — 2026-10-07

- Decision: **R8 is complete; do not publish or release in this task.** The full suite, installed shortcut/PTY journey, and final diff review passed. A later Phase 10 release still needs the versioned commit and delivery checks, and must be separately requested; no commit, push, or release was made here.

- Conditional stability: deterministic R8 acceptance and the installed boundary checks now pass, so the candidate is ready for Phase 10 review when authorized. Paid live-provider behavior is explicitly unverified and remains outside production-readiness claims.

- Evidence already passing: the complete script suite (latest exit 0 outside the restricted process sandbox), routing/external-runner/provider-adapter checks (96/96), provider-adapter tests (4/4), round-linter (320/320), prompt-compression (12/12), affected repository-state/stop-hook/recovery/PTY suites (76 passed, one skip), settings (82/82), `agf.test.js` (175/175), Git/plain-folder PTY journeys, and the installed-script shortcut PTY smoke from a disposable home/repository. The smoke correctly refused execution without a checked executor recipe.

- Known remaining limitation: installed validation used a disposable zsh home because this execution shell has no configured `agf` function. It exercised the actual installed script through a setup-generated shortcut in a PTY, but did not alter or verify the owner's persistent shell configuration. Keep the no-auto-update preference above intact for future tasks.

- Release reminder: after R8 is complete, run the Phase 10 delivery sequence, inspect the exact staged files and release version, commit under the session's recorded authorization, run the installed smoke journey again, and push only when separately authorized.

#### Recommended next-stage tasks

1. **Phase 10 release preparation.** Only after an explicit release request, verify the release version and exact staged files, create the versioned commit, and run delivery checks; do not push or publish without separate authorization.

2. Reconcile final R8 status and documentation, complete host review and minimality checks, then proceed to Phase 10 release preparation only after installed evidence and every acceptance check pass.

3. After release, implement token-efficient prompt-enabled run tracing. A request such as `godev trace` should set only a local per-run flag, collect compact structured events, emit one short line on stage transitions/errors, and expose details through a bounded terminal view. Derive data from existing state without another model call or prompt replay; keep it temporary by default and redact prompts, credentials, environment values, and raw provider arguments. Default to `summary`; support `full` only when explicitly requested.

## Invariants

- INV-1: Starting from the five saved journeys, a stage advances only with coordinator-accepted scope, checks, source, and brief evidence. Any rejected attempt that advances is a failure.
- INV-2: Starting from persisted accepted work, resume observes current identities and continues only at the next unaccepted stage. A stale identity, repeated accepted launch, or duplicate usage charge is a failure.
- INV-3: Starting from redacted atomic state, persistence keeps secrets out and rejects stale writers. Secret-bearing saved bytes or replacement by a stale revision is a failure.
- INV-4: Starting from the current budgets, limits and review requirements remain enforced until an explicit policy change is approved. Reporting completion with an outstanding required risk review is a failure.

## Acceptance criteria

- All twelve Phase 9 journeys pass through their required real process and persistence boundaries, including L4 variants and both settlement states; named stage/counter assertions prove INV-1 and INV-2. A blocked branch is recorded as blocked, not counted as a successful complete journey.
- Boundary escape and assessment writes are rejected; stale source/brief identity prevents dispatch; rejected/cancelled/uncertain work never relaunches automatically. The consolidated harness proves INV-1, INV-2, and INV-4.
- Saved-byte inspection, interrupted-write checks, and stale-writer tests prove INV-3; documentation names the tested durable layout.
- The actual installed shortcut preserves structured stdout, stderr, exit codes, and cwd; stream directory changes remain valid. The installed shell and PTY journeys supply the evidence.
- Every routing and unchanged Agentflow test passes in a Git-child-capable environment, and `git diff --check` passes. Fixture tests, model configuration validation, and live-provider authentication/attribution evidence remain separately identified.

P1 — Resolved by owner instruction: raise `external_workers` to 2, `independent_reviewers` to 2, and `expensive_calls` to 4. This lets the first external candidate and one accepted review leave headroom for the full three-launch Better sequence; reaching a raised ceiling still enters `CONSERVE`, and exceeding any hard cap still stops before launch. Keep every other limit unchanged. A second distinct external profile is available only for eligible fallback; no paid provider execution is authorized by this decision.

Plan approval does not answer P1, approve the pending source diff, authorize a paid call, or approve a commit. Template model defaults and user-facing model guidance still need reconciliation with the project settings; preserve explicit user preferences when deciding their scope.

#### Manual test plan after local installation

Use a disposable repository and the installed copy, not scripts from this development checkout. No paid call is required for steps 1-8.

1. **Install the current local candidate**

   ```sh
   npx skills add /home/tristan/codex_proj/agflow-frugal --skill agflow-frugal --agent codex -g -y
   node "$HOME/.codex/skills/agflow-frugal/scripts/setup.js" --fix
   ```

   Restart the terminal and Codex after setup reports that shell shortcuts or hooks changed.

2. **Verify installation discovery**

   ```sh
   agf setup
   type agf
   type agf-looper
   ```

   Pass condition: Node 18 or newer, Git, skill files, and both shortcuts are reported usable. An unavailable optional provider is informational, not an installation failure.

3. **Create an isolated project**

   ```sh
   test_root="$(mktemp -d)"
   git -C "$test_root" init -q -b main
   git -C "$test_root" config user.name "Agentflow routing test"
   git -C "$test_root" config user.email "routing-test@example.invalid"
   cd "$test_root"
   agf init
   ```

   Pass condition: `ag.json`, `.agentflow/devlog.md`, ignore entries, and the project hooks are initialized without touching another repository.

4. **Check route help and malformed-input failure**

   ```sh
   agf --help
   printf '%s' '{' | agf route plan --facts-stdin
   ```

   Pass condition: help lists the four documented route forms; malformed input emits one parseable JSON result with status `invalid`, exits nonzero, does not change directory, and does not launch a worker.

5. **Check configured profile planning**

   - Set a disposable checked fixture profile in the test project's `ag.json`; do not point this step at a paid provider.

   - Pipe an L1 facts object to `agf route plan --facts-stdin`, then an L2 facts object.

   - Pass condition: L1 selects `cheap`; L2 first selects read-only `basic` assessment; selected profile, model, effort, and literal command come from `ag.json`, not from caller-supplied capability overrides.

6. **Run the deterministic fixture lifecycle**

   - Use the repository's installed smoke-fixture command added by R8.2; it must execute in an independent clone with no remotes.

   - Pass condition: stdout is one JSON result, assessment writes nothing, the primary change stays inside its work boundary, coordinator checks pass, and `agf route inspect --task <id>` shows only redacted public state.

7. **Test interruption and resume**

   - Stop the fixture after an accepted assessment, then run `agf route resume --task <id>`.

   - Pass condition: assessment is not launched again, the next unaccepted stage runs once, revision increases, and changing source HEAD, `ag.json`, brief digest, or work boundary makes resume return `invalid` before launch.

8. **Test failure boundaries**

   - Run fixture cases for malformed assessment, attempted read-only write, boundary escape, unavailable executable with finite fallback, `task-failed`, cancelled, uncertain ownership, exhausted budget, injected secret fields, and stale concurrent revision.

   - Pass condition: none advances an unaccepted stage; only settled `unavailable` can fallback; persisted and inspected state contains no injected secret.

9. **Optional paid live-provider test**

   - Run only after R8.4 is complete, credentials are intentionally available, the exact provider recipe is reviewed, and the operator accepts possible usage cost.

   - Invoke `routing-live-provider.js --run --facts <facts.json>` from the installed skill. Confirm the warning appears before launch, the disposable clone has no remote, the configured low-cost tier is used, and actual model/effort remain `unknown` unless the provider exposes them.

10. **Cleanup and result record**

   - Record the installed skill version, Node/Git versions, host, commands, exit codes, JSON results, and the disposable repository path.

   - Remove the disposable repository only after retaining the result record. Do not use the user's real project for destructive or failure-path tests.

### Execution order and change boundaries

Apply the stacks in this order:

```text
R1 acceptance
 → R2 read-only proof
 → R3 persistence safety
 → R4 resume identity
 → R5 budgets and failure handling
 → R6 CLI/profile integration
 → R7 transport attribution
 → R8 end-to-end verification
```

The implementation may refactor shared validators when required, but each stack must remain independently testable. Do not implement native or host capabilities by simulating evidence that the host does not expose. Park unsupported capabilities at an explicit interactive or unavailable boundary.

### End-to-end control flow

The intended execution sequence is:

```text
Owner request
    │
    ▼
Main session constructs Cheap admission facts
    │
    ▼
admit_cheap()
    │
    ├── L0/L1
    │      │
    │      ▼
    │   Cheap primary executor
    │      │
    │      ▼
    │   deterministic verification → complete
    │
    └── ESCALATE + floor_class
           │
           ▼
       Basic read-only assessment
           │
           ▼
       validate routing_assessment
           │
           ▼
       classify_escalated_task()
           │
           ▼
       max(Cheap floor_class, Basic classification)
           │
           ├── L2/L3 → Basic primary → verify → complete
           │
           ├── L4 → Basic primary → optional Better review → complete
           │
           └── L5 → Basic primary → Better review
                                      │
                                      ├── no material disagreement → complete
                                      └── Debate hard gate passes
                                             │
                                             ▼
                                      Better A + Better B
                                             │
                                             ▼
                                      Basic synthesis → complete
```

At every worker boundary:

```text
plan stage
    → select permitted executor
    → freeze task and transport controls
    → launch exactly one selected transport
    → collect raw transport attempt
    → validate structured worker output
    → inspect scope, changes, checks, and transport evidence
    → construct coordinator-owned execution record
    → accept or stop
    → persist accepted state
    → plan the next stage
```

The worker never writes `acceptance.accepted: true` as authoritative evidence. The worker produces output; the coordinator performs acceptance and constructs the final execution record.

### Coordinator decision logic

The coordinator remains a pure next-action planner. Its effective logic is:

```text
require stable task_id
validate Cheap admission facts

if Cheap admission is L0 or L1:
    route primary to cheap
    require accepted primary record
    return complete

otherwise:
    preserve Cheap floor_class
    require accepted Basic assessment record
    require assessment changed_paths to be empty
    validate outputs.routing_assessment
    classify assessment as L2–L5
    effective_class = max(Cheap floor_class, Basic class)
    compute Basic primary route
    require accepted primary record

    if L4 or L5 review gate passes:
        require accepted Better review

    if effective_class is not L5:
        return complete

    require review_facts from the accepted review
    recompute Debate gate using assessment facts plus review facts

    if reviewer_material_disagreement is false:
        return complete

    if Debate hard gate does not pass:
        return complete with unresolved decision recorded

    require accepted Better perspective A
    require accepted Better perspective B
    require accepted Basic synthesis
    return complete
```

An explicit class may raise the effective class but cannot lower a class inferred from verified facts. Basic classification cannot return below L2 after Cheap has escalated.

### Lifecycle state machine

`routing-lifecycle.js` owns repeated coordinator calls but does not own transport-specific behavior.

Its loop is:

```text
current_facts = immutable copy of input
steps = []
action_count = 0

loop:
    plan = plan_next_action(current_facts)

    if plan is complete, stopped, unsatisfied, awaiting facts,
       awaiting executor choice, or otherwise non-selected:
        return plan + accumulated state

    if action_count reached the stage ceiling:
        return action-limit

    find the adapter matching selection.kind
    if no exact adapter exists:
        return awaiting-executor

    invoke adapter with frozen stage, tier, task, routing, selection, and facts
    if adapter throws:
        return execution-failed without adding a record

    validate the returned coordinator-owned execution record
    if invalid or unaccepted:
        stop without advancing

    store the accepted record under records[stage]
    copy accepted review outputs.review_facts into lifecycle review_facts
    append one observable step
    continue
```

The maximum normal path is six actions:

```text
assessment → primary → review → debate-a → debate-b → synthesis
```

Executor fallback is not decided by array order. Only a settled `unavailable` attempt may be submitted to the existing finite fallback selector. `task-failed`, `cancelled`, and `uncertain` states stop the lifecycle until explicitly reconciled.

### Phase 1 — Complete the routing lifecycle

Status: implementation is present; final verification is pending.

Deliverables:

- `routing-lifecycle.js`;
- immutable accumulated lifecycle facts;
- explicit external, internal, and host adapter boundaries;
- finite action ceiling;
- accepted-record-only progression;
- visible `awaiting-executor`, `execution-failed`, `unsatisfied`, and `action-limit` states.

Acceptance:

- L2 follows `assessment → primary → complete`;
- missing adapters do not trigger transport substitution;
- adapter exceptions do not create execution records;
- invalid and unaccepted records cannot advance;
- input facts are not mutated;
- lifecycle, coordinator, Usage Policy, and delegation-route tests pass.

### Phase 2 — Versioned routing facts contracts

Add a routing contract module that validates three different evidence envelopes.

Cheap admission envelope:

```json
{
  "schema_version": 1,
  "task_id": "stable-task-id",
  "source_identity": {
    "source_kind": "git",
    "value": "40-character-commit"
  },
  "facts": {
    "mechanical": false,
    "simple": false,
    "requirement_clear": false,
    "scope_known": false,
    "reversible": false,
    "deterministic_verification": false,
    "risk_flags": [],
    "missing_information": []
  },
  "evidence": []
}
```

Basic assessment envelope:

```json
{
  "schema_version": 1,
  "task_id": "stable-task-id:assessment",
  "source_identity": {
    "source_kind": "git",
    "value": "40-character-commit"
  },
  "facts": {
    "material_uncertainty": true,
    "substantial_mechanical_execution": false,
    "high_consequence": false,
    "difficult_rollback": false,
    "material_risk": false,
    "deterministic_verification_sufficient": true,
    "risk_flags": [],
    "missing_information": []
  },
  "evidence": [
    {
      "fact": "material_uncertainty",
      "source": "path or command",
      "observation": "bounded factual observation"
    }
  ]
}
```

Better review envelope:

```json
{
  "schema_version": 1,
  "task_id": "stable-task-id:review",
  "source_identity": {
    "source_kind": "git",
    "value": "40-character-commit"
  },
  "facts": {
    "material_risk": true,
    "deterministic_verification_sufficient": false,
    "reviewer_material_disagreement": true,
    "D": 2,
    "T": 2,
    "I": 2,
    "E": 1,
    "R": 1,
    "viable_alternatives": true,
    "meaningful_tradeoffs": true,
    "substantial_consequence": true,
    "cheap_resolution_exhausted": true
  },
  "evidence": []
}
```

Validation logic:

1. require `schema_version: 1`;
2. require the expected stage-specific `task_id`;
3. require exact source identity;
4. reject unknown fields;
5. reject non-boolean flags and out-of-range Debate scores;
6. reject empty risk, missing-information, or evidence strings;
7. reject a positive fact when required supporting evidence is absent;
8. reject review facts before an accepted review record exists;
9. pass only the normalized inner `facts` object to Usage Policy;
10. ignore model confidence and prose level recommendations.

Brief builders will instruct the worker to return only the matching JSON envelope. Markdown fences, explanatory prefixes, self-selected levels, and additional fields will fail parsing rather than being guessed.

Acceptance:

- every envelope normalizes to one canonical form;
- malformed or mismatched task/source identities fail closed;
- Basic cannot lower the Cheap risk floor;
- review output cannot activate Debate before accepted review;
- contract tests cover valid and invalid L0–L5 inputs.

### Phase 3 — Frozen stage briefs

Create one brief builder for each stage:

- `assessment`: inspect only, return Basic assessment envelope;
- `primary`: implement only within `work_boundary`, then run named verification;
- `review`: inspect accepted primary evidence and return Better review envelope;
- `debate-a` and `debate-b`: independently evaluate the frozen disputed decision;
- `synthesis`: reconcile only the two accepted perspectives and existing evidence.

Every frozen brief contains:

```text
stage and stable task ID
repository/source identity
goal
exact readable inputs
write authority
allowed output
forbidden changes
requested tier/model/effort
verification commands
acceptance checks
output schema
no-delegation rule
```

The brief digest becomes part of the attempt evidence. Resume must reject a record produced for a different brief digest even when the task ID is unchanged.

### Phase 4 — External worker adapter

The external adapter consumes only a selected `external-runner` action and a frozen stage brief.

Logic:

```text
verify checked provider recipe
verify selected model and effort
construct literal argument array
create independent no-remote clone
capture source identity before launch
launch with shell: false and closed stdin
capture bounded stdout/stderr and declared result
contain nested worker processes
capture process and clone-diff evidence
parse stage JSON
validate stage contract
compare actual changes with allowed paths
run coordinator-owned verification
construct final execution record
```

Provider-specific argument generation must use tested recipes. The adapter must not guess that Codex, Claude, or another CLI accepts the same flags.

The adapter separates two objects:

1. `transport_attempt`: raw runner result that may be completed but is not accepted;
2. `execution_record`: coordinator-owned record created only after output, scope, checks, identity, and transport evidence pass.

Exit code zero, valid JSON, or a worker statement that tests passed cannot independently set acceptance.

External failure mapping:

| Observed result | Lifecycle state |
| --- | --- |
| executable or authentication unavailable before useful work | `unavailable` |
| non-zero exit with settled process and no accepted result | `task-failed` |
| owner cancellation with verified process cessation | `cancelled` |
| lost process ownership or unverified remote continuation | `uncertain` |
| malformed output or undeclared changes | `task-failed` |
| nested worker detected | `task-failed`, evidence quarantined |
| valid output plus coordinator checks | `completed` and accepted |

Acceptance:

- the lifecycle invokes the real `external-runner-v1`;
- commands remain literal and shell-free;
- result and execution-record validation are separate;
- undeclared writes and nested workers cannot advance;
- only a settled unavailable attempt may request fallback.

### Phase 5 — Enforced read-only assessment

Assessment tasks set:

```json
{
  "require_read_only": true,
  "write_authority": {
    "source": "none",
    "result": "structured-output-only"
  }
}
```

Selection logic rejects any candidate that cannot prove the requested read-only control.

For Codex-like external workers, the tested provider recipe must use its actual read-only sandbox and return structured output through an allowed output channel that does not require source writes. For another provider, its profile must declare and prove the equivalent control. A provider without such a control is unavailable for assessment rather than silently downgraded.

Defense in depth after execution:

```text
requested read-only control is present in dispatch
AND transport evidence proves it was enabled
AND changed source paths are empty
AND source identity remains unchanged
```

The record must distinguish:

- provider-enforced source read-only;
- post-execution zero-change verification;
- unproven OS confinement;
- unproven credential isolation;
- unproven network isolation.

### Phase 6 — Native and host adapters

Native adapter requirements:

- invoke only the real host-native worker tool;
- retain its real thread/task handle;
- record actual model and effort when exposed;
- record fresh-context and read-only controls when exposed;
- retain a real stop mechanism;
- mark a lost handle as `uncertain`;
- never fabricate a CLI command.

Host-direct adapter requirements:

- identify the actual host and session;
- expose the bounded work to the interactive host;
- return `awaiting-host` when execution or acceptance requires interaction;
- never include external process fields;
- never claim independent or read-only execution without proof.

Resume accepts a host/native record only when its task ID, source identity, brief digest, handle/session, and requested controls still match persisted state.

### Phase 7 — Coordinator acceptance

Acceptance is a separate deterministic function:

```text
accept(stage, frozen_task, transport_attempt, parsed_output):
    require settled transport
    require matching task/source/brief identity
    require valid stage output schema
    require allowed changed paths only
    require named verification evidence
    require requested model/effort when exact
    require requested read-only/fresh-context controls
    require no unresolved nested worker

    if every requirement passes:
        create completed accepted execution record
    else:
        create settled non-accepted attempt
        return exact failed requirement
```

Acceptance does not reinterpret the owner requirement or add work discovered by a worker. New findings are either mapped to an existing requirement or parked for owner review.

### Phase 8 — `agf route` integration

Add these owner-facing operations:

```text
agf route plan   --facts-stdin
agf route run    --facts-stdin
agf route resume --task <task-id>
agf route inspect --task <task-id>
```

`plan` returns one transport-neutral action without launching it.

`run` creates or resumes state, executes until a terminal or interactive boundary, and prints one structured JSON result.

`resume` loads persisted accepted evidence and continues without repeating a settled stage.

`inspect` is read-only and reports current routing class, stage, attempts, accepted records, pressure, and unresolved requirements.

Persistence location:

```text
<configured-workspace>/routing/<task-id>/
    state.json
```

`state.json` is the sole authoritative durable object. Its revisioned, digest-checked state contains the allowlisted frozen inputs, attempts, accepted records, and usage needed for inspect and resume; temporary sibling files are used only during atomic replacement and are not durable records.

Persistence logic:

1. validate task ID before path construction;
2. reject symlinks and paths outside the configured workspace;
3. write a temporary file in the same directory;
4. fsync and atomically rename;
5. store state revision and prior-state digest;
6. reject stale concurrent updates;
7. never persist credentials or inherited environment values;
8. resume only when task, source, config, and brief identities match.

CLI terminal states and exit behavior:

| State | Meaning |
| --- | --- |
| `complete` | all required stages accepted |
| `awaiting-routing-facts` | required structured evidence is missing |
| `selection-required` | host must choose among eligible executor kinds |
| `awaiting-executor` | selected transport adapter is unavailable |
| `awaiting-host` | native or host interaction is required |
| `unavailable` | settled capability absence permits explicit fallback |
| `task-failed` | settled execution failed and cannot advance |
| `uncertain` | ownership or cessation is unresolved |
| `stopped` | Usage Policy budget stop |
| `invalid` | schema, identity, configuration, or state is invalid |

Standard output contains one JSON result. Human diagnostics go to standard error. Existing `agf` commands and configuration formats remain compatible.

### Phase 9 — End-to-end verification

Deterministic fixture journeys use an actual child process through `external-runner-v1`, an independent clone, structured result parsing, coordinator acceptance, lifecycle progression, and persisted resume.

Required journeys:

1. L1 Cheap Direct;
2. L2 Basic assessment and Basic primary;
3. L3 Basic assessment and substantial bounded execution;
4. L4 Basic primary with and without Better review;
5. L5 review ending without disagreement;
6. L5 full review, two perspectives, and Basic synthesis;
7. malformed assessment output;
8. source write during read-only assessment;
9. external unavailable fallback;
10. uncertain/cancelled process that must not relaunch;
11. interrupted lifecycle resumed without repeating accepted stages;
12. stale source or brief identity rejected on resume.

An additional live-provider gate is explicit and opt-in. It requires a nonempty checked recipe set with at least one `live-provider` recipe keyed to a currently configured profile, validates the current configuration, and displays authentication and possible-cost implications before invoking the runner. The external runner uses a clone without remotes. Provider-specific recipe correctness, enforcement of the configured low-cost tier, and observed model/effort attribution remain unverified; unknown attribution is not evidence of a match. The gate is never part of the default test suite, and no live provider was invoked for this work.

### Phase 10 — Delivery

After every phase:

1. run its focused failing tests before implementation;
2. apply only the approved diff;
3. run focused tests and unchanged integration tests;
4. run `git diff --check`;
5. compare the working-tree diff with the approved proposal;
6. preserve unrelated `.gitignore`, `.agentflow/`, and `ag.json` changes.

After all phases pass, update documentation to describe actual behavior rather than planned behavior. Commit only after presenting the exact staged files, diff summary, and complete commit message for separate approval. Reinstallation and push remain separate operations.

Existing review callers remain compatible. Plus-aware callers may supply `material_risk` and `deterministic_verification_sufficient`; callers that omit both retain upstream cross-check behavior.

The exact `3ways` and `threeways` triggers remain available. When `plus_profile: true` is supplied, the deterministic L5 hard gate is required, perspective starts are capped at two, and Debate is never retried.

## Default budget

- external workers: 2;
- delegation depth: 1;
- parallel workers: 0;
- independent reviewers: 2;
- Debate perspectives: 2;
- Debate syntheses: 1;
- Debate retries: 0;
- retries per approach: 1;
- discovery iterations: 2;
- expensive external analysis calls: 4;
- pipeline backward transitions: 1;
- routine automatic learning: disabled.

Reaching a limit is a stop condition. Pressure progresses through `NORMAL → CAUTION → CONSERVE → STOP` using workflow-local observations. `CONSERVE` removes optional delegation, ordinary review, Debate, and scope expansion. `STOP` returns verified findings and unresolved items.

## Context policy

- A Cheap executor receives the bounded request, relevant files, constraints, and deterministic verification command.
- A Basic worker receives the request, known evidence, work boundary, constraints, and verification requirements.
- A reviewer receives the requirement, decision, relevant diff, deterministic evidence, and unresolved risk.
- Debate receives only the disputed decision, viable options, constraints, evidence, and reviewer disagreement.

Initial discovery is limited to five plausible candidate files, dependency depth one, and two iterations. Evidence may justify expansion; the file count is not an absolute correctness boundary.

## Review and Debate

Independent review is conditional on unresolved material risk that deterministic verification cannot settle. Medium reasoning alone does not justify review.

The Debate hard gate requires all of the following:

1. two materially different viable solutions;
2. meaningful trade-offs;
3. substantial consequences for a poor choice;
4. exhaustion of clarification, evidence, inspection, deterministic verification, and cheap experiments;
5. material disagreement from the independent reviewer.

The Deliberation Decision Score records Decision Ambiguity, Trade-off Strength, Impact, Evidence Gap, and Irreversibility from zero through two. A score of seven or more indicates potential high risk but cannot launch Debate alone.

Maximum Debate form: `Perspective A + Perspective B → one synthesis → STOP`.

## Telemetry and savings measurement

Optional version-1 telemetry records observed execution class and path, model/effort when known, model calls, workers, reviews, debates, retries, tool calls, tokens when available, elapsed time, outcome, pressure, and stop reason. Missing measurements remain `null`. Telemetry never adds a model call.

Savings must be measured against the same representative task set:

`usage reduction = 1 − (Plus-profile usage / upstream usage)`

Report completion rate and correctness beside usage. Do not count a cheaper incomplete task as a successful saving.

Expected, unmeasured engineering ranges for a workload dominated by bounded tasks are:

- small-task workload: 45–65% fewer model invocations;
- highly mechanical workload: potentially 60–75%;
- reasoning-heavy workload: 20–40%;
- high-risk workload: 10–30%.

These ranges overlap across saving mechanisms and are not guarantees. Exact reduction requires an A/B evaluation.

### Modeled bounded-task scenario

For planning purposes, assume a representative mix of 60% L0/L1, 25% L2, 10% L3, and 5% L4 work. If the upstream-equivalent path averages four model calls for L0/L1 and three for the other classes, it averages 3.60 calls per task. The Frugal routes average 1.15 calls per task when L0/L1 and L2 are direct, L3 uses one executor, and L4 uses one review:

`1 − (1.15 / 3.60) = 68.1% modeled invocation reduction`

This quantifies the design under explicit assumptions; it is not observed production savings. A different upstream route mix or review rate changes the result.

## Route examples

- **Cheap Direct:** update an explicit reversible configuration value, run its validator, and finish without review.
- **L2 Basic Direct:** diagnose a non-obvious local defect, implement the fix, and run focused tests.
- **L3 Basic Direct:** resolve a bounded design question and complete the substantial mechanical execution in the same worker.
- **L4 Better review:** independently inspect a difficult-to-reverse interface change whose remaining risk is not settled by tests.
- **L5 Debate:** after a reviewer identifies material disagreement between consequential viable designs, collect Better perspectives and synthesize once.

## Compatibility and limitations

- Existing state and configuration formats remain valid.
- Existing command syntax is preserved.
- No `ag.json` migration or telemetry database is introduced.
- Upstream behavior is retained when optional Plus facts are absent.
- Agentflow cannot infer actual ChatGPT Plus quota without a supported interface.
- The policy can reduce optional reasoning, but deterministic verification quality still depends on the project and available environment.
