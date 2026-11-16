## Taskcell Review

Verdict: BLOCKING
Risk: medium — runs with a plain single model are left alone, but anyone who sets a pool or a fallback list can have runs routed wrongly, entries cooled down when they still have quota, and `watch` (the GitHub Actions factory) refused at startup.

I read the diff against this checkout; I did not run anything. One caveat: this checkout's `src/runners/source-adapter.ts` is slightly different from the PR base (the diff context shows `providerEnv`, the checkout has `runCredentialContext`). So the line numbers I cite outside the diff are from this checkout. `src/cli/preflight.ts` and `src/cli/watch.ts` are not touched by the PR.

## Blocking

**1. `watch` refuses a `--fallback-provider` list, and so does the reusable factory workflow** (`src/cli/preflight.ts` `collectProviders` / `secondaryProviders`, `src/cli/watch.ts:37-39`)
- `parseCli` now accepts `--fallback-provider codex,cursor`. It passes the raw string on as `fallbackProvider` and casts it to `ProviderName` (`args.ts`).
- `watch` runs `runPreflight(cmd)` before it claims any work. There, `collectProviders` calls `requiresApiKey('codex,cursor', customs)`, which calls `resolveSpec`. That throws `Unknown provider "codex,cursor"`, the `provider auth` check fails, and `watch` throws `preflightFailed()`.
- `.github/workflows/implement.yml` runs `watch … --once` and passes `fallback-provider` straight through. So the factory cannot use the fallback-chain list that the issue's acceptance criterion and `docs/cli.md` ("on `run` and `watch`") promise.
- The same unsplit string reaches `doctor.ts` `usesCodex` (`.includes('codex')` is false for `'codex,cursor'`) and `auth.ts` `anthropicConsumer`. Only `usedProviderNames` was taught to split the list.
- No test runs preflight or `watch` with a list.

**2. "Skip out-of-quota entries" is only partly implemented** (`source-adapter.ts` catch/finally, `model-pool-routing.ts` `compatibleFallback`)
- **Only one fallback per run.** `routeModelPools` keeps exactly one later candidate as the stage fallback. With `claude/sonnet:3, codex/gpt-5.6-sol:1` plus `--fallback-provider cursor`, if both the pick and codex hit a limit, the run fails even though cursor has quota. The criterion says the run fails "only when every entry and fallback is out".
- **Cool-downs don't survive on GitHub Actions.** Skipping across runs depends on `.taskcell/model-pool-cooldowns.json`, which (as the docs admit) lasts only as long as the job. The rotation hash is stable, so a resumed task picks the same out-of-quota entry again. "Not picked for new runs until its reset" therefore never holds in the factory.
- **The wrong entry gets cooled.** On a limit, the catch block cools `primaryEntry()` (the implementer) and the fallback, whichever stage actually hit the limit:
  - A reviewer-pool or flow-stage-pool entry that hits a limit is never cooled.
  - A reviewer limit cools the implementer's entry instead.
- **Tests stop short of the real path.** `orderCandidates` and `routeModelPools` are tested with an injected `cooling` predicate. Nothing tests the path from a limit in `runSourcedIssue` to a recorded cool-down to the next entry being used.

**3. Healthy entries get cooled with no failure** (`source-adapter.ts` `finally`: `outcomes.some((o) => o.providerName === agents.fallbackAgent?.name)`)
- Any stage whose provider matches the fallback agent's name is treated as "the fallback took over".
- Example: `--provider-model 'claude/sonnet:1, codex/gpt-5.6-sol:1' --review-provider codex`.
  1. A task that rotates to claude gets codex as its fallback. `compatibleFallback` allows this because `validateProviderChoice` permits reviewer == fallback.
  2. The reviewer runs on codex, so its `providerName` is `'codex'`.
  3. The `finally` block cools `claude/sonnet` for an hour, on every such run.
- The same happens when a flow stage is pinned to the fallback's provider.
- This writes false limits into the cool-down file, and the rotation stops following its weights. That is not what the issue asked for (skip only entries that are out of quota).
- Fix: compare against the stage's expected provider (as `stagePicks` does), not just the fallback's name.

## Non-blocking

- **Checks before the run look at the configured choice, not the routed one** (CLI `customEgressHosts`, `assertEgressCompatible`, preflight `llm auth`/`provider auth`, and the primary `--llm-proxy` sidecar's upstream). All of these fail closed, but:
  - A pool entry on a repo custom provider under `--egress` has no allowlisted host.
  - A `zai`/`openrouter` entry picked under `--llm-proxy`, while `--provider` is claude, talks to the Anthropic-upstream sidecar.
  - Preflight never checks keys for pool entries' providers.
  - `hostable()` validates without `proxyMode`, so it can choose a fallback that `selectAgents({proxyMode:true})` then rejects, even when another candidate would have worked.
- **revise-pr gaps** (`revise-pr.ts`):
  - `routing.picks` is thrown away, so revise records carry no `modelPick`/`pick`.
  - A limit during a revise records no cool-down.
  - For Linear tasks, `extractTaskIdFromPrBody` probably finds no reference, so the key falls back to the PR number and the revision can rotate to a different entry than the implement run used.
- **Cool-down writes can race** (`model-pool.ts` `recordCooldown`): concurrent tasks in one `watch` process use the same `${file}.${pid}.tmp` and do an unlocked read-modify-write. Updates get lost, and `rename` failures are swallowed.
- **Changed meaning of some values** (`isPoolSyntax`): a plain value ending in `:<digits>` is now pool syntax. `--escalate-model sonnet:2` is now refused, and an id like `vendor/model:1` is now treated as a pool. This is the PR's stated syntax, so it is listed here rather than as a regression.
- **Pool syntax accepted where it won't work**: `parseCli` checks pool syntax on `--review-model` for every command. `review-pr`, `watch-prs` and `review-mr` then pass the pool string unchanged as the model, and the reviewer call fails.
- **Custom provider names**: `PROVIDER_RE` (`^[a-z]…`) can reject custom provider names that `CUSTOM_NAME_RE` accepts. Worth checking that the two agree.
- **Desktop weight field** (`StageInspector.tsx`): an emptied weight shows `0` but is saved as `1`. Validate or clamp it in the field.

## Acceptance criteria

| Criterion | Status |
|---|---|
| Pool syntax on `--provider-model`/`--review-model`/`--escalate-model` and workflow inputs; a single model unchanged; parser tests | met (flags and pass-through; but the fallback-list part of the workflow path is broken, see #1) |
| Deterministic rotation per task; tests for distribution and stability | met |
| Limit → next pool entry → fallback chain (a list); limit recorded; not picked until reset/cool-down; fail only when all are out; tests for all three steps | **not met** (#1, #2, #3) |
| `taskcell:model=<m>` label beats the pool | met |
| Run record and `taskcell stats` show the model used per stage and why | partly met (implement runs yes; revise-pr records carry no pick) |
| Hub Workflow editor stage panel can set a pool | met |
| `docs/cli.md` and `docs/hub.md` document syntax, rotation, skipping, fallback order and stats | met |
| Out of scope: no predictive router | met |

_Linked issue checked: spietrza/taskcell#1131._

<!-- taskcell-pr-review: 19622f49896cc54c29ed81b3363595b8730e2845 -->

<!-- taskcell-pr-review-run: 19622f49896cc54c29ed81b3363595b8730e2845:43786465629 -->
