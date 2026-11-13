# Autonomous loop

`taskcell watch` polls a source for ready items and runs each one by itself (claim → run → PR → move to review): `--source linear` (trigger = state type + label) or `--source github` (open issues with labels). Each run implements, then **reviews and simplifies its own diff in a fresh, independent context** using the bundled `skills/` (code-review + simplify) injected into the sandbox. The defaults let you start GitHub with `taskcell watch --source github --github-repo owner/repo`, and Linear with `taskcell watch --loop-v1 --label vanguard`. To run it always-on on any Docker host, see [deploy.md](deploy.md).

## Two passes: spec, then build

The loop runs a deterministic spec pass before every agent pass (the `--loop-v1` flag turns on the defaults below):

1. **Spec pass (Planner)** — Polls the spec-trigger (label or state). Runs triage: rejects vague tickets to needs-info before spending any model budget. If the ticket passes, runs `techSpecStage` (read-only: no code is written), posts the result as a `<tech_spec>` comment, then advances the ticket to the agent-trigger. A freshly-specced ticket is implemented on the **next poll** — the human has a window to review the spec before the agent runs.
2. **Agent pass (Implementer → Reviewer → Simplifier)** — Polls the agent-trigger. Runs triage again in `agent` mode: rejects tickets that lack acceptance criteria or a spec comment before spending implement budget. If the ticket passes, runs the full stage pipeline and opens a PR or MR — draft only when a gate or configured visual proof failed, or no verify command ran.

Routing differs by source:

**GitHub (routes by LABELS):**

`--label` (e.g. `vanguard`) is an optional **ownership** label for GitHub: when supplied, an issue is only picked up if it carries it *in addition to* the routing label below. The short GitHub command does not require it because the repo plus `ready for spec` / `ready for agent` already define the loop lane.

| Routing label | What happens |
|---|---|
| `ready for spec` | Spec pass triggers. Triage runs first — vague tickets get a clarification comment + relabelled `needs info` (no model budget spent). Valid tickets: `techSpecStage` posts a `<tech_spec>` comment, issue relabelled `ready for agent`. If `--label` is supplied, the issue must also carry that ownership label. |
| `ready for agent` | Agent pass triggers (next poll after spec, or immediately for directly-labelled issues). Triage runs again — no spec or acceptance criteria → `needs info`. Valid tickets: full Implementer → Reviewer → Simplifier pipeline → PR (draft only when a gate or configured visual proof failed, or no verify command ran). If `--label` is supplied, the issue must also carry that ownership label. |
| `needs info` | Parked. Human updates the ticket and moves it back. |

> **Note on the issue template:** The [Taskcell Task template](../.github/ISSUE_TEMPLATE/vanguard-task.md) defaults to `ready for agent` only. The spec loop runs when a human downgrades the label to `ready for spec` (for high-level ideas that need a research + planning pass first). Leaving the label as `ready for agent` skips the spec pass and goes straight to implementation — this is intentional, not a bug. Add an ownership label such as `vanguard` only when your watcher is started with `--label vanguard`.

### Routing labels — full set (which go on an **issue** vs a **PR**)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="diagrams/labels-dark.svg" />
    <img src="diagrams/labels-light.svg" width="100%" alt="Taskcell routing labels on GitHub, in three columns: labels you add, labels Taskcell sets while working, and labels that mean it is your turn. needs research leads to vanguard:researching, which posts findings and rests until you pick the next label. ready for spec leads to vanguard:speccing, which posts the spec and moves the issue to ready for agent, or to needs info when triage finds it too vague. ready for agent leads to vanguard:running, then vanguard:needs-human-review once the PR is open, or needs info. needs revision on a PR Taskcell opened leads to vanguard:revising, which pushes fixes and returns to vanguard:needs-human-review. ready for vanguard review on any PR leads to vanguard:reviewing, then vanguard:reviewed; where the review workflow opts in, it adds that label itself to a factory PR that opens ready for review or leaves draft. GitLab uses the same ready for spec, ready for agent and needs info labels, writes its states with a double colon (vanguard::speccing, vanguard::running, then vanguard::review once the MR is open) and has no research or revise pass; Linear routes by workflow states instead." />
  </picture>
</p>

`ready for ...` / `needs ...` are **triggers you add by hand**; `vanguard:...` are **states Taskcell sets itself**. On GitHub Actions, issue-side triggers fire `issues: labeled` workflows; PR-side triggers fire `pull_request_target: labeled` workflows. The exception is `ready for vanguard review`: this repo's review workflow also adds it to a factory PR that opens ready for review or leaves draft, so that PR gets Taskcell's review without anyone labelling it. A caller copied from [onboarding-another-repo.md](onboarding-another-repo.md) runs on the label only.

These are the GitHub names. GitLab (`watch --source gitlab`) uses the same `ready for spec`, `ready for agent` and `needs info` triggers but writes its states with a double colon: `vanguard::speccing`, `vanguard::running`, `vanguard::review` once the MR is open, and `vanguard::reviewing` / `vanguard::reviewed` for `watch-mrs`, whose trigger label you pass with `--label`. GitLab has no `needs research` or `needs revision` pass. Linear routes by workflow states (table below), and a GitHub Projects board by its Status column.

| Label | On | Kind | Triggers / means |
|---|---|---|---|
| `ready for spec` | issue | trigger | spec pass writes a `<tech_spec>`, then builds |
| `ready for agent` | issue | trigger | builds directly (issue already scoped) |
| `needs research` | issue | trigger | external research → posts a findings comment → **rests** (no auto-advance; you set spec/agent next) |
| `needs info` | issue | triage (resting) | parked — ticket too vague |
| `ready for vanguard review` | **PR** | trigger | adversarial **read-only** review → posts a comment; never edits code |
| `needs revision` | **PR** (opened by Taskcell) | trigger | reads your review comments → fixes on the PR branch → pushes → un-drafts if still a draft → back to `needs-human-review` |
| `vanguard:speccing` · `:running` · `:researching` · `:revising` · `:reviewing` | issue/PR | transient state | Taskcell is working (seconds–minutes) |
| `vanguard:needs-human-review` · `:reviewed` · `:verify-failed` · `:visual-proof-failed` | issue/PR | resting state | waiting on a human |

