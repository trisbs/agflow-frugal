# Targeted review brief — historical push claim validation

## Owner outcome and authority

- Original request: finish the tasks added today, including the workflow/upstream comparison and the historical push-claim closeout correction.
- Source authority: the owner supplied `Design Go: 9e6a4ea` for `.agentflow/artifacts/A-003-push-claim-history/design.md`.
- Review target: `d61c699438dbfb1cd787faba1803f5c3ef27aca1`, based on `9e6a4ea1d9beacb22152a8fe4ba64d6950876749`.

## Frozen plan

Planner result: `targeted`. Facts: two changed source/test paths, 56 changed lines, behavior change true, trust-boundary change false, broad change false, material risk true, deterministic verification alone not sufficient for this Plus review gate, consequential change true. The plan requires inspection of the exact diff and affected boundaries, focused tests, reconstruction from `.agentflow/devlog.md`, inspection of the normal journey in `skills/agflow-frugal/scripts/round-linter.test.js`, a minimality challenge, and Outcome/Minimality/Conformance verdicts.

## Required checks

- Confirm push-success claims are read from the current parsed Reply and current terminal output only.
- Confirm historical RUN/Ask wording does not become a current delivery claim.
- Confirm current Reply and terminal-output success claims still require `remote_exists === true` and `exit_code === 0`.
- Review the focused 16-case push suite and the exact implementation diff; do not rerun unrelated suites.
- Test the smaller alternative of filtering RUN/WIP headings from the full round. That still scans the Ask and can misclassify owner instructions, so it does not satisfy the outcome as directly as using the existing parsed Reply field.
- State the review independence limit: this repository's `prefer-independent` fallback allows a host review, but no separate native reviewer tool or paid provider route was available in this session.
