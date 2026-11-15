# Codex (ChatGPT plan) as reviewer under `--llm-proxy` — smoke test

Proves that Codex on a ChatGPT subscription (`CODEX_AUTH_JSON`) reviews a PR behind `--llm-proxy`, that the real OAuth tokens never enter the sandbox, and that a refresh-token rotation is reported and handed back to the host. See [Host LLM proxy](../security/boundaries.md#host-llm-proxy).

## Prerequisites

- `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"` from a `codex login` on a ChatGPT Plus/Pro account (`auth_mode: chatgpt`), exported on the host.
- No Claude, z.ai or OpenRouter key is needed: with `--provider codex` and no stage on another provider, `--llm-proxy` starts only the Codex (ChatGPT) sidecar. This holds for `review-pr`, `review-mr` and `research`; a stage on Claude, z.ai or OpenRouter would need its own credential, and the run says which provider asks for it.
- Docker with the sandbox image built (`docker image ls taskcell-sandbox` lists `taskcell-sandbox:latest`), `GH_TOKEN`, and an open PR in `OWNER/REPO` that is safe to comment on. In the command below replace `OWNER/REPO#PR` with that PR (e.g. `acme/widgets#42`) and `/path/to/clone` with a local clone. `review-pr` takes the provider from `--provider`.
- Local run (not CI), so a rotation is written back to `~/.codex/auth.json` (override: `CODEX_AUTH_FILE`).

## Run

```bash
cp ~/.codex/auth.json /tmp/auth.before.json
taskcell review-pr OWNER/REPO#PR --repo /path/to/clone --provider codex --llm-proxy
```

## Expect

- The review stage completes and a review is posted.
- `docker inspect` of the `vg-llm-*` sidecar shows no token; the sandbox's `~/.codex/auth.json` holds only placeholders.
- If the IdP rotated the refresh token, the run log prints `taskcell: the Codex (ChatGPT) refresh token was rotated during this run.` followed by `The rotated tokens were written back to …/auth.json`; only `access_token`, `refresh_token` and `last_refresh` change in `~/.codex/auth.json`, which stays mode 0600 (a symlinked `auth.json` stays a link; its target is updated).
- A refused refresh ends the run with `llm-proxy: ERROR codex the ChatGPT sign-in was refused: the refresh token was already used (another run or a newer sign-in rotated it). Sign in again (codex login) and re-run.` To provoke one, start a second run with the `CODEX_AUTH_JSON` exported before the first run rotated the token.
- `docker logs vg-llm-*` during the run shows only the sidecar's warnings and errors, no per-request lines.

## Recorded run

- **2026-11-15**, Taskcell main `61d4c2cd` (1.16.0 before release), maintainer's Mac, ChatGPT-plan `CODEX_AUTH_JSON`, no Claude/z.ai/OpenRouter key in the environment.
- `review-pr spietrza/taskcell#1065 --provider codex --llm-proxy`: the egress-confined sandbox started, the review stage completed in 12 s (2 turns, model `gpt-6.1-sol`, cost $0 on the plan, estimate $0.015) and a review was posted on #1065.
- No refresh-token rotation occurred: `~/.codex/auth.json` kept the same key names (compared by name only) and mode 0600.
- Not exercised: a rotation write-back and a refused refresh (both still covered only by tests against a fake IdP).
