# Taskcell Inspector

A local **Tauri 2** cockpit over [Taskcell](../../README.md) — watch, inspect, drive, and remotely
observe agent Runs. Rust backend · React 19 · Tailwind v4 · [chunks-ui](https://github.com/) · TypeScript.

## Run

```bash
cd apps/desktop
pnpm install
pnpm start        # = tauri dev  (also runnable from repo root: `pnpm start`)
```

First launch compiles the Rust crate (a few minutes), then opens the window. Add a project pointing at any
repo that contains a `.taskcell/` directory. Launch from a terminal so the app inherits your shell
environment (LLM/platform credentials) — see **Launching runs** below.

Gates: `cd src-tauri && cargo test` · `pnpm vitest run` · `pnpm build`.

## Install the desktop app

See [Install the desktop app](../../docs/hub.md#install-the-desktop-app) for download and first-open steps.

### Build installers locally

```bash
cd apps/desktop
pnpm install
pnpm bundle                       # installers land in src-tauri/target/release/bundle/
```

Never use a bare `pnpm tauri build`: `bundle` also stages the Node sidecar and the `taskcell` resource (see
**Which hub runs** below), without which the installed app has no hub to start. Each platform builds only its own
formats, for the host architecture only (the sidecar is the Node running the build), so macOS arm64 and x64
installers come from separate runners, not one universal build. The build version comes from `tauri.conf.json`;
releases override it with `pnpm bundle --config '{"version":"X.Y.Z"}'`, which Tauri merges over
`tauri.bundle.conf.json`. Updater artifacts are off by default, so a local build needs no key.

### Auto-update keys

The updater verifies signed artifacts. The maintainer creates the key pair once:

```bash
pnpm tauri signer generate -w ~/.tauri/taskcell.key
```

- Put the **public** key (`taskcell.key.pub` contents) in `plugins.updater.pubkey` of `src-tauri/tauri.conf.json` (a `REPLACE_` placeholder until then; the app skips the update check).
- Store the **private** key as the CI secret `TAURI_SIGNING_PRIVATE_KEY` (and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Never commit it.

### Release job (CI, applied by a human)

The factory cannot edit `.github/`, so the matrix job (macOS arm64 and x64, Windows, Linux via `tauri-apps/tauri-action`)
is described in the PR that introduced it and must be added to the release workflow by hand. It must:

- stage the hub first (Node ≥ 24, then `node scripts/prepare-sidecar.mjs` in `apps/desktop`) and add
  `--config src-tauri/tauri.bundle.conf.json` to the build args, the same as `pnpm bundle`, so each installer carries the hub;
- pass `--config '{"version":"X.Y.Z","bundle":{"createUpdaterArtifacts":true}}'` and the signing secrets above;
- upload the installers and `latest.json` to a **dedicated rolling release tagged `desktop-latest`**, replacing the
  previous assets, not to the CLI release stream, which has no desktop assets on most tags. The updater endpoint
  (`releases/download/desktop-latest/latest.json`), the landing page and the docs all point at that release.

Until `plugins.updater.pubkey` is a real key, the app skips the update check.

### Optional macOS signing and notarization

Builds work unsigned. When these secrets are present the release job signs and notarizes: `APPLE_CERTIFICATE`
(base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.

## Driving the UI with an agent

The frontend is a plain Vite + React app that can run in any browser with a mocked backend — no Rust build,
no macOS, no `tauri-driver`. When `import.meta.env.DEV` is true and `window.__TAURI_INTERNALS__` is absent
(plain browser), `main.tsx` dynamically imports `src/dev/mockBackend.ts` which installs typed fixture data
via `@tauri-apps/api/mocks`. The `import.meta.env.DEV` guard lets Rollup statically eliminate the import
branch in production builds, so the mock chunk is never emitted into `dist/`.

**Start the dev server:**

```bash
pnpm --dir apps/desktop dev   # vite → http://localhost:1420, mocks auto-install
```

**Then drive it via Playwright MCP:**

```
browser_navigate       http://localhost:1420
browser_snapshot                      # a11y tree — read structure, find elements
browser_take_screenshot               # see pixels
browser_click / browser_type          # interact; click the left rail to change screen
```

The app renders with populated fixture data (two projects, three runs with full transcript/diff/proof,
board tasks, capabilities, flows). Navigate screens by clicking the rail icons exactly as a user would —
no URL routing needed.

## Local hub (the desktop backend)

The hub (`taskcell hub`, see `../../docs/hub.md`) is the only backend. The desktop app is a client of a
hub: on launch it starts one on `127.0.0.1` (random free port, per-launch token, no terminal, no
sign-in), loads the UI the hub serves into its window, and stops it on quit. The window therefore shows
exactly what a browser pointed at the same hub shows, and the UI makes no Tauri command calls for product
features. `src/transport.ts` is the seam: `invoke()`/`subscribe()` use the hub's `POST /rpc/<cmd>` + `/events`
SSE stream, selected by the `window.__VANGUARD_HUB__` marker the hub injects into `index.html`. (Its Tauri
branch only serves `dev/mockBackend.ts` and `vitest`.)

**What the Rust code does** (`src-tauri/src/hub.rs`, `lib.rs`): open the window (a splash page,
`splash/index.html`), start the hub, navigate to its launch URL, restart it with backoff if it dies (a status
overlay says so; one supervisor, so nothing starts twice), and stop it on quit. The hub also exits on its own
if the app dies (its stdin, a pipe from the app, closes). Projects stay in the app config dir, so existing
installs keep their list. Capabilities: `capabilities/hub.json` grants the loopback-served UI only window
chrome (drag, close flush) — no commands.

**Fleet** works here because this hub is loopback-only and started with `VANGUARD_HUB_ALLOW_FLEET=1`; any
other hub rejects `spawn_run`/`kill_run`/`list_spawns`.

**Which hub runs:** a source checkout (`pnpm start`, which builds the UI first) runs `src/cli/index.ts` through
`node --import tsx` (needs Node ≥ 24 and `pnpm install` at the root). An installed app runs its bundled
hub: `pnpm --dir apps/desktop bundle` (`scripts/prepare-sidecar.mjs`) stages a Node runtime as the Tauri
sidecar `node` plus the built CLI, its production dependencies and the UI as the `taskcell` resource
(`src-tauri/tauri.bundle.conf.json`). **Decision: bundled Node, not a single-executable build** — the CLI is
ESM with many dependencies and runtime-resolved assets/child scripts (`__complete`, proxies, templates) that a
single executable would have to embed and patch, and it re-runs itself as a child process; shipping `node`
plus the plain `dist/` keeps one code path with the source checkout at the cost of a larger installer.

## Server mode (remote hub)

The rail's server switcher (`src/ServerSwitcher.tsx`) swaps the window between the local hub and saved remote
hubs; the app menu's **Server ▸ Switch to Local Hub** is the way back from pages without a rail.
`src-tauri/src/servers.rs` keeps the list (`servers.json`, names and URLs; no credentials — the hub's session
cookie lives in the webview). `Hub::switch` (`hub.rs`) navigates the window and runs one reconnect loop per
selected server. The only Tauri commands are `servers_*`: `capabilities/hub.json` grants them to the loopback
UI, and `servers::grant` adds a capability at runtime for each saved server's own origin (list and switch only, never every http(s)
page). Users: [../../docs/hub.md](../../docs/hub.md#connect-the-desktop-app-to-a-server).

## Hub mode (browser)

The same frontend runs in a browser against any hub.

The hub requires a **per-launch token** on every `/rpc/<cmd>` and on `/events`. It is never part of
`index.html`: the hub prints and opens a launch URL that carries it in the fragment
(`http://127.0.0.1:7777/#token=…`, never sent to the server). `transport.ts` moves it into
`sessionStorage` (key `vanguard-hub-token`), strips it from the address bar, and sends it from there
— so a reload keeps working, but a new tab opened on the bare URL has no token until it is given the
launch URL. **The page must be served by the hub**: `VITE_VANGUARD_HUB=1` on Vite's own dev server
(`http://localhost:1420`) is a dead end, since its same-origin `/rpc/<cmd>` goes to the dev server
(which proxies nothing to the hub). There is no escape hatch; to see a change against a real hub,
rebuild and let the hub serve it (first recipe below). The token is minted per launch, so restarting
the hub invalidates an already-open page — the UI says so; open the new launch URL to reconnect.

**Build the UI and run the hub against a real repo:**

```bash
pnpm --dir apps/desktop build          # emits apps/desktop/dist, which the hub serves
taskcell hub --repo /path/to/your/repo # from the repo root; prints the launch URL it opened
```

Reaching the hub under a hostname other than loopback or an IP literal needs that Host allowed —
`--allowed-host hub.example.com` (see `../../docs/hub.md`).

**Differences from the desktop window:**

- **Fleet** — dropped from the rail unless the hub is the desktop app's own loopback hub. It spawns
  programs, which would be remote code execution on a reachable server; the hub's RPC dispatcher rejects
  the underlying commands too.
- **A native OS folder dialog** — on every client, "Add a repo" opens `RepoPicker`, a modal that walks the
  filesystem via `browse_dirs` (confined server-side to the hub's browse root).

**Coverage guard:** `src/dev/mockBackend.test.ts` asserts that every `invoke` command string in
`src/ipc.ts` has a fixture. A new IPC command added without a matching case in `mockBackend.ts` fails
the test immediately.

## What it does (shipped)

- **Dashboard cockpit** — a card per project (runs, tasks, spend, failed, 24h velocity, relative
  last-activity) + a live summary strip (Projects / Running / Runs / Last 24h / Spend), polled every 5s.
- **Left rail** — Conductor-style project nav with live running-dots, add-project, ⌘K search, theme toggle.
- **Command palette (⌘K)** — jump to any project or action.
- **Run inspector** — breadcrumb nav (`Home / project / task`); a run's **Overview** (proof-of-work gate,
  per-stage cards with turns/duration/tokens/cost/model), **Spec** (source issue, best-effort via
  `gh`/`linear`), **Diff** (colored), **Transcript** (parsed agent stream + Show-raw toggle).
- **Watch mode** — a `notify` file-watcher on `.taskcell/` auto-refreshes the run list and open run as
  files change; in-flight runs surface as pulsing **running** rows with a **live transcript** (assistant
  markdown + tool calls + tokens), before their record even lands.
- **Launch (P1)** — a **New run** form (presets: Run issue / Watch fleet / GitLab MR) spawns a command in
  the project dir inheriting your env; streamed output panel + **Kill**. The launched run then shows live.
- **Remote runs (P4 slice)** — lists GitHub Actions runs via `gh run list`. **Fetch records** pulls a run's
  `vanguard-runs` artifact (`gh run download`) into the app config dir under
  `remote-runs/<owner-repo>/<run-id>/` and expands it into the same run rows as local runs; a row opens the
  same Overview / Diff / Transcript inspector. Already-downloaded runs carry a **cached** marker and open
  without `gh`. Needs the workflow's `upload-run-records` input on.
- **Per-project screens** (Inspector sub-nav) — **Runs · Board · Fleet · Remote · Workflow · Settings**:
  - **Task board** — tasks from the configured source (`linear`/`gh`) bucketed into lifecycle columns;
    card → **Task/spec detail** (source spec + run history + New Run). Best-effort (auth-dependent).
  - **Fleet** — Watch Loop start/stop, concurrency, Loop-v1, slot meter (spawns `taskcell watch`).
  - **Workflow** — visual block composer over `.taskcell/app.json` (blocks + inspector + Canvas/Source HCL).
  - **Settings** — the `.taskcell/app.json` config form (source, label, provider, verify, concurrency, budget).
- **Rich output** — markdown rendering, `highlight.js` code/JSON blocks, agent `<plan>`/`<findings>`/
  `<promise>` tags as colored callouts. Light + dark, persisted.

## Architecture

Typed JSON over Tauri IPC is the only boundary. `src/taskcell-output.d.ts` hand-mirrors the persisted
shapes (kept decoupled from Taskcell's build, per the design spec §4).

**Rust (`src-tauri/src/`)** — `hub.rs` starts, supervises and stops the local hub; `lib.rs` opens the window. No
`#[tauri::command]`s: the runs/projects/drafts/remote/spawn logic lives in `src/hub/*` and `src/core/*`.

**React (`src/`)** — `App` (left-rail shell + ⌘K + theme), `features/dashboard`, `features/inspector`
(run list/detail/live/remote/launch/spec), `components/` (reusable `Markdown` / `CodeBlock` / `Callout` /
`AgentText`).

## Notes & limits

- **Credentials** are inherited from the operator environment; the app never stores or brokers them
  (design spec §12). A *bundled* `.app` launched from Finder has a minimal env — run from a terminal for
  now.
- **Task board "New Run" always uses the LLM proxy.** It goes through `sidecar.rs`'s `vanguard
  __sidecar` subprocess, the same `productionDeps()` dispatch the hub uses — see
  [Runs always use the LLM proxy](../../docs/hub.md#runs-always-use-the-llm-proxy) for which
  credentials that covers, which don't, and what a failed proxy sidecar looks like. **Launch** below is
  a different path and is not covered: it is an ordinary CLI invocation, so the CLI's own opt-in
  `--llm-proxy` (off by default) applies instead.
- **Launch command**: the Fleet watch loop is built from `.taskcell/app.json` (repo content), so its
  `provider`/`source` must be plain names (built-in or custom provider) and the argv is spawned in the project dir **without a shell**.
- **Doc chat `chatBaseUrl`** (also from `app.json`) only receives the inherited Anthropic credential when
  it is `https://api.anthropic.com` or an origin listed in `VANGUARD_CHAT_ALLOWED_ORIGINS`
  (comma-separated, set in the environment the app is launched from).
- **Spec / remote** fetches require an authed `gh` / `linear` on `PATH`; they fail gracefully otherwise.

## Remaining / to harden

Full-product design in `../../design/brief.md`; rendered mockups in `../../docs/design/screens/`.

- **Workflow editor** — currently a config-backed block composer; the full drag-graph + HCL/JSONC
  round-trip (spec §13) awaits the format spike ("spike both").
- **Task board / spec fetch** — best-effort via CLI (`gh`/`linear`); needs live verification against
  authed sources + refined state→column mapping.
- **Remote depth** — live log tail (`glab ci trace`), GitHub↔GitLab parity (spec §14).
- **Shell** — the design puts the per-project screens in the left rail (project switcher); the build
  hosts them as an Inspector sub-nav. Cosmetic alignment to the mockups is pending.
