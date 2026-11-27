# Evals and guardrails: where Taskcell stands

A self-assessment against the usual checklist for LLM systems: an eval pipeline from local to production, the kinds of metrics, and guardrails on input, execution and output. Taskcell is an agent that writes code, not a chatbot or a RAG service, so some items map to something else here; the table says what. ✅ in place, ⚠️ partial, ❌ missing.

For the security boundaries themselves see [security/boundaries.md](security/boundaries.md); for the OWASP mapping, [security/owasp-mapping.md](security/owasp-mapping.md).

## Eval pipeline

| Stage | Taskcell | |
|---|---|---|
| Golden dataset | `src/evals/corpus`: 30 cases (control, edge, refusal), run with `taskcell eval` ([cli.md](cli.md)) | ⚠️ small |
| Evals on every PR, gated on a drop | `taskcell eval --baseline main` is the gate (pass-rate drop, refusal regression, corpus-hash mismatch — see [cli.md](cli.md#evals-and-the-baseline-gate)); `.github/workflows/eval.yml` runs it on PRs touching prompts, context or the pipeline once a maintainer adds the `run eval` label, since the PR's own code runs with a model credential | ✅ |
| Comparison with main's baseline | `taskcell eval --save-baseline` publishes a report per main commit to the `taskcell-metrics` branch; `--baseline main` compares against the latest ([cli.md](cli.md#evals-and-the-baseline-gate)) | ✅ |
| Adversarial testing | containment tests against the sandbox (container escape, egress, secrets, permissions, prompt injection), in progress | ⚠️ |
| Production observability | per-run metrics on the `taskcell-metrics` branch (`taskcell stats`), run records with transcript and diff, the shadow [Approver](autonomous-loop.md#approver-shadow-mode), calibration (Brier) of the decision probe | ✅ |
| Feedback loop into the dataset | `taskcell eval --suggest` drafts candidates from failed runs and reviewer notes; retrospective memory feeds later runs. with `--github-repo` also from factory PRs closed without merge, PRs at `needs-human-review` and reverted commits; `.github/workflows/eval-suggest.yml` opens a weekly issue with the drafts. A human curates every case, aiming at about 100 | ✅ |

## Metrics

| Kind | Taskcell | |
|---|---|---|
| Deterministic | `programmaticJudge` in the eval suite; in the factory itself every change passes deterministic gates: tests, typecheck, secret scan, and the spec-manifest conformance gate ([cli.md](cli.md#the-spec-manifest-and-the-deterministic-conformance-gate)) | ✅ |
| LLM as judge | eval judge pinned to a Haiku model, a different family from the model under test, verdict parsed with a schema; a second model reviews every factory change, and a reply without an explicit pass is `incomplete`, never a pass | ✅ |
| Judge calibration on human labels | not done | ❌ |
| Eval libraries (promptfoo, Ragas, DeepEval) | not used: the corpus, judges and report are in-repo, so the harness has no extra dependency and runs the real factory stages | n/a |

## Guardrails

Prompt injection cannot be fully prevented, so the weight is on limiting what the agent can do.

| Level | In place | Missing or opt-in |
|---|---|---|
| Input | author gate on issues and PRs (only listed accounts start the factory); untrusted tracker text escaped and tagged as data in prompts (`src/context/escape.ts`) | no injection classifier |
| Execution | Docker sandbox: non-root, `cap-drop ALL`, `no-new-privileges`, no GitHub token inside; `--egress` (allowlisted CONNECT proxy on an internal network) and `--llm-proxy` (model key stays in a sidecar, the sandbox gets a per-run nonce) and an opt-in read-only rootfs (`TASKCELL_SANDBOX_READONLY=1`, with an 8192 MB memory default since the tmpfs mounts share the cgroup); copy-back drops CI config; only the host pushes; turn, time and budget limits; a human merges every PR | `--egress` and `--llm-proxy` are opt-in; the cost budget is enforced for Claude and z.ai only; read-only rootfs is opt-in (`TASKCELL_SANDBOX_READONLY=1`), off by default even under `--egress`/`--llm-proxy` |
| Output | secret scan on the diff before push; redaction of logs and published text; review verdict must be explicit; the change must pass the repo's own tests and spec gates, which is how "hallucinated" code is caught | no PII scan (rarely relevant to code changes) |

## Next

1. Grow the corpus from the weekly drafts to about 100 curated cases, balanced across control, edge and refusal.
2. Calibrate the eval judge on 20-30 human-labelled verdicts.

## Reviewer benchmark (AACR-Bench)

`pnpm eval -- --reviewer-bench --bench-models codex/gpt-6-sol,claude/claude-opus-5-5 [--bench-sample 25] [--bench-dataset <file|url>]`
runs the PR reviewer (the `review-pr` agent path, read-only, never posting) over a deterministic sample of
AACR-Bench (`data/v2`) PRs and prints precision, recall, F1, blocking vs non-blocking matches, tokens, cost and
wall time per model, with the dataset version and content hash. The reviewer runs in an empty scratch git repo,
so it sees only the diff, not this checkout or its review rules. Findings match an annotated issue when they cite
the same file within 5 lines; same-file near misses go to a judge (`--judge-model`).

**Status: the first Codex gpt-6-sol vs Claude Opus 5.5 comparison has not been run.** It needs provider
credentials, network access and subscription usage that the implementing sandbox did not have; a maintainer runs
the command above on the default sample and attaches the report to the PR. The dataset file name and field
names are unverified against the live dataset: check `parseAacrDataset` on the first real run.