The word "review" means two things: `ready for vanguard review` (PR) is **Taskcell reviewing your PR** (read-only comment); `needs revision` (PR) is **Taskcell acting on your review of its own PR** (edits + pushes). `vanguard:needs-human-review` is the post-build resting state — your turn to review the PR.

```bash
# GitHub defaults
taskcell doctor --source github --github-repo owner/repo
taskcell watch --source github --github-repo owner/repo

# GitHub with custom labels/model
taskcell doctor --source github --github-repo owner/repo --label vanguard \
  --spec-label "ready for spec" \
  --agent-label "ready for agent" \
  --needs-info-label "needs info"
taskcell watch --source github --github-repo owner/repo \
  --label vanguard \
  --spec-label "ready for spec" \
  --agent-label "ready for agent" \
  --needs-info-label "needs info" \
  --spec-model haiku
```

**Linear (routes by STATES):**

| State condition | What happens |
|---|---|
| State TYPE matches `--spec-state` (e.g. `triage`) + label | Spec pass triggers. Triage runs first — vague tickets get a clarification comment + moved to Needs Info state (no model budget spent). Valid tickets: `techSpecStage` posts a `<tech_spec>` comment, issue moved to the agent-trigger state (`--agent-state`, default `Todo`). |
| State TYPE matches `--trigger-state` (default `unstarted`) + label | Agent pass triggers (next poll after spec, or for any pre-specced issue). Triage runs in `agent` mode — vague tickets moved to `--needs-info-state`. Valid tickets: Implementer → Reviewer → Simplifier → PR (draft only when a gate or configured visual proof failed, or no verify command ran). |
| Needs Info state | Parked. Human updates the ticket and moves it back. |

The two-flag split is Linear-specific: `--agent-state` sets the **state name** the spec pass moves the ticket to (`Todo`), while `--trigger-state` matches the **state type** the agent pass fires on (`unstarted`). The default `Todo` is of type `unstarted`, so they line up out of the box and `--trigger-state` rarely needs setting (hence its absence from the example below) — unlike GitHub, where a single `--agent-label` is both the move target and the trigger.

```bash
# Linear defaults
taskcell doctor --loop-v1 --label vanguard
taskcell watch --loop-v1 --label vanguard

# Linear with custom states/model
taskcell doctor --loop-v1 --label vanguard --spec-state triage --spec-state-name Spec \
  --needs-info-state "Needs Info" --agent-state Todo
taskcell watch --loop-v1 --label vanguard \
  --spec-state triage \
  --spec-state-name Spec \
  --needs-info-state "Needs Info" \
  --agent-state Todo \
  --spec-model haiku
```

## Shared behaviour (both sources)

