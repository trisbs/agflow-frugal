# A-006 Release Candidate Review Brief

## Outcome

Prepare a public-safe Agentflow Frugal 8.4.0 candidate from the current public `main`, preserving its existing public files and excluding private workflow records. Do not push, create a tag, publish a release, or update the installed skill.

## Exact source

- Candidate repository: `/tmp/agf-release-8.4.0`
- Candidate branch: `release/8.4.0-local-candidate`
- Candidate commit: `59f38a45a90f8735fa80af197308d651781457f8`
- Public base: `c906695dbb5bd00c06963d4cd5c3c31d36ebe53c`
- Candidate diff: 149 paths, 5,167 insertions and 684 deletions.

## Scope and exclusions

- Changed product paths are plugin metadata, English and Traditional Chinese READMEs, `docs/CHANGELOG.md`, and the skill tree renamed from `skills/agentflow` to `skills/agflow-frugal`.
- Existing public `Task.md` and `LICENSE` remain from the public base.
- `.agentflow/`, root `AGENTS.md`, root `ag.json`, and local `.setup-checked` are excluded.
- Candidate is a single local commit directly on public base; it has not been pushed or tagged.

## Verification evidence

- Full candidate script suite after the README correction: 1,496 total, 1,467 passed, 29 skipped, 0 failed.
- `git diff --cached --check`: passed before commit.
- Version metadata agrees on 8.4.0 across skill metadata/heading, changelog, and plugin manifest.
- Candidate tree inspection confirms private paths and the setup marker are absent.
- Review-fix in `skills/agflow-frugal/scripts/prompt-compression.test.js` now asserts the shipped skill's trace format and checks development `Task.md` wording only when present. Its focused test passed.
- Review corrected the README's stale one-shot trace-command claim to say the commands are retired and direct users to `godev trace enable/disable`; focused prompt-compression test and full suite passed after that correction.

## Review checks

1. Verify the candidate matches the owner-approved release scope and does not include private project records or local settings.
2. Inspect the rename and public installation/version metadata; check relevant README and manifest paths.
3. Inspect the focused prompt-compression test adjustment and its passing suite evidence.
4. Attempt at least one plausible reduction or reuse; report Outcome, Minimality, and Conformance, with limitations.

The original request is in `.agentflow/devlog.md`, Ask A-006. The normal-user installation journey is documented in the candidate `README.md`.
