# Task: Fork Agentflow into a ChatGPT Plus-Optimized Agentflow

Repository:

https://github.com/agfnow/agentflow

Primary scope:

`skills/agentflow/`

Create a cost-controlled fork or profile of Agentflow specifically designed for sustainable daily use under ChatGPT Plus usage constraints.

The primary objective is:

> Maximize the number of useful software-engineering tasks completed per available usage budget while preserving stronger reasoning only where it materially improves correctness or decision quality.

Do NOT optimize for maximum autonomous reasoning on every task.

Optimize for:

- fewer LLM invocations;
- cheaper reasoning where sufficient;
- minimal delegation;
- minimal context duplication;
- deterministic verification;
- bounded retries;
- rare review;
- exceptional debate.

Target, as an engineering goal rather than an assumed measured result:

`60–75% lower agentic usage than upstream Agentflow`

while maintaining comparable success rates on ordinary software-engineering tasks.

---

# 1. Work in Two Phases

Do not immediately perform a large rewrite.

## Phase A — Audit and Plan

Inspect the existing Agentflow implementation and produce:

1. current architecture summary;
2. relevant file/script inventory;
3. current workflow graph;
4. current model/delegation behavior;
5. current review/debate/retry behavior;
6. sources of unnecessary LLM usage;
7. proposed target architecture;
8. exact files expected to change;
9. KEEP / SIMPLIFY / MERGE / CONDITIONAL / REMOVE classification;
10. compatibility risks.

Then perform exactly ONE critical review of your proposed plan.

The review must specifically look for:

- unnecessary new abstractions;
- places where cost was moved rather than eliminated;
- unnecessary model calls;
- unnecessary controller → worker transitions;
- deterministic work still being performed by an LLM;
- incorrect assumptions about ChatGPT Plus quota visibility;
- retry or debate loops that remain unbounded;
- scope expansion not justified by evidence.

After this single review, revise the implementation plan once.

Do not create iterative planning/review loops.

Then proceed with implementation.

---

# 2. Core Policy: Cheapest-Capable Direct First

The default policy must be:

> Route each task directly to the cheapest reasoning level capable of completing it safely.

Do NOT instantiate a Medium controller for every request.

Do NOT use:

`Medium → decide task is easy → Light worker`

for tasks that could have gone directly to Light.

Model selection should happen before substantial planning whenever possible.

---

# 3. Execution Classes

Introduce a simple execution classification.

## L0 — Mechanical

Examples:

- apply an explicitly specified change;
- rename a symbol;
- change a constant;
- update configuration;
- run specified commands;
- formatting;
- apply an approved diff;
- mechanical repetitive edits.

Characteristics:

- essentially no design judgment;
- bounded scope;
- low consequence;
- deterministic verification available.

Route:

`Light Direct`

Use GPT-5.6 Sol with low/light reasoning effort.

---

## L1 — Simple

Examples:

- straightforward local bug fix;
- small implementation with an obvious approach;
- limited file scope;
- easy rollback.

Characteristics:

- minor judgment;
- no meaningful architecture decision;
- low risk;
- deterministic verification available.

Preferred route:

`Light Direct`

Escalate to Medium only if material uncertainty appears during execution.

---

## L2 — Reasoning

Examples:

- debugging;
- root-cause analysis;
- planning;
- architecture reasoning;
- meaningful trade-offs;
- non-obvious implementation decisions.

Route:

`GPT-5.6 Sol / Medium`

Prefer:

`Medium Direct`

Do not automatically create a worker afterward.

---

## L3 — Reasoning + Substantial Mechanical Execution

Use when:

1. Medium reasoning is required to determine the correct solution;
2. a bounded implementation plan is now approved;
3. significant mechanical work remains;
4. a Light worker can execute without redesigning the solution.

Route:

`Medium judgment → one Light executor`

The Light executor MUST NOT:

- redesign;
- re-plan;
- expand scope;
- reinterpret requirements;
- introduce architectural changes.

Its job is execution only.

Do not create a Light worker for trivial remaining work if continuing with Medium is cheaper.

---

## L4 — High Risk

Examples:

- security boundary;
- persistent-data migration;
- partition layout;
- provisioning;
- public API/ABI;
- difficult rollback;
- irreversible or field-impacting changes.

Route:

`Medium reasoning`

Then use at most:

`one independent review`

only when deterministic verification is insufficient.

High reasoning may be used for validation only when consequence justifies it.

---

## L5 — Exceptional Deliberation

Use only for high-consequence decisions where materially different viable solutions remain and independent review identifies a substantive disagreement.

This is the only class eligible for Debate.

---

# 4. Cheap Task Router

Implement the cheapest practical task classifier.

Prefer, in order:

1. deterministic rules;
2. structured task metadata already produced by the workflow;
3. existing routing information;
4. minimal model classification only when truly ambiguous.

Do NOT create a dedicated Medium or High reasoning classifier for every task.

Routing must not cost more than the optimization it provides.

---

# 5. Normal Workflow

