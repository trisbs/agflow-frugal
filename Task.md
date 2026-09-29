# Agentflow Frugal Profile

## Status

This repository implements a compatibility-first, ChatGPT Plus-oriented Agentflow profile. The policy is an engineering optimization, not a claim that Agentflow can read a user's remaining ChatGPT Plus quota.

The governing rule is:

> Route each task directly to the cheapest reasoning level capable of completing it safely.

The escalation rule is:

> Spend another model call only when its expected information or correctness gain clearly justifies the usage.

## Architecture

The ordinary workflow has four conditional capabilities:

1. **Understand** — combine requirements with a targeted codewalk.
2. **Resolve Uncertainty** — use only for a named unresolved question.
3. **Execute** — follow the selected execution class directly.
4. **Verify** — prefer deterministic evidence over another model invocation.

The common path is `Understand → Execute → Deterministic Verify → Done`.

Existing Agentflow notebook, ownership, Git, parsing, validation, settings, and closeout infrastructure remains intact.

## Execution classes

- **L0 Mechanical:** Light Direct for specified, bounded work with deterministic verification.
- **L1 Simple:** Light Direct for an obvious, reversible approach with deterministic verification.
- **L2 Reasoning:** Medium Direct for meaningful uncertainty, diagnosis, planning, or trade-offs.
- **L3 Reasoning plus mechanical execution:** Medium freezes the decisions; one Terra Medium executor may perform substantial bounded mechanical work.
- **L4 High Risk:** Medium Direct; at most one independent review when deterministic verification cannot resolve material risk.
- **L5 Exceptional Deliberation:** L4 plus materially different viable solutions and a substantive reviewer disagreement. This is the only Debate-eligible class.

Classification is domain-neutral. It uses judgment, uncertainty, consequence, reversibility, verification strength, and remaining mechanical execution. File count, diff size, language, framework, and subsystem are evidence rather than class rules. Ambiguous work uses Medium Direct.

## Deterministic policy

`skills/agflow-frugal/scripts/usage-policy.js` provides pure functions for classification, routing, review and Debate gates, budget pressure, and telemetry records. It makes no model call and writes no state.

Existing review callers remain compatible. Plus-aware callers may supply `material_risk` and `deterministic_verification_sufficient`; callers that omit both retain upstream cross-check behavior.

The exact `3ways` and `threeways` triggers remain available. When `plus_profile: true` is supplied, the deterministic L5 hard gate is required, perspective starts are capped at two, and Debate is never retried.

## Default budget

- external workers: 1;
- delegation depth: 1;
- parallel workers: 0;
- independent reviewers: 1;
- Debate perspectives: 2;
- Debate syntheses: 1;
- Debate retries: 0;
- retries per approach: 1;
- discovery iterations: 2;
- expensive external analysis calls: 2;
- pipeline backward transitions: 1;
- routine automatic learning: disabled.

Reaching a limit is a stop condition. Pressure progresses through `NORMAL → CAUTION → CONSERVE → STOP` using workflow-local observations. CONSERVE removes optional delegation, ordinary review, Debate, and scope expansion. STOP returns verified findings and unresolved items.

## Context policy

- Light Direct receives the request, relevant files, constraints, and verification command.
- A Terra Medium executor receives the approved plan, exact target files and edits, constraints, and verification.
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

- **Light Direct:** update an explicit configuration value, run its validator, and finish with no worker or review.
- **Medium Direct:** diagnose a non-obvious local defect, implement the fix in the same reasoning context, and run focused tests.
- **Medium → Terra:** resolve an architectural choice in Medium, freeze a repetitive multi-file edit, and give one Terra Medium executor only the plan and verification.
- **Review:** use one independent reviewer for a difficult-to-reverse interface change whose remaining risk is not settled by tests.
- **Debate:** after that reviewer identifies a material disagreement between two consequential viable designs, collect two perspectives and synthesize once.

## Compatibility and limitations

- Existing state and configuration formats remain valid.
- Existing command syntax is preserved.
- No `ag.json` migration or telemetry database is introduced.
- Upstream behavior is retained when optional Plus facts are absent.
- Agentflow cannot infer actual ChatGPT Plus quota without a supported interface.
- The policy can reduce optional reasoning, but deterministic verification quality still depends on the project and available environment.