- `taskcell doctor` runs the AFK preflight without claiming work. It checks Node 24+, LLM auth, repo remote, Docker daemon, the sandbox image, `vanguard-sandbox:latest` or `VANGUARD_SANDBOX_IMAGE` when set (including the Claude CLI version inside it — see [Keeping the sandbox image current](cli.md#keeping-the-sandbox-image-current)), source auth, GitHub routing labels, and Linear env/skills setup. On a GitHub repo it also verifies the "Allow GitHub Actions to create and approve pull requests" setting (best-effort — skipped if the token cannot read it) and, when Codex is selected with a `CODEX_AUTH_JSON` subscription credential, validates its shape before the run.
- Triage is deterministic (`assessTaskReadiness`) and rejects under-specified tickets before spending any model tokens.
- The spec stage is read-only: it posts a `<tech_spec>` comment but never writes code or opens a PR.
- In continuous mode, a freshly-specced ticket is implemented on the **next poll** (human intervention window). In `--once` mode spec and build complete in the same invocation.
- `--spec-only` runs just the spec pass on each tick:
  - It works with or without `--once`. The agent pass never lists, claims or runs anything.
  - `--max-tasks` caps the spec pass only.
  - Flags only the agent pass reads (`--claimed-state`, `--review-state`, `--plan`, `--flow` and similar) have no effect.
  - Use it for a human review window in scheduled `--once` jobs: a spec-only job advances specced tickets to a review state or label (`--agent-state` / `--agent-label`) that the build job does not trigger on, a human moves approved tickets to the build trigger, and a separate watch without `--spec-only` builds them. On Linear the spec pass and the build job both list issues by state type, so the review state's type must differ from the `--spec-state` type (or the spec pass specs the ticket again on every poll) and from the build job's trigger type (`unstarted` by default). With the default `--spec-state triage`, a backlog-type review state works.
  - `--spec-only` requires `--agent-state` (Linear) or `--agent-label` (GitHub, GitLab) other than the default build trigger (`Todo`, `ready for agent`), which would give no review window. Only the default is checked: Taskcell cannot see a build job that triggers on another state or label.
  - The build job must be single-pass, or its own spec trigger must point at an unused state or label: a loop-v1 build job (the `watch --source github --once` shorthand is one) specs any ticket still in the spec trigger and builds it in the same `--once` run, so that ticket never waits in review. On GitHub and GitLab the single-pass build job's `--label` must be the approval label a human applies (for example `ready for agent`), not the loop-v1 ownership `--label`: the spec pass leaves the ownership label on every ticket, so a build job on it would also build tickets still in review and tickets not yet specced.
  - Preflight for a spec-only watch (or `doctor --spec-only`) skips the checks that only guard publishing: the pr-create setting, the agent-pass claimed/review labels, and a Linear run's GitHub/GitLab publish auth.
- The human role is to write good tickets + approve the final PR. The [issue template](../.github/ISSUE_TEMPLATE/vanguard-task.md) is the intended intake path.
- External PR review is available as a one-shot `review-pr` command, an always-on `watch-prs` polling loop, or a GitHub Actions label trigger.

Operator logs stay terse and progress-oriented so always-on runs are scannable:

```text
preflight: node 24 ok
preflight: llm auth ok
preflight: github labels ok
spec: poll -> 1 ready
spec owner/repo#123: claim -> triage
spec owner/repo#123: advanced -> next poll agent
watch: poll -> 1 ready
watch owner/repo#124: claim -> running
watch owner/repo#124: pr opened -> review
```

Normal logs report source, task id, phase, outcome, and next action. Full prompts, diffs, transcripts, and proof details stay in `.taskcell/runs/`.

## External PR review

`taskcell review-pr` runs an adversarial, read-only review over an existing GitHub PR diff and posts a non-blocking GitHub review comment. It does not edit code, open another PR, or move issue labels. The review opens with its `Verdict:` line followed by `Risk: low|medium|high — <what the change can break>` (MR reviews get the same line). The risk is advisory: it never changes the verdict or the merge gate, and `review-pr` reports it in its result and the job summary next to the verdict.

The reviewer applies the repository's review guidelines (`CLAUDE.md` or `AGENTS.md`, and any document they point to). It reads them from its sandbox checkout, which `review-pr` and `review-mr` build from the local `main` branch, not from the PR or MR head. Keep that local `main` current with the target branch; guideline edits inside the diff are reviewed, not applied. This stops an author from rewriting the rules their own change is judged by only when the author cannot change the job that runs the review. A GitLab MR pipeline reads its job definitions from the MR's source branch, so the author of a same-project MR controls the whole job. They can point `main` at their own head, since the detached checkout has no local `main` until the job script makes one. They can also change the provider, model, prompt or token, or stop the review from running or posting. A GitHub workflow on `pull_request` for a branch in the same repository has the same exposure, because it takes the workflow file from the PR's merge ref. A workflow on `pull_request_target`, or on `workflow_dispatch` run from the base branch, takes it from the base branch and avoids this, provided the job checks out and runs only base-branch code. Never check out or build the PR head in a `pull_request_target` job, because that job has the repository's secrets and a write token. Where that matters, run the review from a pipeline whose configuration the author does not control. A label that a maintainer adds after reading the diff is not enough: the job definition still comes from the source branch, and the author can push a new one after the maintainer has read it.

```bash
taskcell review-pr https://github.com/owner/repo/pull/123
taskcell review-pr --github-pr 123 --github-repo owner/repo --provider codex --review-model gpt-5
```

`taskcell watch-prs` turns that reviewer into a small PR loop. It polls only PRs with an explicit trigger label, skips drafts and Taskcell/bot-authored PRs, swaps labels while reviewing, and restores the trigger label on failure so the next poll can retry; if the restore itself fails you will see a `restore failed -> manual label check` log line and should verify the PR labels by hand before the next poll. Pass `--author <login>` to restrict the loop to a single author's PRs (self-review-only). Successful reviews include a hidden `headRefOid` marker, so the loop skips the same commit if the trigger label is re-added accidentally.

```bash
taskcell doctor-prs --github-repo owner/repo --label "ready for vanguard review"
taskcell watch-prs --github-repo owner/repo --label "ready for vanguard review"
taskcell doctor-prs --github-repo owner/repo \
  --label "ready for vanguard review" \
  --reviewing-label "vanguard:reviewing" \
  --reviewed-label "vanguard:reviewed"
taskcell watch-prs --github-repo owner/repo \
  --label "ready for vanguard review" \
  --reviewing-label "vanguard:reviewing" \
  --reviewed-label "vanguard:reviewed" \
  --author owner \
  --provider codex \
  --review-model gpt-5
```

| PR label state | What happens |
|---|---|
| `ready for vanguard review` | Picked up on the next poll. The label is removed and `vanguard:reviewing` is added before the review starts. |
| `vanguard:reviewing` | Claimed/in progress. Later polls skip it. |
| `vanguard:reviewed` | Review comment posted successfully. Re-add the trigger label after new commits if you want another review pass; the same commit is deduped by the hidden review marker. A review whose reply stated its `Verdict:` line but stopped before the completion signal counts as posted (with a truncation note), so it is deduped too. A reply with no verdict after two passes posts an incomplete notice without the marker — remove and re-add the trigger label (or run the workflow by hand) to retry. |

Operator logs stay compact:

```text
review-pr owner/repo#123: fetch -> diff
review-pr owner/repo#123: agent -> reviewing
review-pr owner/repo#123: posted -> pr review
review-pr owner/repo#123: done
watch-prs: poll -> 1 ready
watch-prs owner/repo#123: claim -> reviewing
watch-prs owner/repo#123: reviewed -> marked
```

### GitHub Actions trigger

`.github/workflows/taskcell-pr-review.yml` fires on `pull_request_target` when the `ready for vanguard review` label is applied to a PR. It also fires when a factory PR (a `chore/vanguard-*` branch in this repo, opened by an allowed login) opens ready for review or leaves draft: a first job adds the label, so that PR is reviewed without anyone labelling it. It can also be triggered manually via `workflow_dispatch` to sweep all currently-labeled PRs.

**Required secrets:** `CLAUDE_CODE_OAUTH_TOKEN` — the Claude subscription OAuth token. The built-in `GITHUB_TOKEN` provides PR/label write access automatically.

**Security model:** the workflow uses `pull_request_target` because posting reviews requires repo secrets and write permissions. It checks out only the base branch — PR head code is never fetched or executed. The model credential stays inside the `--llm-proxy` sidecar, which also restricts sandbox egress to an allowlist, so the untrusted PR diff cannot exfiltrate the model credential. Because the review is read-only (it reviews the diff in a sandbox and only posts a comment), the job gate is an **author + sender allow-list** rather than a single login: `contains(fromJSON('["spietrza","pawelkrystkiewicz"]'), github.event.pull_request.user.login)` **and** the same check on `github.event.sender.login` — a trusted person labels a trusted person's PR. Widen the list to add reviewers; keep it tight because each entry can trigger a run on the repo's review credit. (The sibling `taskcell-revise.yml` workflow, which *pushes* code, keeps its author gate to the bot/owner only.)

**Behavior:** each run (a label event, or a factory PR that just became ready) runs `watch-prs --once` (the gate, not an `--author` filter, controls which PRs are eligible), reviewing PRs carrying the trigger label. This is idempotent: already-reviewed commits are skipped via the hidden `headRefOid` marker and the label swap.

**Re-review:** after new commits land, remove and re-add `ready for vanguard review` to trigger a fresh pass.

**Label setup:** the workflow creates the three routing labels idempotently on every run (`gh label create --force`), so no manual label setup is needed in a fresh repo.

**Relationship to always-on `watch-prs`:** both modes watch the same label; dedupe makes running both safe but redundant — pick one per repo.

Run `taskcell gc --remote <owner/repo>` on a timer (cron or systemd) to reap stale sandboxes, worktrees, and merged branches — see [Garbage collection](deploy.md#garbage-collection-and-self-maintenance) for cron and systemd-timer examples.

## Metrics and tracing

Each run appends a `run_complete` metric line per stage to `.taskcell/runs/metrics.jsonl` (cost, tokens, cache efficiency, duration, exit reason). `taskcell stats` aggregates that into a rollup — per task, per stage, per model (served, annotated with the requested one when a gateway substituted it), and a grand total — for fleet cost/time visibility (`--json` for machine output). **On an ephemeral host (GitHub Actions) that file dies with the job**, so a run there ends with `taskcell metrics push`: it appends the run's metric lines to a single `metrics.jsonl` on an orphan `taskcell-metrics` branch of the repo (git plumbing only — no checkout, no merge; idempotent, so a re-run never duplicates; needs push rights, which the implement workflow's `contents: write` already grants). `taskcell stats --branch taskcell-metrics` then reads that durable copy from any clone — it is where the `BY MODEL` and `PROBE` tables for the factory come from. When the reviser has checked PR branches against their base, a `BASE MERGES` table shows conflicts per week (UTC Monday): merges, conflicts, auto-resolved by the agent, left for a human, plus the top conflicted files (`--json` adds it as `conflicts`; the hub Runs page shows the same totals). They come from the `base_merge` lines `revise-pr` appends, one per base check. Add `--github-repo owner/repo` for a `LEAD TIME` block: for every PR recorded in the metrics it asks `gh` for the time from the trigger label to the PR, from the PR to its merge, the revise rounds and the first-try merge rate (medians; at most six lookups at a time; failed lookups are counted and reported, so a partial sample is visible). `--json` adds it as `leadTime`.

**Langfuse / OTLP mirror (opt-in).** The same per-stage records can be exported as one OpenTelemetry trace per run: the task id is the trace, each stage is a `generation` span carrying `gen_ai.request.model`, `gen_ai.usage.{input_tokens,output_tokens,cache_read_input_tokens}`, `gen_ai.usage.cost` / `vanguard.cost_usd`, `vanguard.turns` and `vanguard.exit_reason`; flow, provider, PR URL and exit reason ride on every span as filterable Langfuse trace metadata, and the task id doubles as the Langfuse *session*, so the spec run, the implement run and each revise round of one issue group together. Switch it on with an endpoint **and** auth — endpoint without auth is off, and with nothing set nothing changes:

| Variable | Value |
| --- | --- |
| `VANGUARD_OTLP_ENDPOINT` (or the standard `OTEL_EXPORTER_OTLP_ENDPOINT`, honored only with `VANGUARD_OTEL=1`, so an inherited host-wide OTel config never starts an export) | OTLP base; for Langfuse `https://<your-langfuse>/api/public/otel` (`/v1/traces` is appended) |
| `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | a Langfuse project key pair — Basic auth and the `x-langfuse-ingestion-version: 4` real-time header are derived; used only for a Langfuse-shaped endpoint (`VANGUARD_OTLP_ENDPOINT`, or a path containing `/api/public/otel`), so a host-wide `OTEL_EXPORTER_OTLP_ENDPOINT` never receives them |
| `VANGUARD_OTLP_HEADERS` (or `OTEL_EXPORTER_OTLP_HEADERS`, again only with `VANGUARD_OTEL=1`) | alternative for any other collector: the OTel `k=v,k2=v2` list, which must include `Authorization=…` |

The export is a hand-rolled OTLP/HTTP JSON POST from the host process (no OpenTelemetry SDK, nothing reaches the sandbox), fired from the same place the metric line is written so local and CI runs behave the same; a failure is reported once on stderr and never fails the run — `metrics.jsonl` stays the record of truth. **Self-hosting on Coolify:** deploy Langfuse from Coolify's one-click service template, create a project, copy its public/secret keys, and set the three variables where Taskcell runs (on GitHub Actions: a repository variable for the endpoint, two secrets for the keys, passed through the workflow's `env`).

## Implement issues via GitHub Actions

Run the two-pass loop straight from GitHub Actions — no always-on host. Label an issue and the workflow runs the pipeline in a sandbox, with the routing labels moving live:

- **`ready for spec`** — a rough idea: Taskcell writes a tech spec, advances the ticket to `ready for agent`, **then builds it** and opens a PR — all in one job.
- **`ready for agent`** — a written, ready ticket: Taskcell builds it directly.
- **too vague** — triage parks it at `needs info` (no budget spent); you fill it in and re-label.

Your repo carries only a **thin caller** (triggers, permissions, an actor gate and a `uses:` line); the steps live in reusable workflows in this repo (`implement.yml`, `pr-review.yml`, `research.yml`, `revise.yml`, `doctor.yml`), so a change to a default or a step reaches every repo without touching its copy. For the copy-paste callers, secret mapping, `allowed-actors`, the `@v1` / `@main` pin, the inputs of each workflow, the Codex-subscription setup, and the triage contract see **[onboarding-another-repo.md](onboarding-another-repo.md)**. `decision-probe`, `persist-metrics` and `upload-run-records` are off by default there: the probe ships issue text to Cloudflare, persisting metrics writes a branch into your repo, and run-record artifacts are readable by anyone who can read the repo.

The job runs `taskcell watch --source github --once` **once**: a `ready for spec` ticket is specced and built in the same invocation. Taskcell's own [`taskcell-implement.yml`](../.github/workflows/taskcell-implement.yml) is a caller of [`implement.yml`](../.github/workflows/implement.yml) (`uses: ./.github/workflows/implement.yml`). Each run processes every matching open issue (not only the one just labelled), so labelling one `ready for agent` also picks up any others already waiting — run an always-on `taskcell watch` on a host if you want continuous polling instead ([deploy.md](deploy.md)). Set `max-tasks: <n>` on the caller (or `--max-tasks <n>` on a host-run `taskcell watch`) to cap how many ready issues one run claims per phase, so a mislabelled batch cannot flood one CI runner.

**Run summary:** on Actions every run — each issue `watch` builds, each PR `watch-prs` reviews, each `revise-pr` round — also appends a markdown block to the job's **Summary** tab (via `$GITHUB_STEP_SUMMARY`): task id, flow, provider and model, a per-stage table (exit, turns, time, cost), the cost total, the PR URL, the review verdict, and how the run ended (`completed` / `verify-failed` / `secret-blocked` / `no-changes` / `error`). Several runs in one job stack. Outside Actions nothing is written. The on-disk run record under `.taskcell/runs/<taskId>/` (transcripts, diffs, bundles) still dies with the job unless the caller uploads it as an artifact.

**Required secret:** `CLAUDE_CODE_OAUTH_TOKEN` (repository or org secret). The built-in `GITHUB_TOKEN` covers git push, PR, and label writes.

**Required repo setting:** enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**. Without it the agent's `gh pr create` fails with `GitHub Actions is not permitted to create or approve pull requests` after doing all the work. (Set it via API: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true`.)

**Security:** the job condition restricts triggers to the maintainer's own issues (`github.event.issue.user.login` and `sender.login`), so a stranger labelling an issue cannot start a run. `--llm-proxy` keeps the model credential in a sidecar, out of the sandbox.

### Run it on another repo

The target repo does not need Taskcell installed: add the `CLAUDE_CODE_OAUTH_TOKEN` secret, enable the PR-creation setting above, and drop in a ~25-line caller that does `uses: spietrza/taskcell/.github/workflows/implement.yml@v1` — the full caller, the secret mapping and the input tables are in **[onboarding-another-repo.md](onboarding-another-repo.md)**.

Notes: the repo needs at least one commit (an empty repo has no `main` to open a PR against). The sandbox agent reads the target repo's `CLAUDE.md`, so put design/stack rules there to steer output — Taskcell does not inject your local Claude Code skills. The reusable workflow passes `--skills .vanguard-src/skills`, which injects Taskcell's bundled skills (`ponytail`, `code-review`, `simplify`), plus any skills the repo keeps in `.github/vanguard-skills/` (see [Custom skills](skills.md#custom-skills-bring-your-own)). Don't run this **and** an always-on GitHub watcher on the same labels — pick one per repo (a Linear watcher does not clash). The reusable workflow installs Taskcell with `--ignore-workspace`, so it also works when the target repo is a **pnpm workspace** (monorepo).

**Backward compatibility — `vanguard:review` label (deprecated).** The post-build resting state was renamed from `vanguard:review` to `vanguard:needs-human-review`; A repo onboarded before the rename may still carry `vanguard:review` on in-flight items — Taskcell will not migrate it automatically. The new default and the old label coexist harmlessly (`gh label create --force` adds the new one without touching the old); delete the stale `vanguard:review` once nothing in flight uses it, or pass `--review-state vanguard:review` to a host-run `taskcell watch` if you deliberately want to keep the old terminal label (the reusable workflow has no input for it).

### Cross-provider on a Codex subscription (no OpenAI key)

Want Opus to plan, Sonnet to build, and Codex to review, with Codex running on a ChatGPT Plus/Pro subscription instead of a paid OpenAI API key? Two changes to the caller.

**1. Add the subscription credential as a secret.** Run `codex login` once on your machine (a ChatGPT account, `auth_mode: chatgpt`), then push the resulting `auth.json` verbatim — it holds OAuth tokens, not an API key:

```bash
gh secret set CODEX_AUTH_JSON --repo OWNER/REPO < ~/.codex/auth.json
```

**2. Set the providers.** Map the secret in the caller's `secrets:` block and pick a provider per stage in `with:`:

```yaml
    uses: spietrza/taskcell/.github/workflows/implement.yml@v1
    with:
      allowed-actors: '["YOUR_LOGIN"]'
      spec-model: opus
      provider: claude
      provider-model: sonnet
      review-provider: codex
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
```

`spec-model: opus` plans, `provider: claude` + `provider-model: sonnet` implements and simplifies, `review-provider: codex` reviews (these map to `--spec-model`, `--provider`, `--provider-model`, `--review-provider`). Taskcell writes `CODEX_AUTH_JSON` to `~/.codex/auth.json` inside the sandbox (see [Providers](cli.md#providers)) and Codex runs on the subscription. `--skills` reaches both: the Claude stages get the full skill directories, the Codex reviewer gets a pointer index in its `AGENTS.md` (see [Skills](skills.md)).

`provider-model` applies only to the Claude stages; it is never handed to the cross-provider reviewer (an Anthropic model name like `sonnet` would be rejected by the ChatGPT backend). The Codex reviewer uses its own default model — set `review-model` to pick a specific one.

`llm-proxy` now covers a subscription too: a ChatGPT sidecar holds the real `auth.json` on the host and the sandbox gets only a placeholder one pointed at it (see [Host LLM proxy](security/boundaries.md#host-llm-proxy)). Turning it on keeps both the Claude token and the ChatGPT credential out of the sandbox; leaving it off puts both in the sandbox directly — acceptable on a repo you own.

One CI caveat: the stored `CODEX_AUTH_JSON` is a snapshot. Codex refreshes the short-lived access token from the embedded `refresh_token` on each run, so the secret must carry a live refresh token; re-run `gh secret set` if a run ever fails to authenticate. For long-running hosts (a `taskcell watch` on a server) the local file refreshes itself and this does not come up.

## Approver (shadow mode)

`taskcell approve` is the stage after review: it decides whether a factory PR is boring enough to merge without a human, deterministically and with no LLM in the loop. v1 runs in **shadow mode** — it computes and publishes the decision, and never merges, approves, or edits a label. The point is to collect a record of what it *would* have done next to what humans actually did.

**What it decides.** One of two verdicts. `ESCALATE` if any rule fires, `APPROVE` only when the rule list comes back empty. The rules cover: not a same-repo `chore/vanguard-*` head, a closed or merged PR, draft, a required check that is not `success` from the expected app, a missing / stale / blocking / verdict-less review, a merge conflict, a head that moved under the run, git facts that could not be computed, a changed path on a sensitive surface (CI config, dependencies, deploy/migrations, security surface, the review pipeline itself, gate config, agent instructions, release config), a diff over the size ceiling, a deleted test file or a net loss of test cases, a new dependency, a removed export — plus a deterministic audit sample (10%) that escalates a share of otherwise-clean PRs so humans keep seeing normal cases, and a trailing-week per-module line ledger that escalates a drip of individually-small changes.

**Which typed facts it reads.** Only structured data, never free text from an issue, PR body, or comment. From `gh`: the PR record (`isDraft`, head/base refs and SHAs, head repo) and check runs on the head SHA matched by **both** name and app id. From the published review: the verdict line and the head-SHA marker of the latest review in the external review format whose author is on the allow-list — a body with no marker, or with more than one distinct marker SHA, is rejected, and the main loop's own in-pipeline review never counts. From git, read-only (fetch into `FETCH_HEAD`, then `show`/`diff`/`patch-id`/`merge-tree` against SHAs — the PR head is never checked out): changed files, lines and paths against the merge base, deleted test files and test-case delta, removed exports, new manifest dependencies, patch ids and ancestry, and merge-tree cleanliness. Any git fact that cannot be computed fails closed into `git-facts-failed`.

**Where records go.** One JSON line per decision, appended to `decisions.jsonl` on the orphan `taskcell-metrics` branch (the same branch `taskcell metrics push` uses — the files coexist, nothing is rewritten). Append-only and idempotent per (PR, head SHA): a rerun at the same head adds nothing, except that a `stopped` / `policy-unreadable` placeholder does not block the full decision once the stop is lifted. Each record holds the verdict, every rule id that fired, the signals behind them, the audit draw and its seed, and the `sha256` of the policy that produced it, so any decision can be replayed. The decision is also published as a `neutral` check run (`vanguard/approver`) and a PR comment. The check run and comment go out first and the record last; all three are attempted even when one fails, and any failure makes the command exit non-zero after the rest ran.

**How to run it.**

```bash
taskcell approve --pr 557 --github-repo spietrza/taskcell     # decide, publish, record
taskcell approve --pr 557 --github-repo spietrza/taskcell --json      # print the decision record
taskcell approve --pr 557 --github-repo spietrza/taskcell --dry-run   # decide and print only — publish and record nothing
```

`--github-repo` is required (the approver never infers the repo it judges), `--repo <path>` points at a local checkout of the base branch (default: cwd), and `--mode` is `shadow` (default) or `act` (below).

**In CI (this repo).** `.github/workflows/taskcell-approver.yml` runs it after the external review of a factory PR finishes (`workflow_run` on `Taskcell PR Review`), and waits for the required CI checks before deciding. That way the decision sees complete inputs once; triggering on CI as well would record a premature `review-missing` that the per-head dedupe then keeps. It builds the CLI from the default branch and never checks out PR code. Run it by hand from Actions → Taskcell Approver (shadow) with a PR number. Drafts get no decision, since the review does not run on them.

**Policy and kill switch.** Everything tunable lives in `.taskcell/approver.json`, read from the **base branch only** (`git show refs/remotes/origin/<base>:.taskcell/approver.json`) — never the working tree or the PR head, so a PR cannot widen the policy judging it; a PR that touches that file always escalates. An unreadable or invalid policy fails closed to `ESCALATE` (`policy-unreadable`). Field-by-field reference: [approver-policy.md](approver-policy.md).

Two kill switches, either one short-circuits to `ESCALATE` (`stopped`) before any diff or ledger collection:

```bash
VANGUARD_APPROVER_STOP=1 taskcell approve --pr 557 --github-repo spietrza/taskcell   # per-run, env
# or, repo-wide: set "enabled": false in .taskcell/approver.json on the base branch
```

### Act mode (opt-in)

Off by default: with `act` absent or `false`, behaviour is exactly the shadow mode above. It needs **both** `"act": true` in `.taskcell/approver.json` on the base branch **and** `--mode act` on the command line (the approver job's workflow); either one missing means shadow.

For a factory PR whose latest review on the current head says `NO BLOCKING FINDINGS`, whose required checks are green and whose decision is `APPROVE`, act mode:

1. if the base moved (the merge-base is not the base tip, or GitHub says `BEHIND`), runs `gh pr update-branch` — a merge of the base into the head, never a rebase or force-push;
2. waits (polling, 30 min cap, one update per run) for the required checks on the new head, then decides again on it;
3. appends the `APPROVE` record the merge is made on to `decisions.jsonl` (flagged `actMerge: true`, written even when that head already has a decision — the log never shows an `ESCALATE` followed by a merge with no `APPROVE`), then squash-merges with `--match-head-commit <sha>`, so a head that moved after the decision is never merged.

In act mode the decision itself goes to the check run (`vanguard/approver`, titled `(act)`) and the log, not a comment; a comment is posted only when a human has to act.

**Conditions for a merge** — act mode merges only when all of these hold; otherwise the PR is left for a human with one comment per head saying why:

- **Not a draft.** Act mode never marks a draft ready: the factory opens drafts for more reasons than a failed verify, and a human may have set it as a hold.
- **No human hold.** No review on the PR is `CHANGES_REQUESTED`, and the PR does not carry the policy's `holdLabel` (default `taskcell:hold`).
- **Opened by the factory.** The API-sourced PR author (`gh pr view --json author`) is one of the policy's `factoryAuthors` logins, **and** the head is a same-repo branch with `factoryBranchPrefix`. No `factoryAuthors` in the policy means act mode acts on nothing.
- **`mergeStateStatus` is `CLEAN`** (after the update, if one was made). `BEHIND` triggers the one update; `BLOCKED`, `UNSTABLE`, `UNKNOWN`, `DIRTY` or an absent status are left for a human.
- **Exact review validity.** The head is the reviewed commit, or the head's tree equals the tree of `git merge-tree --write-tree <base> <reviewedSha>` (the base merged into the reviewed commit). An equal patch-id is not enough to merge (shadow mode keeps the patch-id rule for its verdict); anything else needs a new review.
- Not a release PR (head branch or title says release), touches no CI config and no path matched by `pathRules`, and the decision is `APPROVE`.

A base that moves again after an update, checks that fail or time out on the updated head, and a rejected merge are left for a human too. **Token caveat:** a push made with the workflow's `GITHUB_TOKEN` starts no workflows, so if the updated head gets no checks the wait times out and the PR is left for a human; use a token that triggers CI for the update if this matters. PRs merged by act mode are left out of `taskcell stats --approver`, so the approver's own merges never validate its verdicts.

Every action (`update-branch`, `merge`, `left-for-human`, `merge-failed`, `checks-failed`, `base-moved`) is appended to `decisions.jsonl` with the PR, head SHA, reason and timestamp (records with an `action` field and no `verdict`; the ledger and scorecard skip them). The code allow-lists exactly two `gh` writes on top of shadow's (`pr update-branch`, `pr merge --squash --match-head-commit`) and requests no new permission; the token must be able to merge but cannot push `.github/**` changes, and act mode refuses such PRs anyway.

**Turning it off:** set `"act": false` (or remove it) in `.taskcell/approver.json` on the base branch, or `"enabled": false`, or set `VANGUARD_APPROVER_STOP=1`; the next run is shadow or stopped. Switching the approver job to act is a workflow edit (`--mode act`) for a human to apply.

### Scorecard: shadow verdict vs what the human did

`taskcell stats --approver` turns the recorded decisions into the thing shadow mode exists to answer: was the verdict right? For every factory PR with a decision on `decisions.jsonl`, it joins the shadow verdict and the rules that fired to what actually happened to the PR — read from `gh pr list` (state, merge, the final head SHA) and a scan of the default branch's revert commits, never guessed:

- **merged with no commits after the verdict** — the PR's final head SHA is exactly the one the decision judged.
- **merged after revision** — more commits landed after the decision's head SHA before it merged; the verdict is stale regardless of what it said.
- **closed unmerged**.
- **reverted** — a revert commit targeting the merge commit landed on the default branch within 7 days of the merge; this overrides either merged outcome above, since a later-reverted merge was never a correct `APPROVE`.

A PR with no decision at all (the approver never ran, or hasn't yet) is listed with no verdict and excluded from every count, same as a decision whose outcome isn't resolved yet (still open). The risk class per row is whichever `path:<key>` rules fired (see `pathRules` in [approver-policy.md](approver-policy.md)), or `general` when none did — true of every `APPROVE` by construction, since any matched path rule escalates.

Per risk class, the report counts how many `APPROVE` verdicts were right (merged as-is, not reverted within the window), how many `ESCALATE` verdicts the human merged unchanged anyway (a signal the escalation was unnecessary), and the current streak of correct `APPROVE` verdicts in a row — reset to 0 by a wrong one, left untouched by an `ESCALATE` landing in between. **30 correct `APPROVE` verdicts in a row in one risk class** is the documented bar this report measures progress toward, shown as `streak/30` per class — the point at which that class of PR could be considered for opt-in auto-merge. Reaching it does nothing by itself; this command only reports, it never flips a switch.

```bash
taskcell stats --approver                                        # text report: per-PR rows, then per-risk-class rollup
taskcell stats --approver --json                                 # the same ApproverScorecardReport, machine-readable
taskcell stats --approver --branch vanguard-metrics               # read decisions.jsonl from a non-default metrics branch
```

## Retrospective memory

`taskcell memory` reads `.taskcell/runs` artifacts — failed runs, failed proofs, and reviewer notes (not diffs or transcripts) — and refreshes a short, redacted digest at `.taskcell/memory/retrospective.md`. It is deterministic (no LLM): a host-side rollup, advisory only.

Subsequent `run`, `watch`, and spec runs automatically load that digest into the implementer and tech-spec prompts as advisory context ("use only when relevant"); the digest refreshes best-effort after each run. `.taskcell/` is operational host state, not committed source — add it to your `.gitignore`.

```bash
taskcell memory                 # refresh + print the digest
taskcell memory --json          # machine-readable report
taskcell memory --limit 20      # keep the 20 most recent entries
```

### Per-PR lessons

That digest dies with a CI job, so closed factory PRs also leave **lessons** on the metrics branch. `taskcell lessons record --pr <n> --github-repo <o/r>` reads the PR's history: blocking review verdicts, revise rounds, a `vanguard:verify-failed` label and the diff stats. A clean first-round merge records nothing and makes no model call. Otherwise one cheap completion (`haiku` by default, `--provider-model` to change, no tools) writes 0-3 lessons. Each lesson has a rule the next run can act on, why it matters, an evidence link (the PR or a comment) and an optional scope of path globs and stage. Lessons are redacted and appended to `lessons.jsonl` on `taskcell-metrics`, deduplicated by rule. The command then comments them on the PR. Only comments from trusted authors (repo association, bots, `--feedback-authors`) reach the prompt.

Later `run`, `watch` and spec runs read the live lessons back into the retrospective block. A lesson qualifies when it is repo-wide or when one of its globs matches a path that the issue text mentions or a file the run changes: the spec's planned files at implement time, the diff's files when a failed gate is repaired, and the PR's diff files in a revise round. The block is capped at 2 KB; when more lessons match than fit, the most specific glob wins, then the lesson with the most `violations` (an optional count on the stored lesson), then the newest, so repo-wide lessons are cut first. The ids injected are recorded as `lessonIds` on the run's stage records, and `taskcell lessons list` shows how many local runs received each lesson. A wrong lesson is dismissed with `taskcell lessons dismiss <id>` (the id is in the PR comment and in `taskcell lessons list`), and runs no longer receive it.

On GitLab, `taskcell lessons record --gitlab-project <group/project> --mr <n>` does the same through `glab`: the history comes from the MR's notes and the `taskcell::verify-failed` label, and the lesson note is posted on the MR. GitLab notes carry no association, so only notes by the user `glab` runs as (Vanguard's own reviews and revise notes) and `--feedback-authors` logins reach the model; the model runs with tools disabled. `lessons list` and `lessons dismiss` work the same for a GitLab repo. Add the job to `.gitlab-ci.yml` by hand (agents never edit CI config):

```yaml
taskcell-lessons:
  stage: .post
  rules:
    - if: $MR_IID
  script:
    - taskcell lessons record --gitlab-project "$CI_PROJECT_PATH" --mr "$MR_IID"
```

Run it for a closed factory MR with `MR_IID` set (for example from a pipeline trigger on MR close). An MR from a fork, or on a branch other than `chore/vanguard-*`, is skipped with no model call, since its reviews quote text its author controls. The job needs `CLAUDE_CODE_OAUTH_TOKEN`, a `GITLAB_TOKEN` that can read and comment on MRs and push the metrics branch.

This repo runs the step from `.github/workflows/taskcell-lessons.yml` when a `chore/vanguard-*` PR is closed. The job needs `CLAUDE_CODE_OAUTH_TOKEN`.

## Proof of work

**Order.** The gate (verify command, spec conformance, completion) runs on the implementer's output **before** the reviewer, so the review model is never spent on code a repair round would change: implementer → gate (+ repair loop) → reviewer → simplifier. A gate still red after the repair cap skips the reviewer and opens a declared-partial draft PR without a verdict. The secret scan also runs before the reviewer (and again after any repair round), but it stays a **hard stop**, never repair feedback: a hit, or a scan that errors, ends the run as `secret-blocked` exactly like the delivery-time scan — the implementer is not resumed, the reviewer never runs, nothing is committed or pushed, the run record withholds the diff, transcript and final text, and the issue gets the secret-blocked label and comment. Verify runs once for a change nothing touches afterwards; if the reviewer's fixes or the simplifier changed files, the final tree is verified again and the PR body carries that last result. Repair rounds are merged into the implementer's stage metric, which therefore precedes the reviewer's.

After the agent finishes, the host (not the agent) runs a verification command inside the sandbox, captures its stdout and stderr, computes a SHA-256 over the combined output, and stamps a Proof of Work block into the PR body and the run record. The agent cannot fake it.

Command precedence: `--verify "<cmd>"` flag > `VANGUARD_VERIFY_CMD` env > a `verify` script in the worktree `package.json` (the host builds `<pm> install --frozen-lockfile && <pm> run verify`) > auto-detect from `package.json` (if a `test` script exists, the host builds `<pm> install --frozen-lockfile [&& <pm> run typecheck] && <pm> test`) > skip (no command resolved means no block, PR body unchanged). The root `verify` script is `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm verify:desktop`; the last step installs `apps/desktop`, runs its tests and builds it (`tsc` + vite), like CI's `build` job, so a stale `apps/desktop/src/wire.ts` or a desktop break fails the gate. A repo that declares its own `verify` script (e.g. mirroring what its CI build job runs) gets exactly that gate instead of the typecheck/test guess, so verify matches CI.

On failure the PR always opens, the body carries a `FAIL` Proof of Work block (command, exit code, SHA-256, and an output tail), and a `vanguard:verify-failed` label is added to the PR (best-effort).

```bash
taskcell run --linear TES-1 --verify "pnpm typecheck && pnpm test"
# or set for all runs:
VANGUARD_VERIFY_CMD="pnpm typecheck && pnpm test" taskcell watch --label vanguard
```

## Visual proof

After the agent finishes, the host (not the agent) optionally runs a user-supplied visual proof command inside the sandbox — for UI changes that produce screenshots or visual artifacts (e.g. Playwright). It captures stdout and stderr, computes a SHA-256 over the combined output, lists the artifacts the command wrote under `/workspace/.vanguard/visual-proof`, hashes each one (a manifest of path + SHA-256 + byte size — artifacts are not copied out in this version), and stamps a Visual Proof block into the PR body and the run record.

Command precedence: `--visual-proof "<cmd>"` flag > `VANGUARD_VISUAL_PROOF_CMD` env > skip. Unlike Proof of work, there is no auto-detect — if no command is resolved, there is no visual proof and the PR body is unchanged.

Allowed artifact extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`, `.html`, `.json`.

Visual proof failure never blocks the PR: the PR always opens, and on a non-zero exit — or if a configured command can't be executed at all (sandbox crash, cancel, timeout) — the body carries a `FAIL` Visual proof block (a crash is recorded with exit code `-1`) and a `vanguard:visual-proof-failed` label is added to the PR (best-effort). A requested proof is never silently dropped; only when no command is configured is there no block.

```bash
taskcell run --github 123 --visual-proof "pnpm exec playwright test --project=chromium"
# or set for all runs:
VANGUARD_VISUAL_PROOF_CMD="pnpm exec playwright test --project=chromium" taskcell watch --label vanguard
```
