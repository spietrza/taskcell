# CLI reference

Detailed reference for the `taskcell` CLI: models, providers, decision models, one-shot commands, fork-and-select, the sandbox image, and cost. Run `taskcell --help` for the full flag list.

## Models

Choose the model per stage with `model` (`'opus'`, `'sonnet'`, `'haiku'`, or a full id), and reasoning depth with `effort`. Two presets:

- `fastStages()` - a single low-effort `haiku` pass: cheap and quick, still on the subscription via the CLI.
- `planImplementReviewStages()` - plan on `opus` (high effort, emits a `<plan>`), then implement and review on `sonnet`. The capable model plans; the cheaper one executes.

Runs reuse the session and keep a stable prompt prefix to maximize Anthropic prompt caching; `RunResult.cacheEfficiency` reports the cached fraction of input tokens.

The canonical pipeline is implement → review → simplify. The reviewer reviews for correctness **and** over-engineering (the ponytail minimalism lens — would less code do the job?), so the third simplify pass is often redundant. Pass `--no-simplify` (on `run`/`watch`) for a lean implement → review run that skips it.

An optional **conformance pass** can be appended after the reviewer with `--conformance` (on `run`/`watch`; opt-in, default off, GitHub/Linear only). It runs a fresh, report-only stage that checks the final diff against the spec's Acceptance Criteria for unmet criteria, scope drift, and silently dropped requirements; its findings post to the PR and gate the merge alongside the reviewer's. It is report-only — it never edits files (`copyBack:false`). `--conformance-model <m>` sets the model for that stage; it defaults to the implementer/`--provider-model` model, so **pass `--conformance-model opus` to run the check on a planner-tier model** (the headline use case).

### The spec manifest and the deterministic conformance gate

Separate from (and always on, unlike) that model-driven pass, every run checks the final diff against the spec's `<spec_manifest>` JSON block — a deterministic gate, read only from a trusted spec author (see [comment-trust-pr-notes.md](comment-trust-pr-notes.md)). A gap resumes the implementer's own session with the gap report; if it is still red when the repair cap runs out, the PR declares `Part of #N` with a scope checklist instead of `Closes #N`. A legacy spec with no manifest stays advisory-only — it always passes.

Entry kinds: `files` (a path the diff must touch — **a doc under `docs/` is a plain `files` entry, exactly like code**), `tests` (a test id plus the file it belongs in, which must gain real test content), `acceptance` (a criterion, with an `artifact` path when it defines a pre-change file such as a golden baseline), `dependencies` (producer/consumer pairs, so a consumer never ships without its producer), and `prBody` (below). Each entry takes `required: false` to make it advisory: it is then tracked as an optional gap and never fails the gate.

**Mapping rule.** Every item under the issue's `## Acceptance criteria` heading, and every numbered scope item that names a file or doc, maps onto exactly one manifest entry. An item that genuinely fits none of the kinds is still listed as an `acceptance` entry noting why it is unmappable — an acceptance-criteria or scope item is never dropped silently, which is what makes the gate catch a missing docs change as readily as a missing code change.

**`prBody` entries** cover an obligation the diff cannot carry at all — CI workflow YAML is the standard case, since copy-back drops those paths (see [CLAUDE.md](../CLAUDE.md)) — and so must reach the PR description for a human to apply by hand. `contains` is the exact text that must be supplied (a fenced `yaml` block, or a named heading); a blank `contains` never counts as satisfied. It is matched only against human-authored text, never the composed body, whose boilerplate, diff excerpts and checklist could otherwise satisfy it. The factory has no channel to write that text, so a missing required item is partial scope like any other gap: `Part of #N`, a draft PR, an unchecked checklist line, and a delimited **Required PR-body item missing** block for the human to paste the content into. Revise rounds carry that block forward verbatim, pasted content included. The pre-delivery repair loop skips the `prBody` half of the check, since the implementer cannot act on it.

By default `run` uses the implement → review → simplify pipeline (the implementer plans inline). Pass `--plan` to prepend a dedicated planning stage (opus, high effort) that emits a `<plan>` for the implementer to follow — the plan → implement → review pipeline. Combine with `--review-model opus` to also review on the planner-tier model:

```bash
taskcell run --github o/r#1 --plan --review-model opus   # plan on opus, implement on sonnet, review on opus
```

## Providers

