# Codex (ChatGPT plan) as reviewer under `--llm-proxy` — smoke test

Proves that Codex on a ChatGPT subscription (`CODEX_AUTH_JSON`) reviews a PR behind `--llm-proxy`, that the real OAuth tokens never enter the sandbox, and that a refresh-token rotation is reported and handed back to the host. See [Host LLM proxy](../security/boundaries.md#host-llm-proxy).

## Prerequisites

- `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"` from a `codex login` on a ChatGPT Plus/Pro account (`auth_mode: chatgpt`), exported on the host.
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
- If the IdP rotated the refresh token, the run log prints `taskcell: the Codex (ChatGPT) refresh token was rotated during this run.` followed by `The rotated tokens were written back to …/auth.json`; only `access_token`, `refresh_token` and `last_refresh` change in `~/.codex/auth.json`, which stays mode 0600. A symlinked `auth.json` is not written through: the log says so and asks for a fresh `codex login`.
- A refused refresh ("refresh token was already used") ends the run with `the ChatGPT sign-in was refused: … Sign in again (codex login) and re-run.`

## Recorded run

**Not yet recorded.** The change that added rotation reporting was developed in an environment with no Docker daemon and no ChatGPT-plan credential, so no live run could be made. A maintainer with both should run the steps above and fill in: date, Taskcell version, PR reviewed, whether a rotation occurred, and the outcome.

| Date | Version | PR | Rotation seen | Result |
| --- | --- | --- | --- | --- |
| _pending_ | | | | |
