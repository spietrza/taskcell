# Contributing to Vanguard

## Prerequisites

- **Node.js** 24 or later
- **pnpm** (version declared in `package.json` under `packageManager`)
- **Docker** (for building and running the sandbox image)
- **Git** 2.28 or later (the tests use `git init -b`, and `revise-pr` uses `git fetch --end-of-options`, added in 2.24)

## Install and build

```bash
corepack enable  # activate pnpm (one-time)
pnpm install
pnpm build       # compile TypeScript → dist/
```

`pnpm.overrides` in `package.json` forces `@modelcontextprotocol/sdk` (a peer of `@anthropic-ai/claude-agent-sdk`
that pnpm auto-installs; nothing in `src/` imports it) onto a patched release: the vulnerable
`express`/`hono`/`fast-uri`/`ip-address` chain hangs off it, and neither a direct bump nor Dependabot's
grouped updates reach an auto-installed peer. When the agent SDK widens that peer range (e.g. to `^2`),
move the override with it; `pnpm audit` reports the state. `apps/desktop` keeps its own overrides in
`apps/desktop/pnpm-workspace.yaml`, bounded to the advisory's major.

## Sandbox image

Build the sandbox image (Node 24, Git, Claude CLI) with:

```bash
bash docker/build.sh
```

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CLI_VERSION` | `2.1.322` | `@anthropic-ai/claude-code` version to install |
| `TAG` | `taskcell-sandbox:latest` | Docker image tag |
| `ALIAS_TAG` | `vanguard-sandbox:latest` (only when `TAG` is unset) | Extra tag on the same image; setting `TAG` yourself drops the pre-rename alias unless you pass `ALIAS_TAG` too. `ALIAS_TAG=` skips the alias |

The script builds the image and smoke-tests it (`claude --version`, `git --version`) before returning.

## Typecheck and tests

```bash
pnpm typecheck
pnpm test
```

Both must pass before opening a pull request.

The sandbox contract suite (`src/sandbox/sandbox-contract.test.ts`) runs against the real
`taskcell-sandbox:latest` image in both rootfs modes, and it is opt-in. Build the image with
`bash docker/build.sh`, then run `VANGUARD_CONTRACT=1 pnpm test src/sandbox/sandbox-contract.test.ts`.
Without the variable the file logs why it skipped; with it, a missing image fails the run. Run it when
you change `src/sandbox/`.

Run `pnpm coverage:ratchet` to measure coverage and preview raised thresholds.
Use `pnpm coverage:ratchet --write` to apply them to `vitest.config.ts` after a
successful suite. Each threshold stays at least its current value, with new floors
set to the measured percentage rounded down minus two points.

## Workflow

1. Fork the repo (external contributors) or create a branch (collaborators).
2. Branch off `main` with a descriptive name, e.g. `feat/sandbox-timeout` or `fix/pipeline-retry`.
3. Make your changes and ensure `pnpm typecheck` and `pnpm test` pass.
4. Open a pull request against `main`. Describe *what* changed and *why*.
5. Address review comments, then request a re-review once resolved.

Keep pull requests focused — one logical change per PR makes review faster and history cleaner.