The agent behind each stage is a swappable `AgentProvider`: `claude` (Claude Code CLI, default), `codex` (OpenAI Codex CLI), `cursor` (Cursor CLI; see [CURSOR-provider.md](CURSOR-provider.md)), `zai` (z.ai GLM Coding Plan), `openrouter` (OpenRouter's Anthropic skin), or `meridian` (self-hosted [Meridian](https://github.com/rynfar/meridian) proxy — share a Claude Max subscription from another host; see [MERIDIAN-provider.md](MERIDIAN-provider.md)). Selection is **by provider, not by model** — each provider runs on its own default model. Two modes:

**One provider does everything** (default)

```bash
taskcell run --linear TES-1                 # Claude implements + reviews + simplifies
taskcell run --linear TES-1 --provider codex # Codex runs every stage
taskcell run --linear TES-1 --provider zai   # z.ai GLM runs every stage (ZAI_API_KEY)
```

**Cross-provider review** (opt-in) — the implementer stays on the main provider while only the review stage runs on an independent one, so a different model family catches different classes of bugs:

```bash
taskcell run    --linear TES-1 --provider claude --review-provider codex
taskcell watch  --label vanguard --provider codex --review-provider claude
```

**Per-stage model** (independent of provider) — `--provider-model <m>` sets the model for the implementer/simplifier stages and `--review-model <m>` for the review stage; each defaults to the provider's own default model. A bare alias (`sonnet`, `opus`, `haiku`) floats to the newest generation the credential serves, so the implementer upgrades itself on release day; a full id (`claude-fable-5-1`) stays pinned, which is what you want wherever the model is a merge gate. `taskcell stats` records both the requested and the served name, so an alias upgrade shows as the new id, while a gateway substituting a different family shows as `served (requested X)`. `--escalate-model <m>` is **reactive escalation**: the first gate repair (conformance/verify/incomplete) resumes on the implementer model; if the gate is still red, the second and later repairs resume the same session on the escalation model. Nothing is predicted up front — the cheap model only gets replaced once it has demonstrably failed. The one up-front call is yours: label an issue `vanguard:model=<m>` (e.g. `vanguard:model=claude-fable-5`) and that task runs exactly as if `--provider-model <m>` had been passed for it — the reviewer keeps `--review-model` (a cross-provider reviewer is untouched), conformance keeps `--conformance-model`, and `--escalate-model` steps aside since the label already is the escalation. It is a plain label with one colon (case-sensitive; not a GitLab scoped label), read once at run start; anyone who can label the issue can pick its model, and the per-stage budget caps still apply. Works on GitHub, GitLab and Linear (labels fetched over GraphQL). On `--provider cursor` the model values are Cursor's own: an Auto mode (`auto-intelligence`, `auto-balance`, `auto-cost`) or a Cursor id from `agent models`. The Claude aliases map onto the matching Auto mode. See [CURSOR-provider.md](CURSOR-provider.md#choosing-a-model).

```bash
taskcell run --linear TES-1 --provider-model opus --review-model haiku   # plan/implement big, review cheap
taskcell run --linear TES-1 --provider-model sonnet --conformance --conformance-model opus   # implement on sonnet, check conformance on opus
taskcell run --linear TES-1 --provider-model sonnet --review-model claude-fable-5-1 --escalate-model claude-fable-5-1   # cheap implement on the current Sonnet; a 2nd failed gate repair escalates to a pinned top model
taskcell run --github o/r#1 --commit-author "Your Name <you@example.com>"   # commit authored as you
```

`--provider` / `--review-provider` / `--provider-model` / `--review-model` work the same on `run` and `watch`. The simplifier stays on the main provider. Each non-Claude provider brings its own key, forwarded into the sandbox **only when that provider is selected**: `CODEX_API_KEY` for codex, `CURSOR_API_KEY` for cursor, `ZAI_API_KEY` for zai (a missing key fails fast at dispatch, not mid-run). Under `--llm-proxy` the Codex/OpenAI key **and** the z.ai key are held by a trusted sidecar instead of the sandbox (see [Host LLM proxy](security/boundaries.md#host-llm-proxy)); Cursor's key is still injected directly (not yet proxied). Claude auth is the baseline (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), but a run whose providers are all Codex/Cursor consumes none of it, so `watch-prs --provider codex` needs no Anthropic credential in direct mode; `--llm-proxy` still needs one for the primary sidecar. The sandbox image ships the `claude` and `codex` CLIs; the Cursor CLI is opt-in (`CURSOR_CLI_VERSION=<version> ./docker/build.sh`), and cursor reports tokens but no cost, so budget caps do not bind it — see [CURSOR-provider.md](CURSOR-provider.md).

Codex does not read its key straight from the environment: `CodexProvider` runs `codex login --with-api-key` (the key piped from `OPENAI_API_KEY` inside the sandbox, never on the command line) before `codex exec`. Under `--llm-proxy` Codex is instead configured (via `~/.codex/config.toml`) to use a custom OpenAI-compatible provider pointed at the trusted sidecar, reading only the per-run nonce from `OPENAI_API_KEY` (no `codex login`, and the real key never enters the sandbox). Either way, the OpenAI account behind the key must have active billing — without it `codex exec` connects and authenticates but the API returns "account is not active", which surfaces as a failed review stage.

**Codex on a ChatGPT subscription (no API key).** Set `CODEX_AUTH_JSON` to the contents of a `~/.codex/auth.json` produced by `codex login` on a ChatGPT Plus/Pro account (`auth_mode: chatgpt`, OAuth tokens, no API key). In direct mode the runner forwards it verbatim into the sandbox, where `CodexProvider` writes it to `~/.codex/auth.json` (0600) and skips login — `codex exec` then runs on the subscription and self-refreshes the access token via the embedded refresh token. Under `--llm-proxy` the credential instead stays on the host in a ChatGPT sidecar and the sandbox gets a **placeholder** `auth.json` (the per-run nonce as `access_token`, a run-bound refresh placeholder, a synthetic `id_token`) plus a base URL and refresh/revoke overrides pointed at that sidecar — the real OAuth tokens never enter the sandbox (see [Host LLM proxy](security/boundaries.md#host-llm-proxy)). Either way `CODEX_AUTH_JSON` takes precedence over `CODEX_API_KEY`/`OPENAI_API_KEY` when both are set. Solid for local and long-running host use; on ephemeral CI the stored token must carry a valid refresh token, and an API key is the sturdier choice there. Example: `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)" taskcell run --linear TES-1 --provider codex`.

**Custom OpenAI-compatible endpoint.** To run Codex against any endpoint that speaks the OpenAI **Responses** API (a self-hosted vLLM, OpenRouter, Together, a gateway, …) instead of `api.openai.com`, set `OPENAI_BASE_URL` on the host. The runner forwards it into the sandbox as `VANGUARD_OPENAI_BASE_URL`, and `CodexProvider` writes a `~/.codex/config.toml` provider pointed at it (`wire_api = "responses"`), sending your key from `OPENAI_API_KEY`/`CODEX_API_KEY` as the bearer token:

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1   # must include the /v1 path (OpenRouter's Responses API is in beta)
export OPENAI_API_KEY=sk-...                           # the key your endpoint expects
taskcell run --linear TES-1 --provider codex --provider-model <model-the-endpoint-serves>
```

Constraints: (1) the endpoint must implement the OpenAI **Responses** API (`/v1/responses`) — Codex no longer speaks `/chat/completions`; (2) this is **direct mode only** — it is ignored under `--llm-proxy`, whose sidecar always targets `api.openai.com` (point the sidecar elsewhere by changing the proxy upstream, not this var); (3) with `--egress` the endpoint's host must be in the allowlist, otherwise run without `--egress` so the sandbox can reach it directly. `CODEX_AUTH_JSON` (subscription) takes precedence — set `OPENAI_BASE_URL` only in the API-key path.

**z.ai (GLM Coding Plan).** `--provider zai` reuses the in-sandbox Claude Code CLI, pointed at z.ai's Anthropic-Messages-compatible coding endpoint (`https://api.z.ai/api/coding/paas/v4`) with the GLM model family (default `glm-5.2`). It needs **no Anthropic token** — set `ZAI_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the z.ai key is held by the primary trusted sidecar (forwarding to `api.z.ai` as a bearer key) and the sandbox gets only the per-run nonce. (z.ai's endpoint is OpenAI-compatible too, but the Codex CLI dropped `wire_api = "chat"` support, so the Claude-CLI route is the supported one.)

**OpenRouter.** `--provider openrouter` follows the same pattern as z.ai, pointed at OpenRouter's Anthropic-Messages-compatible "skin" (`https://openrouter.ai/api`) with a dotted OpenRouter slug as the model (default `anthropic/claude-sonnet-4.6`; override with `--provider-model`). It needs **no Anthropic token** — set `OPENROUTER_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the OpenRouter key is held by the primary trusted sidecar (forwarding to `openrouter.ai` as a bearer key) and the sandbox gets only the per-run nonce. **Recommended:** in your OpenRouter account, pin **Anthropic 1P** as the top-priority provider for Claude models — the Claude Code CLI expects Anthropic-1P behaviour, and this is an account-level provider-selection preference, not something the run can set per-request.

## Decision models

**Decision model vs LLM judge — what Clef is and is not.** A decision model (Cloudflare [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), Typesafe Jev — the second only through a Typesafe or self-hosted endpoint via `VANGUARD_DECISION_URL`) does not replace Haiku, Sonnet or any generating model: it cannot write code, a review or a sentence. It answers typed questions (yes/no, pick one, rate on a rubric) with a calibrated probability per option, in one forward pass. It overlaps with an LLM only where Taskcell asks for a *decision* — the eval judge, the fork scorer, the difficulty probe — and nowhere else. Side by side, for those roles:

| | LLM judge (Haiku default, any `--judge-model`) | Decision model (`clef-flash` / `clef`) |
|---|---|---|
| Output | Markdown with a `<verdict>{passed, score, reason}</verdict>` JSON blob that must parse | A probability per allowed answer; nothing to parse |
| `score` means | The model's self-rated 0..1 quality | P(acceptable); `passed` = P ≥ 0.5 |
| Calibration | Not calibrated; "0.8" is a feeling | Trained for calibrated probabilities (vendor claim; not yet measured on this corpus) |
| Latency per decision | Seconds (a one-shot agent run) | ~40 ms (`clef-flash`) to ~200 ms (`clef`) on Workers AI, vendor-measured |
| Cost per decision | Full LLM tokens, incl. the reasoning it writes | $0.09 / M input tokens, no output tokens |
| Context | Model-dependent (hundreds of K) | 64K tokens on Workers AI; 16K on a self-hosted `vllm-jev` |
| Can explain itself | Yes, the `reason` field is prose | No; the reason is just the numbers |
| Can do the task itself | Yes (it is the same kind of model as the implementer) | No |
| Where it leaves the host | Through the sandbox / `--llm-proxy` / `--egress` | Host-side HTTP to the endpoint; white-label runs need `VANGUARD_DECISION_PROBE=all` |
| Verified in this repo | Yes, the default path | Live on Workers AI since 2026-10-07 (probe, `eval --judge-model clef-flash`, `--fork-scorer decision`) |

To compare them on the corpus, run `taskcell eval --json` twice (default judge, then `--judge-model clef-flash`) and diff the pass rates per kind — that, not the vendor table, is the number that would justify switching the default.

**Difficulty probe (experimental, log-only).** Decision models answer typed questions with calibrated probabilities in milliseconds instead of generating text; Taskcell talks to them through one client speaking the System One API. Two are known to it: Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) — the one in use, on Workers AI's free tier — and Typesafe's Jev, which Cloudflare does not host and which has not been exercised here. Opt in with `VANGUARD_DECISION_PROBE=1` plus credentials: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AUTH_TOKEN` (Workers AI; `VANGUARD_DECISION_MODEL` is `clef`, the default, or `clef-flash`), or `VANGUARD_DECISION_URL` [+ `VANGUARD_DECISION_TOKEN`] pointing at any System-One-compatible endpoint, which is also the only way to run `jev` (a Typesafe endpoint or a self-hosted `vllm-jev`). The probe uses one model and one endpoint per run — `VANGUARD_DECISION_MODEL` picks it, there is no ensemble (`eval --judge-model` and `--fork-scorer` take their own model argument, which overrides it). The credentials alone do nothing — they are Cloudflare's generic variable names. While the sandbox is being provisioned, each run asks: will the first attempt pass the gate, how hard is this (Trivial…Research-grade, x.5 rounds up), is the spec clear? The answer is logged (`decision_probe` line in `metrics.jsonl`, one console line) and **changes nothing** about routing. After enough runs, `taskcell stats` prints a `PROBE` table of predicted vs observed first-try rate per predicted level, one pair per run — if they track, the probe earns the right to set `vanguard:model=` automatically; if not, unset the switch. A failing probe warns once and the run proceeds; it can never fail because of it. **What leaves the host:** the task title, labels, description and comments (including a posted or `--spec-file` tech spec) go from the host process to the endpoint — outside the sandbox, `--egress` and `--llm-proxy`. White-label runs (client repos, `--commit-author`) are therefore skipped unless you set `VANGUARD_DECISION_PROBE=all`.

**What switching the decision model on gives you.** Nothing in the implement/review path changes — the implementer, reviewer and escalation keep running exactly as before. What you get:

- **A difficulty signal before every run, for free.** Three calibrated probabilities (first attempt passes the gate, difficulty level, spec clarity) logged next to the run. Today it only observes; once `taskcell stats`' `PROBE` table shows the prediction tracking the observed repair rate, it can start setting `vanguard:model=` automatically — the predictive routing that is deliberately not built on guesswork.
- **A judge that is fast, cheap and parse-free.** `taskcell eval --judge-model clef-flash` returns a probability per case in ~0.5 s instead of an LLM writing a `<verdict>` JSON blob that has to parse; the pass threshold is `P(acceptable) ≥ 0.5`, not a model's self-rating. Run the corpus twice (default judge, then clef) and diff the pass rates — that comparison is the point.
- **A fork scorer that compares like with like.** `run --fork n --fork-scorer decision` picks the variant with the highest `P(acceptable)`; the diff's completion state and file list are in the question, and an empty or unfinished diff scores near zero.
- **A second opinion where parsing used to fail.** Every decision above used to be a generated string parsed by regex or Zod; a decision model cannot produce a malformed answer, only a probability you can threshold.

What it does not give you: text. It cannot write code, a review, or explain its number; it cannot replace Sonnet, Opus, Fable or Haiku anywhere they generate.

**Decision model quick start (Cloudflare Workers AI, free tier).** Workers AI includes 10,000 Neurons a day at no charge; `clef`, the default, costs 21,818 Neurons per million input tokens, so a factory probe (~7–8k tokens of issue and spec) uses ~165 Neurons — about 60 runs a day for free. `clef-flash` is ~6× cheaper (3,455 Neurons per million) but, replayed on 11 factory probes, was markedly overconfident (Brier 0.16 vs 0.05 for `clef`); pick it with `VANGUARD_DECISION_MODEL=clef-flash` when volume outgrows the free tier.

1. In the Cloudflare dashboard create an API token from the **Workers AI** template (Account → Workers AI → **Read** is enough; drop the Edit row) and copy your **Account ID** from the account's overview sidebar.
2. Export the credentials outside any dotfiles repo (Taskcell reads the process environment, not `.env`), and switch the probe on:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=…   # 32 hex chars
   export CLOUDFLARE_AUTH_TOKEN=…   # the token, shown once
   export VANGUARD_DECISION_PROBE=1
   ```
   For the GitHub Actions factory, add the same two values as repository secrets, pass them to the reusable workflow under `secrets:`, and set `decision-probe: true` on the caller (off by default, see [onboarding](onboarding-another-repo.md)).
3. Run anything. The probe logs one line per run and `taskcell stats` grows a `PROBE` table; `taskcell eval --judge-model clef-flash` and `run --fork 3 --fork-scorer decision` use the same credentials.

What a live call looks like (recorded 2026-10-07, `clef-flash`, 485 input tokens, 518 ms):

```
vanguard: spietrza/taskcell#999 difficulty probe (clef-flash, 518ms): first-try 0.58, difficulty 1.59/4, spec clear 0.79
```

and the judge on a refusal case: an output that charges ahead scores `P(acceptable)=0.11`; one that merely sounds careful but does not do what the expectation names scores `0.48` — the judge reads the expectation, not the tone. The fork scorer gives a small, tested diff `0.91` and an empty diff `0.03`.

## Evals and the baseline gate

`taskcell eval` runs the committed corpus (`src/evals/corpus`, 30 cases: control, edge, refusal) and prints a per-kind pass-rate report. Each case makes two host-side `claude --print` calls — one on the model under test (`--produce-model`, default `claude-sonnet-5-5`) and one on the judge (`--judge-model`, default a Haiku model, or a [decision model](#decision-models)). There is no sandbox and no git write unless you ask for one. The calls run with every tool off and a system prompt telling the model it has none, so it answers in plain text. A call with no answer after 2 minutes is retried, up to 3 attempts; nothing but a timeout is retried. Progress goes to stderr, one `eval <n>/<total>: <case id>` line per case, so `--json` output on stdout stays clean and a hung case is named in the CI log.

```bash
taskcell eval                                   # report only
taskcell eval --json > baseline.json            # machine-readable: EvalRunReport (judgeModel, produceModel, corpusHash, per-case verdicts)
taskcell eval --baseline baseline.json          # gate this run against that file
taskcell eval --baseline main                   # gate against the latest baseline on the metrics branch
taskcell eval --save-baseline                   # publish this run as the baseline for the current commit
```

**What the gate fails on.** `--baseline` compares the run against a saved `EvalRunReport` and exits non-zero on any of three conditions, all checked and reported together (never short-circuited), followed by a table naming every case that flipped verdict in either direction:

- **Pass-rate drop** — the overall pass rate fell by more than `--max-drop` points (default **5**). The judge is non-deterministic and the CLI exposes no temperature, so run the suite 3× on a known-good state to measure variance before tightening this.
- **Refusal regression** — a `refusal`-kind case that passed in the baseline now fails. Never tolerated, whatever `--max-drop` says: a safety case that stopped refusing is a regression even when the overall rate is flat.
- **Corpus-hash mismatch** — `corpusHash` (a stable, order-independent hash of every case's id, kind, input, expectation and variables) differs from the baseline's, so the two runs did not answer the same questions and the pass rates are not comparable. Editing or adding a case changes it; reordering the corpus files does not. The fix is normally to save a new baseline, not to compare across the change — pass `--allow-corpus-change` to compare anyway (useful to see which old cases flipped while a new one is being added).

`--save-baseline` pushes the run's report to the `taskcell-metrics` branch (`eval-baselines.jsonl`, one record per commit, same mechanism as `metrics push`; `--branch` overrides the branch). A second save for the same commit is a no-op — the first push wins. With both flags, the comparison runs **before** the save, so `--baseline main --save-baseline` gates against main's existing record rather than against the run it is about to publish.

**Cost per run.** 60 short calls: the corpus prompts are one or two sentences each and the judge sees one case plus one output, so a whole run is tens of thousands of tokens, and the cases run serially (a few minutes of wall clock). Billing follows the credential the host `claude` CLI uses: on a subscription (`CLAUDE_CODE_OAUTH_TOKEN`) it is plan usage with no per-token charge; on an API key it is a few cents at Haiku ($1/$5 per MTok) and Sonnet rates. `--judge-model clef-flash` makes the judge half of that essentially free (see [Decision models](#decision-models)).

### In CI

`.github/workflows/eval.yml` runs two jobs:

- **gate** (`eval --baseline main`): a PR's own code runs with a model credential in env, so it never starts by itself. A maintainer reads the diff and adds the `run eval` label; after new commits the label is added again. Fork PRs are skipped.
- **baseline**: every push to main that touches `src/context|evals|agents|pipeline/**` publishes a new baseline to the metrics branch. The eval runs with a read-only token; a second job that runs no install, build or model appends the report to `eval-baselines.jsonl` (same record and per-commit dedup as `eval --save-baseline`). Run it once by hand (`workflow_dispatch` on main) to seed the first baseline.

Two notes on the credential. `--llm-proxy` does not apply here: it keeps a model key out of the **sandbox**, and `eval` runs no sandbox — it shells out to the host `claude` CLI, which reads `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from the environment, so the job's `env:` block is the whole credential path. And the gate job runs PR-authored code on the `pull_request` trigger (never `pull_request_target`) with a read-only `GITHUB_TOKEN`, but with the model credential in env — which is why a maintainer's label, not every push, starts it.

A first run on a repo with no baseline yet exits non-zero with `no baseline found` — land the `baseline` job (or run `taskcell eval --save-baseline` once from main) before turning the gate on.

## One-shot commands and white-label mode

The commit is authored `Vanguard <vanguard@local>` by default; override with `--commit-author "Name <email>"` (git's standard form) to attribute the work to yourself. The PR itself is opened by whichever account owns the push token (`VANGUARD_PUSH_TOKEN`/`GH_TOKEN`), independent of the commit author.

**White-label mode.** Passing `--commit-author` also switches Taskcell to deliver a plain, human-looking PR — the Taskcell branding (some of it, such as the `## Vanguard Review` heading and the default commit author, still uses the old name) is dropped everywhere it would reach the remote:

- Branch becomes `feat/<issue-number>-<hash>` (e.g. `feat/904-9d414a3d`) instead of `chore/vanguard-…`.
- The PR body is just the `Closes #N` / `Part of #N` line — no "Automated implementation … by Taskcell" attribution and no `## Proof of work` block.
- No Taskcell review comment is posted on the PR, and no "opened a PR" comment is posted back on the issue.
- The commit message is Conventional-Commits-safe — `feat: <lower-case subject> (#N)`, header ≤100 chars — so a target repo's `commitlint` passes.

`taskcell research` honours the same switch: with `--commit-author` its comment heading drops "Vanguard" (`## Research` instead of `## Vanguard Research`) and uses a neutral hidden marker — the author value is unused there since research never commits.

**One-shot spec pass.** `taskcell spec <owner/repo#n> --repo <path> [--spec-model <m>] [--commit-author <a>]` runs the same tech-spec generator the watch loop uses (`techSpecStage`: read-only codebase research, `<tech_spec>` output) as a single CLI step — **no labels are read or written**. The spec is posted as an issue comment; `--commit-author` white-labels the heading (`Tech spec:` instead of `Taskcell tech spec:`). Recognition is keyed on the `<tech_spec>` tag, so triage and the conformance manifest treat both headings identically. Pair it with `taskcell run` on the same issue once the spec looks right — e.g. spec on a planner-tier model, then implement on a cheaper one (`--provider-model`) with the review pinned back on the planner tier (`--review-model`).

**Fully local spec (no tracker trace).** Add `--out <file>` to `taskcell spec` to write the spec to a local file instead of posting any comment, then feed it back with `taskcell run … --spec-file <file>`: the file is injected into the fetched task as a virtual comment, so the implementer prompt, triage, and the conformance manifest read it exactly like a posted spec — but the only public artifact of the whole pipeline is the PR itself. `--spec-file` is single-issue only (rejected with `--parent`/`--project` fan-out); make sure `.taskcell/` is gitignored in the target repo so the spec never rides along in a commit.

**Standalone PR review — to the tracker or to a file.** `taskcell review-pr <owner/repo#n> --repo <path> [--review-model <m>]` reviews an existing PR (an adversarial pass, larger budget on retry) and posts the verdict as a PR comment. Add `--out <file>` to write the review to a local file and post **nothing** to the PR — the same no-trace escape hatch as `spec --out`, for reviewing client PRs without leaving an automation comment.

The `review-pr` and `review-mr` commands read code from the change's real base branch and repository instruction files and skills from the repository's default branch. Default-branch guidance applies even when a release branch carries different review rules; an unavailable default branch fails the review.

**Address human review feedback.** `taskcell revise-pr <owner/repo#n> --repo <path> [--review-model <m>] [--max-rounds <n>]` reads the human review threads + comments on a bot PR, applies fixes, pushes to the PR branch, and replies to + resolves each addressed thread. It treats every non-bot commenter's feedback as a change request, whatever their role on the repository, so run it only where the people who can comment are trusted; on a public repository, anyone can. Pass `--fallback-provider <name>` to retry primary-provider stages once on a different transport after an agent failure, and `--fallback-model <model>` to select its model (otherwise its default). If a provider rate limit ends the run, the PR receives a notice explaining how to retry by removing and re-applying `needs revision`. Unlike `review-pr` (which *produces* a review), `revise-pr` *consumes* one. On a client repo pass `--commit-author "Name <email>"` — it authors the revision commits as that identity and drops the "vanguard" token from the hidden revision marker, so the whole exchange looks human. Prefer to inspect before anything touches the PR? `--out <file>` runs it as a **dry-run**: it applies the fixes and writes the diff + the reply it would post to each thread into the file, pushing and commenting **nothing** — review it, then re-run without `--out` to apply.

The quality pipeline (reviewer, conformance, verification) still runs and still gates the `Closes`-vs-`Part of` decision — only the *surfacing* is suppressed. Default (no `--commit-author`) keeps the full branding and review comment. Note the white-label branch has no unique marker, so `gc` won't auto-reap it — enable "auto-delete branch on merge" on the repo instead.

**Base branch.** By default Taskcell branches off `main` and targets the PR at `main`. Pass `--base <branch>` (e.g. `--base dev`) to branch off and open the PR against a different base — the diff is then computed against, and the PR merges into, that branch.

## Growing the eval corpus

`taskcell eval --suggest` drafts candidate cases; it never writes into `src/evals/corpus/`. A human picks the good ones and commits them by hand.

```bash
taskcell eval --suggest                                              # from retrospective memory (failed runs, reviewer notes)
taskcell eval --suggest --github-repo owner/repo --since 2026-11-03  # plus human-rejected factory work on GitHub
taskcell eval --suggest --github-repo owner/repo --out drafts.md     # also write the drafts to a scratch file
```

With `--github-repo` it reads three signals of "a human rejected this", factory branches only:

- **closed without merge**: the PR's last comment becomes the reason;
- **`needs-human-review`**: the revision cap was hit; the last review becomes the reason;
- **reverted on the default branch**: a `Revert` commit whose target came from a factory PR.

Titles, comments and commit messages are untrusted: secrets are redacted, `<`/`>` escaped and `@mentions` defused, so the Markdown can be pasted into an issue without pinging anyone. If one source fails (gh not logged in, rate limit) the command warns on stderr and keeps the others; if every source fails it exits non-zero, so a scheduled job never reports "nothing rejected" by mistake.

**Curating.** Aim for about 100 cases, kept roughly balanced across `control` (an ordinary task that must succeed), `edge` (a boundary case) and `refusal` (the factory must decline). `refusal` is never guessed from GitHub; write those by hand. For each draft keep one sentence of input and one checkable expectation, drop anything that only restates an existing case, then add it to the corpus file in a normal PR. Editing the corpus changes its hash, so save a new eval baseline after the merge.

`.github/workflows/eval-suggest.yml` runs this every Monday (or by hand) and opens an issue with the drafts for curation.

## Fork-and-select

`run --fork <n>` runs the implementer stage `n` times (each variant forks the same base, on a worktree reset between runs), scores each variant's diff, and keeps the best one before the review/simplify stages continue. Scoring is an LLM verdict produced by a one-shot run of the same provider in a throwaway `/tmp` cwd (the diff is supplied in the prompt, so the scorer never touches the worktree) — or, with `--fork-scorer decision`, a [decision model](#decision-models) (`clef-flash` on Workers AI or any System-One endpoint): `P(acceptable)` for each diff in ~100 ms, a calibrated probability instead of a model's self-rated JSON, with no verdict parsing to fail. The diff leaves the host for that call (outside the sandbox, `--egress` and `--llm-proxy`); on a white-label run (`--commit-author`) that is the client's diff, so it needs the same consent as the difficulty probe: `VANGUARD_DECISION_PROBE=all`. Credentials and consent are checked once at start-up, before any issue is claimed. Use it to trade tokens for quality on hard tasks:

```bash
taskcell run --linear TES-1 --fork 3
```

## Keeping the sandbox image current

`docker/Dockerfile` pins the Claude CLI that ships inside `vanguard-sandbox:latest`. The pin moves with the repo; a built image does not. A stale CLI does not fail loudly — it fails *mid-run*, against the model gateway, after the sandbox is up and the prompt is rendered. One such drift answered every request with `API Error: 400 This session advanced while the request was waiting`, which reads like a gateway or session bug and is neither.

So every sandbox start reads `claude --version` out of the container and refuses to continue when it predates the pin. `taskcell doctor` reports the same thing as a `sandbox claude cli` check.

To repair it:

```bash
taskcell doctor --fix
```

This installs the pinned CLI into the existing image and re-runs the checks. It does **not** rebuild — a rebuild also re-downloads the linear-cli release tarball, which is exactly what a corporate MITM proxy breaks, and updating the CLI alone goes through a plain npm install. The original `USER` and `WORKDIR` are read from the image and restored, because `docker commit` snapshots the *container's* config: commit a root container without restoring them and the image starts running as root, at which point the CLI refuses to launch at all.

A full rebuild still works where the network allows it:

```bash
CLAUDE_CLI_VERSION=2.1.322 ./docker/build.sh
```

The check is deliberately **not** an auto-update. Refreshing an image needs the network at run start and rewrites an image that concurrent sandboxes share — on the machines where this drift actually bites, the build is itself the unreliable step, so doing it automatically would turn a rare manual command into a recurring mid-run failure. `VANGUARD_SKIP_IMAGE_CHECK=1` bypasses the gate if you are deliberately running an older image.

`VANGUARD_SANDBOX_IMAGE` overrides the image name used everywhere the sandbox runs (main sandbox, preflight, and the llm-proxy/egress sidecars) — set it to an image ID (`sha256:...`) in CI so a job pins the exact image it just built instead of the mutable `vanguard-sandbox:latest` tag, which another pipeline on a shared Docker host could overwrite between build and run.

## Cost and limits

Two cost dimensions: **GitHub Actions minutes** (only when you run via Actions) and **model usage**.

**GitHub Actions minutes.** A run builds Taskcell + the sandbox image, then runs the pipeline — about **15-20 minutes per run** on `ubuntu-latest`.
- **Public repos: unlimited.** GitHub bills no Actions minutes for public repositories, so the Actions path has no minute ceiling there.
- **Private repos: 2000 min/month** on the Free plan (then paid). At ~15-20 min/run that is roughly **100-130 runs/month**.
- **Avoid Actions minutes entirely:** run an always-on `taskcell watch` on your own hardware (any Docker host — see [deploy.md](deploy.md)). It uses **zero** GitHub minutes, polls Linear or GitHub itself, and is the right home for a private-repo factory or heavy use. The Linear path has no Actions option anyway and always runs on a host.
- **Cut per-run minutes** (private-repo Actions): the biggest slice is rebuilding the sandbox image every run — prebuild it and push to GHCR as `ghcr.io/spietrza/taskcell-sandbox:$(git rev-parse HEAD:docker)` (the git tree hash of `docker/`, so one tag covers every commit that leaves the image inputs alone). `docker/build.sh` then pulls that tag and skips the build (saves ~2-3 min/run); it only tries when `docker/` is committed and clean and no build arg overrides the published default, and falls back to building on any failure. `GHCR_SANDBOX_IMAGE` points it at another registry. Also cache `pnpm` and the build. Keep `runs-on: ubuntu-latest` (1× multiplier; larger runners multiply the minute cost). A single `watch --once` (the default since the spec→build fix) already halved the old double-sweep.

**Model usage.** Billing follows the credential, not the run count: a **subscription** (`CLAUDE_CODE_OAUTH_TOKEN`, or Codex `CODEX_AUTH_JSON`) draws on your plan's usage with no per-token charge; an **API key** bills per token (see [Auth](auth.md)). On a subscription the marginal cost of a run is plan usage + time, not dollars. `taskcell stats` rolls up per-run tokens/cost from `.taskcell/runs/metrics.jsonl`.

**Usage cap (keep a reserve).** If the factory shares your Claude or ChatGPT subscription with your own work, set `--usage-cap <pct>` (`run`, `watch`, `watch-prs`; env `VANGUARD_USAGE_CAP_PCT`; the hub's Settings **Usage cap %** field; 1–100, unset = no cap) — e.g. `80` lets the factory use up to 80% of your 5-hour window and leaves the last 20% to you. Utilization is read from what the provider CLI already reports during a run (Claude Code's `rate_limit_event`, Codex's `rate_limits` in its event stream) — no extra API calls. Before a new task, stage, fork, gate repair or PR review starts, a provider at or over the cap is not started: a GitHub issue or PR (`watch`, `watch-prs`, `revise-pr`) gets `vanguard:rate-limited` with the provider's window reset as `until`, and the comment says "paused at the usage cap (82% of 80%), resumes after <time>" (distinct from a provider 429); `resume-rate-limited` retries it after the reset. Linear, GitLab and GitHub Projects items get the same pause wording (not a failure) but no automatic resume: re-trigger them after the reset. A stage already running always finishes. When utilization is not known yet (no event seen, a provider that does not report it, or a reading with no reset time older than an hour) the cap does not block and one log line says so. Reported values are bounded (0–100%, reset at most 8 days out), since the agent can write to the stream they come from. With `--fallback-provider`, a capped primary falls back only if the fallback is under its own cap.

## Persistent pnpm store (opt-in)

Every sandbox run installs the target repo's dependencies into an empty pnpm store and downloads them all again — twice per run since the base-red check (one install for the baseline, one after implement). The store is lost because pnpm's default `store-dir` lives under `$HOME` inside the container: normally that is the container's own overlay filesystem, which is discarded when the container is removed; with `readOnlyRootfs` on (opt-in with `VANGUARD_SANDBOX_READONLY=1`, **off** by default, including under `--llm-proxy`/`--egress` — see `sandboxSecurityOpts` in `src/sandbox/limits.ts`) the rootfs is read-only and `$HOME`, `/workspace` and `/tmp` are tmpfs. `/workspace` is then a filesystem of its own, so pnpm puts the store at its root, `/workspace/.pnpm-store` (copy-back never brings it out), and the store only ever lives in RAM. Either way nothing survives to the next run. `--pnpm-store` keeps working under a read-only rootfs regardless: `/pnpm-store` is its own mount, not part of the tmpfs rootfs.

**Default sandbox memory.** With `VANGUARD_SANDBOX_MEMORY_MB` unset the cap is `clamp(host RAM / 4, 2048, 4096)` MB, rounded to 256 MB (`hostMemoryDefaultMb` in `src/sandbox/limits.ts`): 4096 on a 16 GB runner, 2048 on a host with 8 GB or less. It is per sandbox, so with `--concurrency` above 1 set `VANGUARD_SANDBOX_MEMORY_MB` so the caps sum to well under the host's RAM. An explicit `VANGUARD_SANDBOX_MEMORY_MB` always wins; the read-only rootfs keeps its own 8192 floor (below). After a failed verify, the run log and the Proof of work block say whether the sandbox's `memory.events` `oom_kill` counter rose during the verify run, i.e. whether it was OOM-killed (the counter is read before and after, as it is cumulative over the container's life).

**Memory under a read-only rootfs.** A tmpfs page is charged to the container's own memory cgroup, so those three mounts share the sandbox's `--memory` with the processes writing into them. Their sizes are therefore derived from the resolved `VANGUARD_SANDBOX_MEMORY_MB` — 3:2:1 over three quarters of it, with the last quarter left for the processes (`readOnlyTmpfsSizesMb` in `src/sandbox/limits.ts`). Because of that, the memory default is **8192 MB when the rootfs is read-only** (the host-aware default above otherwise; `READONLY_SANDBOX_MEMORY_MB`): `/workspace` 3072 MB, `$HOME` 2048 MB, `/tmp` 1024 MB and 2 GB for the processes, so the Docker host needs ~8 GB free per concurrent read-only sandbox (a GitHub-hosted runner has 16 GB; a cgroup bigger than free host RAM bounds nothing). That cost is why the read-only rootfs is opt-in: every `--egress`/`--llm-proxy` run logs one `sandbox:` line saying whether it is on and, when off, how to opt in. `VANGUARD_SANDBOX_READONLY=1` turns it on at any limit — below 8192 the mounts are small enough (e.g. 2048 → `/workspace` 768 MB) that a real `pnpm install` + build is likely to fail with ENOSPC or an OOM kill, and with no limit they fall back to fixed 4g/2g/1g mounts that press on host RAM. A repo that needs more: raise `VANGUARD_SANDBOX_MEMORY_MB` (e.g. `12288` gives `/workspace` 4.5 GB), add `--pnpm-store` so the store lives on its own mount instead of in `/workspace`, or unset `VANGUARD_SANDBOX_READONLY` (or set it to `0`) to put the rootfs back on disk (an empty value counts as unset).

**Init process.** The sandbox starts with `docker run --init`, so an init runs as PID 1 and reaps orphaned children. Without it PID 1 is `sleep infinity`, which never reaps: every orphan a build or test run leaves behind stays a zombie and keeps its slot under `--pids-limit` (default 512, `VANGUARD_SANDBOX_PIDS`) for the life of the container. After a few test-suite runs the limit is full, and the agent CLI dies with `exit 134` (SIGABRT, a thread could not be created) or a spawn fails with `EAGAIN`. Set `VANGUARD_SANDBOX_INIT=0` only on a container runtime that ships no init binary (`docker-init`, or `catatonit` for Podman), where `--init` fails the container start.

`--pnpm-store` (env `VANGUARD_PNPM_STORE=1`; `run` and `watch`; **off by default**) mounts a persistent store at `/pnpm-store` and sets `npm_config_store_dir=/pnpm-store`, so a repeat install skips the network fetch. The store and `node_modules` sit on different filesystems, so pnpm copies files instead of hardlinking them — expected; the gain is no download, not a zero-cost install.

- **One store per target repo, never a shared one.** Locally, on a NAS or on the hub it is a named Docker volume `taskcell-pnpm-store-<hash of the repo>` (keyed on the repo path the run is given). Two repos never see each other's store.
- **Do not persist the store across CI runs yet.** `VANGUARD_PNPM_STORE_DIR=<host dir>` makes the run bind-mount that host directory instead of a named volume, but CI has no safe save point today: `actions/cache` saves in its post step at the end of the job — after the agent has run — and nothing in Taskcell exposes a hook between the baseline install and the agent phase. So on GitHub-hosted runners (fresh every job) the store simply starts empty, and that is the intended state for now.

**Security: store poisoning.** The agent can write to a mounted store. A bad run could change a package's contents in the store, and a later run would install it without any review — pnpm's integrity check reads an index that also lives in the store, so it does not catch this. That is why the option is off by default, why the store is per repo (damage stays inside one repo), and why a persisted store may only ever be **saved from a trusted point** — one that runs before the agent does anything, never after the agent phase. Since CI has no such save point today, do not persist it there at all. If you suspect a store, `docker volume rm taskcell-pnpm-store-<hash>` (or drop the CI cache key) and the next run rebuilds it from the registry.

### Task dependencies (GitHub)

An issue can wait for others. Native "blocked by" relations and body lines count: `Depends on #12`, `Depends on owner/repo#12`, `Depends on https://github.com/owner/repo/issues/12` (comma-separated lists allowed). A dependency is met when closed as completed or its PR is merged. A `Start: YYYY-MM-DD` line keeps the issue waiting until that date (UTC).

`watch` (sweep and `--issue`) does not start an issue with unmet dependencies: it comments once naming the blockers and swaps the trigger label for `vanguard:waiting`. `resume-rate-limited` (run it on a schedule, e.g. taskcell-resume.yml) re-applies the trigger label once the blockers are done or the date passed; without such a sweep, re-apply the label by hand. A cycle, a missing reference, or a blocker closed as not planned / unmerged ends in `needs info` with the reason. A failed lookup (no access to a cross-repo issue, an API error) parks the issue under `vanguard:waiting` with the reason; the sweep reports it as failed until the lookup works. Issues without dependencies behave as before.
