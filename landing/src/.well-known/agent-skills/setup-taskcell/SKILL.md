---
name: setup-taskcell
description: Install Taskcell, a self-hosted software factory, and run it on a user's GitHub, GitLab or Linear repository. Use when a user asks to set up Taskcell (CLI name taskcell), build an issue into a pull request with it, or keep it watching labelled issues.
---

# Set up Taskcell

Taskcell turns a labelled issue into a pull request: it writes a spec, builds the change in a Docker sandbox, runs the repository's verify script and a review, and opens the PR. A human merges. Source and docs: https://github.com/spietrza/taskcell

The CLI is `taskcell`; `vanguard` (the project's former name) still works as a deprecated alias. The `VANGUARD_*` variables and the `vanguard:*` labels keep the old name. Per-repo state lives in `.taskcell/` (an existing `.vanguard/` is still used until renamed).

## Requirements

- Node.js 24 or newer, pnpm, Docker (running), git.
- A tracker CLI, logged in: `gh` for GitHub, `glab` for GitLab, or the `linear` CLI for Linear.
- One model credential. For Claude (the default provider), either `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription; create it with `claude setup-token`) or `ANTHROPIC_API_KEY` (billed per token). Other providers: `--provider codex`, `--provider cursor`, `--provider openrouter`.

Ask the user which credential to use. Never print a token, write one into a committed file, or pass one on the command line where it lands in shell history; read it from the user's secret store or environment.

## Install

```sh
git clone https://github.com/spietrza/taskcell.git
cd taskcell
pnpm install && pnpm build
docker/build.sh          # builds the sandbox image
pnpm link --global       # puts taskcell on PATH
```

Check it: `taskcell doctor --source github --github-repo owner/repo` reports what is missing.

## Build one issue

```sh
taskcell run --github owner/repo#42 --repo /path/to/local/clone --llm-proxy
```

`--llm-proxy` keeps the real model key on the host; the sandbox only gets a one-run nonce. Prefer it. The run ends with a pull request: ready for review when every gate passed, a draft when one did not. Run artifacts (diff, transcripts, metrics) are under `.taskcell/runs/` in the target repo; keep `.taskcell/` in its `.gitignore`.

The issue needs acceptance criteria. A vague issue is relabelled `needs info` before any model runs.

## Keep it running

```sh
taskcell watch --source github --github-repo owner/repo
```

It picks up issues by label:

- `ready for spec`: writes a tech spec on the issue, then builds it.
- `ready for agent`: builds directly (the issue is already scoped).
- `needs revision` on a PR Taskcell opened: applies the review comments and pushes.

GitLab uses `--source gitlab` and the same trigger labels. Linear routes by workflow state.

## Hub

`pnpm build:ui && taskcell hub --repo /path/to/clone` serves a local board at http://127.0.0.1:7777. It has no login: on a server, put it behind Tailscale or an authenticating proxy, never on a public port.

## Do not

- Do not edit CI config (`.github/workflows/`, `.gitlab-ci.yml`) through Taskcell; agent edits to those paths are dropped.
- Do not merge the PR for the user unless they ask; review and merge are the human's step.