The common path should be:

`Understand → Execute → Deterministic Verify → Done`

Do not force every task through:

- requirements agent;
- research agent;
- planner;
- executor;
- reviewer;
- cross-check;
- learning agent.

Workflow stages should be capabilities, not mandatory pipeline nodes.

---

# 6. Reduce the Existing Workflow to Four Logical Capabilities

## Understand

Combine:

- requirements;
- targeted codewalk.

Initial repository inspection budget:

- max 5 plausible candidate files;
- dependency depth 1;
- max 2 discovery iterations.

Expand only when concrete evidence indicates the relevant behavior exists outside the current scope.

Do not inspect unrelated subsystems "just in case."

---

## Resolve Uncertainty

Invoke only when a named uncertainty exists.

Priority:

`existing evidence > documentation > inspection > deterministic experiment > additional reasoning`

Do not perform generic exploration.

Do not perform a spike unless evidence or inspection cannot cheaply resolve the uncertainty.

---

## Execute

Use the execution classes above.

Direct execution is preferred.

Delegation is not a mechanism for keeping the controller context clean.

Delegate only when it reduces expected total cost or isolates substantial bounded mechanical work.

---

## Verify

Prefer deterministic verification:

- compiler;
- tests;
- static analysis;
- lint;
- schema validators;
- assertions;
- benchmarks where appropriate;
- `git diff --check`;
- targeted command output.

Do not spend another model invocation merely to increase confidence when a deterministic oracle exists.

---

# 7. Hard Default Budget

For the Plus-optimized profile, use these default limits:

- external workers: max 1;
- delegation depth: max 1;
- parallel workers: disabled;
- independent reviewers: max 1;
- debate perspectives: max 2;
- debate synthesis rounds: max 1;
- debate retries: 0;
- automatic retries per approach: max 1;
- search/discovery iterations: max 2;
- expensive external analysis/tool calls: max 2;
- pipeline backward transition: max 1;
- automatic learning: disabled.

Reaching a limit is a STOP condition.

Do NOT automatically:

- add another agent;
- increase reasoning effort;
- retry repeatedly;
- broaden repository scope;
- start a debate;
- perform more searches.

Report the unresolved issue instead.

---

# 8. Deliberation Gate

Debate must be exceptional.

Evaluate:

- Decision Ambiguity — D
- Trade-off Strength — T
- Impact — I
- Evidence Gap — E
- Irreversibility — R

Each ranges from 0–2.

Compute:

`DDS = D + T + I + E + R`

Interpretation:

- 0–3 → normal direct path
- 4–6 → normal reasoning path; deterministic verification preferred
- 7–10 → potentially high-risk

DDS alone MUST NOT launch Debate.

---

# 9. Review Gate

Independent review is allowed only when there is meaningful risk that deterministic verification cannot resolve.

Typical triggers:

- architecture decision;
- security boundary;
- persistent-state behavior;
- migration;
- public API/ABI;
- difficult rollback;
- incomplete verification;
- significant unresolved assumption.

A Medium task MUST NOT receive a review merely because review may improve confidence.

Perform at most one review.

---

# 10. Debate Hard Gate

Debate may execute only when ALL are true:

1. two or more materially different solutions remain viable;
2. meaningful trade-offs remain;
3. selecting poorly has substantial consequence;
4. tests, evidence, documentation, inspection, or user clarification cannot cheaply resolve the issue;
5. the independent reviewer identifies a material disagreement.

Do NOT debate when:

- deterministic validation can answer the question;
- an experiment is cheaper;
- information is merely missing;
- the user has already selected the approach;
- implementation is mechanical;
- rollback is cheap;
- disagreement concerns style, naming, formatting, documentation, or minor optimization.

Use:

`evidence > experiment > deterministic verification > review > debate`

---

# 11. Material Disagreement Definition

A disagreement is material only when resolving it differently would substantially change:

- architecture;
- security model;
- migration strategy;
- persistent-data design;
- compatibility behavior;
- public interface;
- provisioning model;
- another high-consequence decision.

Minor implementation preferences do not qualify.

---

# 12. Bounded Debate

Remove:

- "until consensus";
- recursive rebuttal;
- unlimited 3-way discussion;
- repeated critic loops.

Maximum form:

`Perspective A + Perspective B → one synthesis → STOP`

Optional critique may be incorporated into the single synthesis step.

Maximum:

- 2 perspectives;
- 1 synthesis;
- 0 debate retries.

Consensus is not required.

The synthesis should report:

- agreements;
- disagreements;
- evidence;
- assumptions;
- trade-offs;
- unresolved questions;
- recommended next test/evidence if applicable.

---

# 13. Preserve Deterministic Node.js Infrastructure

Do not remove useful Node.js scripts merely to reduce file count.

Prefer deterministic code for:

- state management;
- devlog persistence;
- parsing;
- validation;
- git inspection;
- stage transitions;
- budget enforcement;
- context extraction;
- telemetry;
- routing rules.

