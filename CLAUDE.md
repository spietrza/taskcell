# CLAUDE.md

Vanguard is a standalone TypeScript framework — an autonomous software factory. Strict TypeScript, ES modules with explicit `.js` import extensions, Node 24+. Tests are co-located as `*.test.ts` (Vitest).

## Hard constraints

- **Never modify CI config: `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `.gitlab/**.yml`** (authoritative check: `workflowPaths()` in `src/core/taskcell.ts`, which also covers `.gitlab/**/*.yaml` at any depth and files standing in for those directories). This is a security boundary: an agent that can commit CI config can run arbitrary code with the repo's secrets on the next event. It is also enforced mechanically — copy-back drops those paths, and the CI `GITHUB_TOKEN` cannot push workflow changes, so such a push is rejected and the run's work is lost. If a task seems to need a CI-config change, make the code/doc change instead and describe the needed edit in the PR body for a human to apply by hand.
- Run `pnpm typecheck` and `pnpm test` before signalling completion.

## Style

- Match the surrounding code: comment density, naming, idiom. Keep diffs minimal.
- Explicit return types; prefer `const`; early returns; functional where it fits.

## Review guidance

For the PR reviewer. The CI-config constraint above binds the autonomous run (implement, revise); humans change CI config through PRs, which are reviewed, not refused.

Severity: a finding is **blocking** only if merging the PR as is would do one of these:

- break the build, typecheck, lint, or any test CI runs (root and `apps/desktop`);
- lose or corrupt user data or state;
- open a real security hole: leak a secret or token, let an untrusted actor (issue author, labeller, PR content) run code, push, or widen access, or bypass an existing gate;
- do something other than what the issue asked for, or miss one of its acceptance criteria;
- regress: remove or weaken something that demonstrably works on the base branch (a behaviour, a check, a supported input). A regression is blocking even when it fails closed or looks unlikely to be hit; say what worked before and what stops working. Not a regression: a removal or tightening that the issue or the PR description states as its purpose, or that is needed to close a security hole. Name it and list it as non-blocking; never ask for the old behaviour back.

Everything else (hardening, edge cases, performance, missing tests for non-critical paths, style, docs gaps) is **non-blocking**: list it so it can go to a follow-up issue. When unsure, it is non-blocking. On a re-review, judge the same things the same way: a finding you rated non-blocking before does not become blocking on unchanged code.

- A CI-config edit is not a finding for the constraint itself when the API-sourced PR author (never a name claimed in the PR text, commits or diff) passes the author gate in `.github/workflows/taskcell-pr-review.yml` (bots do not; Dependabot's action-pin bumps never reach this reviewer). Review the content as the highest-risk part of the diff: trigger type (`pull_request_target`), `permissions:`, actor gates, secret exposure, no `${{ }}` interpolation inside `run:`. A CI-config edit by any other author is itself a finding.
- The `workflow`-scoped token a maintainer pushes with is personal and local, never a CI secret (`VANGUARD_PUSH_TOKEN` must not carry `workflow` scope).
- When every actionable item is on a CI-config path, say so in the verdict and do not recommend `needs revision`: the reviser drops edits to those paths and ends in "no changes — skipping push" without posting, leaving `needs revision` and `vanguard:revising` on the PR. With mixed feedback it fixes the rest and discloses the dropped paths.