Moving work from LLM reasoning into deterministic Node.js code is encouraged when correct.

---

# 14. Context Budget

Avoid context amplification across agents.

Use minimal role-specific context.

## Light Direct

Provide only:

- request;
- directly relevant files/context;
- constraints;
- verification command.

## Light Executor

Provide:

- approved plan;
- exact target files;
- exact requested change;
- constraints;
- required verification.

Do not send full planning history.

## Reviewer

Provide:

- relevant requirement;
- important decision;
- relevant diff;
- deterministic test output;
- unresolved risk.

Do not provide unrelated exploration logs.

## Debate

Provide only:

- disputed decision;
- viable options;
- constraints;
- known evidence;
- material reviewer disagreement.

Never copy the complete conversation/devlog into each debate participant.

---

# 15. Retry Policy

Maximum automatic retry of an approach:

`1`

If materially the same failure occurs again:

`STOP`

Do not silently:

- retry with more context;
- switch to High reasoning;
- start another worker;
- broaden scope;
- start Debate.

Escalation requires a concrete reason.

---

# 16. Learning

Disable routine automatic learning.

Run learning only when:

- a significant assumption was disproven;
- the same failure pattern has recurred;
- a reusable workflow improvement was discovered;
- the user explicitly requests knowledge capture.

Successful normal tasks should not invoke a learning model.

---

# 17. Plus Budget Pressure

Do not assume Agentflow can read the user's actual remaining ChatGPT Plus quota unless an explicit supported interface provides that information.

Instead track workflow-local usage indicators such as:

- LLM invocation count;
- model/reasoning class;
- workers spawned;
- reviewer count;
- debate count;
- retries;
- tool/search count;
- context size or tokens when available.

Support internal pressure states such as:

`NORMAL → CAUTION → CONSERVE → STOP`

Example behavior:

## NORMAL

Normal routing rules.

## CAUTION

Avoid optional delegation and exploration.

## CONSERVE

- no new worker unless required for already-approved mechanical execution;
- no review except high-risk;
- no debate;
- no scope expansion;
- prefer Light where safe.

## STOP

Return established results and unresolved items rather than automatically spending more usage.

---

# 18. Telemetry

Add lightweight telemetry so upstream and Plus behavior can be compared.

Record where available:

- task execution class;
- execution path;
- selected model/reasoning effort;
- LLM calls;
- workers;
- reviews;
- debates;
- retries;
- tool calls;
- input/output tokens;
- elapsed time;
- success/failure;
- budget stop reason.

Do not add an LLM call for telemetry.

---

# 19. Required Tests

Test at least:

### Mechanical Task

Expected:

`Light Direct`

No Medium planning.

No worker.

No review.

No debate.

---

### Simple Local Task

Expected:

Light Direct where safe.

Escalation only if meaningful uncertainty appears.

---

### Reasoning Task

Expected:

`Medium Direct`

No worker unless substantial mechanical execution remains.

---

### Planned Large Mechanical Change

Expected:

`Medium plan → one Light executor`

No second worker.

No executor redesign.

---

### High-Risk Without Material Disagreement

Expected:

`Medium → at most one review → Done`

No debate.

---

### High-Risk With Material Disagreement

Expected:

bounded Debate is allowed.

---

### Deterministic Oracle Available

Expected:

no Debate.

Prefer deterministic result.

---

### Cheap Experiment Available

Expected:

experiment instead of Debate.

---

### Retry Failure

Second equivalent failure must stop.

---

### Budget Exhaustion

Workflow must stop rather than automatically escalating.

---

# 20. Preserve Compatibility Where Cheap

Preserve upstream interfaces and state formats where doing so has low complexity.

Do not preserve complicated legacy behavior merely for theoretical compatibility.

Prefer:

- existing command compatibility;
- existing devlog compatibility;
- existing deterministic helpers;

while changing expensive defaults to conditional or opt-in behavior.

---

# 21. Required Deliverables

After the single planning review and implementation, provide:

1. final architecture;
2. changed-file list;
3. KEEP / SIMPLIFY / MERGE / CONDITIONAL / REMOVE summary;
4. behavioral differences from upstream;
5. tests and results;
6. telemetry mechanism;
7. known limitations;
8. examples for:
   - Light Direct;
   - Medium Direct;
   - Medium → Light;
   - Review;
   - Debate;
9. estimated sources of usage reduction.

Do not claim an exact cost reduction unless it was measured.

---

# Success Criteria

A healthy Plus-optimized workload should predominantly use:

1. Light Direct for low-level tasks;
2. Medium Direct for genuine reasoning tasks;
3. Medium → Light only when substantial bounded execution justifies another model call;
4. independent review only for meaningful high-risk decisions;
5. Debate only for rare material disagreement involving high-consequence decisions.

The architecture should make the cheap path the shortest path.

The key design rule is:

> Cheapest-Capable Direct First.

And the escalation rule is:

> Spend additional model calls only when the expected information or correctness gain clearly justifies the additional usage.
