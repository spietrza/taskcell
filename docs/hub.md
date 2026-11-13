# Taskcell Hub

`vanguard` is the old name of `taskcell` and still works.

`taskcell hub` serves the Inspector UI (`apps/desktop`) over plain HTTP/SSE, backed by a real `.taskcell/`
directory. It is the only backend: the desktop app is a client of a hub (see
[the desktop app's local hub](#the-desktop-apps-local-hub)), and a browser can use one directly — useful
without a native app, or on a server. See `src/hub/*.ts` and `src/cli/hub.ts` for the implementation.

## Install the desktop app

Installers (macOS `.dmg`, Windows `.msi`/`-setup.exe`, Linux `.AppImage`/`.deb`) are attached to the
[`desktop-latest` release](https://github.com/spietrza/taskcell/releases/tag/desktop-latest) once the desktop release job is enabled
(see `apps/desktop/README.md`). The app checks for updates on start and offers a new version; it downloads on consent and installs when you quit, so running tasks are not interrupted.

**macOS, unsigned builds.** Unsigned apps are blocked on first open. On macOS 14 and earlier, right-click the app
and choose **Open**. On macOS 15 and later, try to open it once, then go to **System Settings > Privacy & Security**
and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -cr /Applications/Taskcell.app` and open it again.

**Linux.** `chmod +x Taskcell_*.AppImage && ./Taskcell_*.AppImage`, or `sudo apt install ./Taskcell_*.deb`.

## Quick start

```bash
pnpm hub --repo /path/to/your/repo
```

This opens a browser at the printed launch URL, `http://127.0.0.1:7777/#token=…`. The fragment holds
the per-launch token the UI needs; the served page itself carries none, so open that exact URL (from
the terminal, or `docker logs` in container mode) rather than the bare address.

### Prerequisites

- Node 24 and pnpm; `pnpm install` at the repo root (the UI bundle is a separate pnpm project that
  `pnpm build:ui` installs and builds).
- `gh auth login` — the Task board, Remote and cloning private repositories go through `gh`.
- For runs started from the hub: Docker with the sandbox image (`docker/build.sh` builds
  `taskcell-sandbox:latest`; the egress proxy sidecar uses the same image, so a missing image
  surfaces as "Failed to start egress enclave"), and the provider credential exported in the shell
  that starts the hub — `CLAUDE_CODE_OAUTH_TOKEN` for Claude (`claude setup-token`), or the
  provider's own variable. The hub passes its environment to the run; a launcher without a shell
  (an IDE "launch" entry, a Compose file without `environment:`) has no token, and the first run
  fails at start.
- A project is a git work tree. Its `.taskcell/app.json` (task source, labels, provider, budget) is
  what the Settings screen edits; a repo without one works with the defaults.

## Three ways to use it

1. **Local factory.** Add the project, open the Task board, click **New Run** on an issue. The
   pipeline runs in the sandbox on this machine; the Runs screen shows the live transcript and, when
   it ends, every stage's record, diff, transcript, proof of work and visual proof. The PR lands on
   GitHub/GitLab like any other Taskcell run.
2. **Observe the CI factory.** Keep running Taskcell in GitHub Actions (see
   [onboarding-another-repo.md](onboarding-another-repo.md); the callers must pass
   `upload-run-records: true`) and use the hub read-only: Remote lists the repo's CI runs,
   **Fetch records** imports a run's `vanguard-runs` artifact into `.taskcell/remote-runs/<id>`, and
   the records open like local ones. No token, no Docker, no sandbox on this machine. The Task board
   header counts the factory's work from issue labels — `Running N` (claimed or running) and
   `Waiting K` (labelled `ready for agent`/`ready for spec`, not yet picked up) — so it shows the CI
   backlog too. A `+` (`12+`) means the board holds only its first page of issues and the count is a
   lower bound.
3. **Self-hosted.** Build `docker/hub.Dockerfile`, run it on a VPS (Coolify, Hetzner) behind Tailscale
   or an authenticating reverse proxy, and reach it from a laptop or a phone. Agent code runs on
   that host, so it needs Docker and the token there. Local mode has no login of its own: never
   publish the port. `VANGUARD_HUB_ALLOW_ADD=1` enables Add project and Clone repository on a
   non-loopback bind (see [Modes](#modes) and [Coolify / Docker Compose](#coolify--docker-compose)).
   Reaching it under a hostname (rather than an IP address) needs that hostname allowed:
   `VANGUARD_HUB_ALLOWED_HOSTS=hub.example.com` (or `--allowed-host hub.example.com`).

## Runs always use the LLM proxy

This is not hub-specific: it is `productionDeps()`'s behavior (`src/sidecar/deps.ts`), so it applies to
**every** run started through the sidecar protocol — `taskcell __sidecar` — which both the hub's own
dispatch and the desktop app's Task-board **New Run** use identically (the desktop spawns the same
`taskcell __sidecar` subprocess; see `../apps/desktop/README.md`). A desktop **Launch** command, or
`taskcell run`/`taskcell watch` invoked directly from a terminal, is a different path — plain CLI
invocations, which keep the CLI's own opt-in `--llm-proxy` (off by default) instead of this rule.

Every run on that path runs with the LLM proxy whenever the run has a credential the proxy's
trusted sidecar can hold — a Claude subscription token or `ANTHROPIC_API_KEY`, or z.ai's / OpenRouter's
key when that provider implements. The sidecar on the host keeps the real credential and the sandbox
gets a per-run nonce instead, so agent code never sees the token. Unlike the CLI's opt-in
`--llm-proxy`, this path has **no switch to turn this off** — no flag, no env var, no
`.taskcell/app.json` setting.

Three kinds of run go without it. There the credential *is* in the sandbox, so the run view shows a
warning naming the provider rather than leaving the exposure silent:

- **Codex on a ChatGPT subscription** (`CODEX_AUTH_JSON`). The credential is forwarded into the
  sandbox verbatim — Codex talks to the ChatGPT backend directly with it, which the proxy does not
  cover. The run still starts; tracked in #585.
- **Codex or Cursor on their own API key** (`CODEX_API_KEY`/`OPENAI_API_KEY`, `CURSOR_API_KEY`). Such a
  run consumes no Anthropic-family credential, so the proxy's primary sidecar has nothing to hold and
  cannot start; exporting `CLAUDE_CODE_OAUTH_TOKEN` as well does not change that, because the run never
  uses it. The key is injected into the sandbox and the run starts.
- **Direct-mode-only providers** — Meridian ([MERIDIAN-provider.md](MERIDIAN-provider.md)) and repo
  custom providers (`.taskcell/app.json` `customProviders`). They point the Claude CLI at their own
  endpoint and authenticate on that host, exposing no upstream a sidecar could target, so their key
  is injected into the sandbox.

If the proxy's trusted sidecar itself fails to start — usually a missing or stale sandbox image, since
it runs inside `taskcell-sandbox:latest` like the egress enclave — the run fails fast rather than
silently falling back to direct mode or hanging. The run view shows: `Failed to start llm proxy
<id>: rebuild the sandbox image (docker/build.sh builds taskcell-sandbox:latest), or check
VANGUARD_SANDBOX_IMAGE if set.`

## Modes

- **Local mode** — no sign-in screen (the hub acts as one automatic owner user), binds `127.0.0.1` by default. Intended for running on your own
  machine, reachable only from itself.
- **Container mode** — binds `0.0.0.0` because Docker port-mapping requires it. Reached under a
  hostname, set `VANGUARD_HUB_ALLOWED_HOSTS=hub.example.com` (every hostname the browser uses,
  including a non-default port).

A hub bound beyond loopback is **server mode** and requires sign-in (see "Server mode sign-in" below).
Do not publish it on a raw port without TLS: put it behind Tailscale or an HTTPS reverse proxy.

### Server mode sign-in

Whenever the hub binds beyond loopback (`--host 0.0.0.0`, a LAN/Tailscale address, a hostname) — even
with a single user — every page and every RPC/SSE route requires a signed-in user. Sign-in is
[Better Auth](https://www.better-auth.com) mounted on the hub's own HTTP server under `/api/auth/*`;
its data (users, sessions, linked accounts) lives in `auth.sqlite` in the hub state dir
(`VANGUARD_HUB_CONFIG_DIR`) via Node's built-in `node:sqlite` — no native module. The schema is created
or migrated on start. The signing secret is `VANGUARD_HUB_AUTH_SECRET`, or a random one persisted to
`auth-secret` (mode 0600) in the same directory. Signed-out browsers requesting a page are redirected
to `/sign-in`; API calls (`/rpc/*`, `/events`) answer `401` (`sign-in required`, which the web UI turns
into a redirect to `/sign-in`; the top bar has a **Sign out** button). `auth.sqlite` is created mode 0600.

**Behind a reverse proxy on the same host.** A hub bound to `127.0.0.1` behind nginx/Caddy is still
reachable by everyone the proxy serves, so set `VANGUARD_HUB_SERVER_MODE=1`: the loopback bind then runs
in server mode (sign-in required, `add_project` and the other writes need `VANGUARD_HUB_ALLOW_ADD=1`).
Also set `VANGUARD_HUB_PUBLIC_URL` and `--allowed-host` to the public name.

**Providers.** Each is enabled by the operator from env; a provider without both halves is hidden from
the sign-in page. Any enabled provider can sign in — one hub may hold GitHub and GitLab projects, and
Google is for people who only work on cards (e.g. Linear). Setup suggests the provider matching the
hub's repositories, but that is only a suggestion. (Apple arrives with the iOS app, #860.)

| Provider | Env vars |
|---|---|
| GitHub | `VANGUARD_HUB_AUTH_GITHUB_CLIENT_ID`, `VANGUARD_HUB_AUTH_GITHUB_CLIENT_SECRET` |
| GitLab | `VANGUARD_HUB_AUTH_GITLAB_CLIENT_ID`, `VANGUARD_HUB_AUTH_GITLAB_CLIENT_SECRET`, optional `VANGUARD_HUB_AUTH_GITLAB_ISSUER` (self-managed base URL, e.g. `https://gitlab.example.com`; default `https://gitlab.com`) |
| Google | `VANGUARD_HUB_AUTH_GOOGLE_CLIENT_ID`, `VANGUARD_HUB_AUTH_GOOGLE_CLIENT_SECRET` |

Also set `VANGUARD_HUB_PUBLIC_URL` to the URL users open: a bare origin such as `https://hub.example.com`
(a path or query is a startup error). It is the base of the OAuth callback URLs and must match the `Host`
you allow (`--allowed-host`). Unset, it falls back to the bind address — which a provider cannot
redirect to (`0.0.0.0`) — and the hub warns at startup when a provider is configured without it.

**Creating the OAuth apps.** The callback (redirect) URL is always
`<VANGUARD_HUB_PUBLIC_URL>/api/auth/callback/<provider>`, with `<provider>` = `github`, `gitlab` or `google`.

- *GitHub*: Settings → Developer settings → OAuth Apps → New OAuth App. Homepage = the public URL;
  authorization callback URL = `…/api/auth/callback/github`. Generate a client secret.
- *GitLab* (gitlab.com or **self-managed**): User Settings (or Admin → Applications for an
  instance-wide app) → Applications → Add new application. Redirect URI = `…/api/auth/callback/gitlab`;
  scopes `read_user`. Untick "Confidential" only if your GitLab version requires it. For a
  self-managed instance also set `VANGUARD_HUB_AUTH_GITLAB_ISSUER=https://gitlab.example.com`, and add
  that host to `VANGUARD_HUB_CLONE_HOSTS` if projects are cloned from it.
- *Google*: Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID
  (Web application). Authorized redirect URI = `…/api/auth/callback/google`; configure the consent screen.

**Sign-up allowlist.** Sign-up is not open. `VANGUARD_HUB_SIGNUP_ALLOW` is a comma-separated list that
decides who may *create* an account on first sign-in; anyone else is refused with "Sign-up is not open
on this hub". Entries: `alice@example.com` (an e-mail), `@example.com` (a domain), `github:login`,
`gitlab:login`. E-mail and domain entries only match an address the provider reports as verified. A
`gitlab:login` entry matches that login on whichever GitLab the hub is configured for. An empty list
means nobody can sign up (the hub warns at startup). Existing accounts are not re-checked on sign-in.

**Local owner user.** In local mode (a plain loopback bind) there is no sign-in screen, no OAuth and no
database (`/api/auth/*` and `/sign-in` answer 404); the hub acts as one automatic owner user. In server
mode the owner is a real Better Auth user (`owner@hub.invalid`, e-mail unverified so no provider
profile can link to it) created on first start. Every request resolves a user — the Better Auth session,
the hub token, or the owner — so teams, roles (#841) and "who started this run" share one code path;
server-mode user ids are Better Auth's.

**Teams and roles.** A signed-in user sees only the repositories of their teams. A member `login` is the
user's Better Auth id or their provider-verified e-mail — never the display name, which the user can
edit. `list_projects`, `list_tasks_all`, `list_runs_all` and `list_needs_you_all` take an optional `teamId`
(default: the user's first team; a user in no team gets empty lists). Any command naming a repository
outside the user's teams — reading a run, a session or a file included — is refused, and the run queue,
active run, run backlog, cancel and the `/events` stream only carry the user's repositories.
`add_team_member`, `remove_team_member`, `add_team_repository` (a project the admin already holds) and
`remove_team_repository` need the team's `admin` role; a `member` is refused. A team keeps at least one
admin. The token holder is the owner, admin of every team, and alone may `add_project` / `remove_project` /
`clone_project` / `browse_dirs` (a hub-wide remove also leaves every team), use the credential commands and the Fleet
commands. Token-only mode is unchanged: one default team, the token its admin.

*Adding the first members.* On a fresh server-mode hub the default team has no members, so signed-in users
see an empty hub until the owner adds them (there is no UI for it yet; use the token):

    curl -X POST "$HUB/rpc/add_team_member" -H "x-vanguard-hub-token: $TOKEN" \
      -H 'content-type: application/json' -H "origin: $HUB" \
      -d '{"teamId":"default","login":"alice@example.com","role":"admin"}'

**Token.** `x-vanguard-hub-token` keeps working for the CLI and scripts and maps to the owner user, in
both modes. In server mode the CLI prints the bare URL (a token in the fragment cannot load a page).

**Security model.** Only the OAuth providers' verified identity plus the allowlist decide who gets an
account; sessions are Better Auth's signed HttpOnly cookies. The Host check, the same-origin check on
RPC and the `401`-for-API / redirect-for-pages split above all still apply. A session user's `/events`
stream authenticates with the session cookie itself (no separate events secret), so signing out or
revoking the session ends it; only token holders get the `/events` cookie. Anyone holding the token is
the owner: keep `--token-file` private. Connecting GitHub, GitLab or Linear as a card source is
separate from sign-in and unchanged. Use HTTPS in front of the hub (cookies are `Secure` when the
public URL is `https`).

### Allowed Hosts (DNS rebinding)

The hub checks the `Host` header of every request — before serving the SPA, which holds a live
token once opened — and answers `403` for anything it doesn't recognise, so a page on an attacker-controlled
domain cannot rebind that domain to the hub's address and drive it. Allowed by default, on any port:
`localhost`, and any **IP literal** (IPv4, or a bracketed IPv6 — `127.0.0.1`, `[::1]`, `0.0.0.0`, a LAN
address, a Tailscale address). DNS rebinding can only produce a *hostname*, never an IP literal, so
`--host 0.0.0.0` and the URL the CLI prints and opens work with no flag; the port isn't checked against
the socket the hub actually bound, so `docker run -p 8080:7777`, `ssh -L 8080:localhost:7777` and
`kubectl port-forward` work too — none of that changes the hostname a DNS-rebinding page could have
produced.

Any other hostname — a reverse proxy's public name, a container's service name — must be opted in
with `--allowed-host <host[:port]>` (repeatable) or `VANGUARD_HUB_ALLOWED_HOSTS` (comma-separated).
Each value is matched against the `Host` header exactly, case-insensitively, so include the port
whenever the browser's URL has a non-default one. It takes a bare `host[:port]`, with the port between
1 and 65535: a scheme, a path, a wildcard, an unbracketed IPv6 literal or a non-numeric/out-of-range
port is a startup error, not a silent 403. `--host <hostname>` (a non-loopback, non-IP-literal name) is
seeded into the allowlist automatically, on the bound port, so the URL the CLI prints and opens is
never refused.

A **Tailscale MagicDNS name** (`host.tailnet.ts.net`) is a hostname, not an IP literal, so it needs
`--allowed-host host.tailnet.ts.net` / `VANGUARD_HUB_ALLOWED_HOSTS=host.tailnet.ts.net` like any other
hostname. A bare **Tailscale IP** (`100.x.y.z`) is an IP literal and needs no flag.

> **Upgrading:** before this allowlist existed, any `Host` reached the hub. A deployment reached by
> hostname — a Tailscale MagicDNS name, a reverse proxy's public name, a container's service name —
> now needs `--allowed-host`/`VANGUARD_HUB_ALLOWED_HOSTS` added, or it 403s. One reached only by IP
> literal or `localhost` needs no change.

The same-origin check (`sameOriginOk` in `src/hub/server.ts`) compares the request's `Origin` header
against its own `Host` header, not scheme, so the hub works behind an HTTPS-terminating reverse proxy
when `--allowed-host <public-host[:port]>` permits the public Host and the proxy preserves that header (including any
non-default port). Only HTTP(S) origins are accepted; the browser's `https://` Origin matches
the public `Host` even though the proxy connects to the hub over HTTP.

## Wire format

The UI talks to the hub with `POST /rpc/<command>` (JSON body = the command's camelCase args, `{}` when
none) and listens on `GET /events` (SSE). A success answers `200 {"result": <value>}` (`null` for void
commands, `false` stays `false`); an error answers `400`/`404`/`500 {"error": {"message", "kind"}}` with
`kind` = `bad-request` or `internal`. `apps/desktop/src/transport.ts` unwraps `result` and rejects with
`error.message`, so both sides must keep this envelope.

**`src/hub-wire.ts` is the single source of truth for this envelope, the SSE frame shape, the hub
marker, the token's header name and the events-session path** — a zero-import module copied verbatim into
`apps/desktop/src/hub-wire.ts` by `pnpm gen:wire`
(drift caught by `src/wire.test.ts`). The server (`src/hub/server.ts`, `events.ts`, `static.ts`) and the
browser (`apps/desktop/src/transport.ts`) both call its `encodeResult`/`encodeError`/`decodeResponse`/
`encodeEvent`/`decodeEvent`/`HUB_MARKER`/`HUB_TOKEN_HEADER`/`HUB_EVENTS_SESSION_PATH` instead of
hand-rolling either side of the wire. A reconnecting
SSE client whose `Last-Event-ID` gap exceeds the replay ring gets a `stream-reset` frame instead of a
replay; `transport.ts` resyncs by re-running its snapshot fetches rather than trusting the stream alone.
The same frame is sent when the id is *newer* than anything the hub has issued (a restarted hub numbers from 1
again); its data is `{"fallback":"read_run_events"}`, naming the call that returns the history the ring lacks.

## Run event log

The ring holds 500 events and dies with the process, so every `api:event` of a run is also appended to the run
store, next to the run's other artifacts (`<repo>/.taskcell/runs/<taskId>/`):

| File | Contents |
|---|---|
| `events-<run start>.jsonl` | One JSON line per event: `{"id","ts","event","data"}`. `id` is the SSE `id:` the live stream carried. Append-only, one write per event, string values masked like the other run artifacts. |

Capped at 5 MB per run: past it events are dropped, one `{"truncated":true,...}` marker line is written, and the run
carries on. A new run of the same task writes a new file; the older ones stay.

The read-only server call `read_run_events` (`{ repoPath, taskId, timestamp?, after?, limit? }`, allowed in server
mode) returns `{ events, nextAfter, hasMore, truncated }`: events with `id > after` in order, at most `limit`
(default 500, max 2000), of the run whose `list_runs` record carries `timestamp` (the newest log begun at or before it) or the newest run. To show history then go live:
open the SSE stream, page `read_run_events` from `after: 0` until `hasMore` is false, then apply live events whose
id is greater than `nextAfter` — no gap, no duplicate.

## The desktop app's local hub

The desktop app (`apps/desktop`) starts `taskcell hub` itself on `127.0.0.1` (a free port, a fresh per-launch
token, `--no-open`), loads the launch URL into its window, restarts the hub if it dies, and stops it on quit
(the hub also exits when the app's stdin pipe closes, `VANGUARD_HUB_EXIT_ON_STDIN_EOF=1`, so it is never
orphaned). Its project list lives in the app config dir (`VANGUARD_HUB_CONFIG_DIR`). Installed apps bundle a
Node runtime and the CLI; a source checkout (`pnpm start`) runs the TypeScript CLI — details in
[apps/desktop/README.md](../apps/desktop/README.md#local-hub-the-desktop-backend). Connecting the app to a
remote hub is a separate follow-up.

Only this hub enables **Fleet** (`spawn_run`/`kill_run`/`list_spawns`, `VANGUARD_HUB_ALLOW_FLEET=1`, honoured on
a loopback bind only); every other hub rejects those commands.

## Env vars

| Variable | Default |
|---|---|
| `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `VANGUARD_HUB_PORT` | `7777` |
| `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `VANGUARD_HUB_CONFIG_DIR` | `$XDG_CONFIG_HOME/vanguard-hub` else `~/.config/vanguard-hub` |
| `VANGUARD_HUB_WATCH_POLL` | — |
| `VANGUARD_HUB_WATCH_INTERVAL_MS` | `2000` |
| `VANGUARD_HUB_SECRET` | — (32 bytes, base64: `openssl rand -base64 32`. Enables the Settings credential store, `<config dir>/.vanguard-hub/credentials.enc`, AES-256-GCM. A stored Claude/Codex/z.ai/OpenRouter key overrides the same env var; the API is write-only (set + last four characters). Without it the store is disabled and env credentials apply) |
| `VANGUARD_HUB_BROWSE_ROOT` | `$HOME` |
| `VANGUARD_HUB_ALLOW_ADD` | — |
| `VANGUARD_HUB_SERVER_MODE` | — (`1` = require sign-in on a loopback bind, for a same-host reverse proxy) |
| `VANGUARD_HUB_PUBLIC_URL` | `http://<host>:<port>` (server mode: the OAuth callback base) |
| `VANGUARD_HUB_AUTH_{GITHUB,GITLAB,GOOGLE}_CLIENT_ID` / `_CLIENT_SECRET` | — (provider hidden unless both set; see "Server mode sign-in") |
| `VANGUARD_HUB_AUTH_GITLAB_ISSUER` | `https://gitlab.com` |
| `VANGUARD_HUB_AUTH_SECRET` | random, persisted to `auth-secret` in the state dir |
| `VANGUARD_HUB_SIGNUP_ALLOW` | — (comma-separated e-mails, `@domains`, `github:login`, `gitlab:login`) |
| `VANGUARD_HUB_ALLOW_FLEET` | — (`1` on a loopback bind enables Fleet; set by the desktop app) |
| `VANGUARD_HUB_EXIT_ON_STDIN_EOF` | — (`1`: shut down when stdin closes; set by the desktop app) |
| `VANGUARD_HUB_ALLOWED_HOSTS` | — (comma-separated exact Host values, added to `localhost`/any IP literal on any port) |
| `VANGUARD_HUB_MAX_QUEUE` | `10` (runs that may wait behind the one running run; past it a new run is refused. The queue is in memory only: a hub restart drops queued runs) |
| `VANGUARD_HUB_CLONE_HOSTS` | — (comma-separated hosts, added to `github.com`/`gitlab.com`) |
| `VANGUARD_CHAT_ALLOWED_ORIGINS` | — (comma-separated origins a project's `chatBaseUrl` may use; doc chat refuses any other origin than `https://api.anthropic.com`, since the inherited credential is sent there) |

## Add project: existing folder or clone a URL

The **Add project** dialog has two modes:

- **Existing folder** — browse (`browse_dirs`, confined to the browse root) to a directory that's
  already a git work tree and add it, exactly as before. `add_project` applies the same browse-root
  confinement, so a project outside the browse root cannot be added. To add one outside `$HOME`
  (the default root), start the hub with `VANGUARD_HUB_BROWSE_ROOT` set to a directory containing it.
- **Clone repository** — paste a repository URL, pick the parent folder with the same browser, and
  optionally override the folder name (default: the repo name from the URL). The hub clones it under
  the chosen parent and adds it, so a fresh install or a VPS hub with nothing to browse yet doesn't
  need a shell on the host first.

`clone_project { url, parentDir, name? } -> Project` (hub-only, `HUB_ONLY` in `src/wire.ts`) backs the
second mode:

- The URL must be `https://` or `ssh://`/`git@` to `github.com`, `gitlab.com`, or a host listed in
  `VANGUARD_HUB_CLONE_HOSTS` — no local paths, no `file://`.
- The target is resolved under the browse root, exactly like `browse_dirs`'s traversal guard (both
  sides realpath'd); a target outside the root, or an existing non-empty directory, is refused before
  anything is written.
- The clone runs via `gh repo clone` when the host is `github.com` and `gh` is authenticated (so
  private repos work with the host's own credentials), or plain `git clone` otherwise. Progress lines
  stream over the same SSE bus (`GET /events`) as a `vanguard:clone-progress` event (`{ line }`) so the
  dialog can show them live.
- On success it calls the same `add_project` path (allowlist + project store) and returns the new
  project's dashboard summary — the project appears without a page reload.
- On failure (bad URL, disallowed host, path outside the browse root, non-empty target, or `git`/`gh`
  itself failing) nothing is written and the error comes back as `bad-request` with git's message.

Gated exactly like `add_project`: loopback only, unless `VANGUARD_HUB_ALLOW_ADD=1` — a non-loopback
bind (server mode) must not let anyone clone onto the host.

## Coolify / Docker Compose

```yaml
services:
  vanguard-hub:
    build:
      context: .
      dockerfile: docker/hub.Dockerfile
    image: vanguard-hub:latest
    restart: unless-stopped
    mem_limit: 1024m
    ports:
      - "7777:7777"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock # sibling-sandbox execution; see risk note below
      - ./target-repo:/work/repo                  # the repo the hub serves + agent edits
      - vanguard-hub-config:/config                # VANGUARD_HUB_CONFIG_DIR
      - taskcell-hub-state:/state                  # holds the token file (below)
    environment:
      GH_TOKEN: ${GH_TOKEN}
      VANGUARD_MAX_SANDBOXES: "1"
      VANGUARD_HUB_TOKEN_FILE: /state/hub.key      # same token across restarts and redeploys
      VANGUARD_HUB_ALLOWED_HOSTS: hub.example.com # every Host the browser uses; loopback only by default

volumes:
  vanguard-hub-config:
  taskcell-hub-state:
```

On first start the hub creates `/state/hub.key` and prints the launch URL; read it from the logs and
save that URL (the page strips `#token=…` from the address bar, so bookmarking the open page won't
keep it). Later restarts keep the token. Rotate it with
`docker compose exec vanguard-hub taskcell hub rotate-token --token-file /state/hub.key`, then restart
the hub and read the new launch URL from its logs.

Mounting the Docker socket is equivalent to root on the host — a process with access to it can start a
privileged container and read or write anything the host can. Only do this when you trust everything
that runs in this container. If you only ever need read-only access to Docker endpoints, use
[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) in front of the
socket instead of mounting it directly. The [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
is the usual reference for "don't mount the docker socket without justification."

## Needs you

The **Needs you** screen (hub only) lists what the factory is waiting on a human for in the current
project, using `gh` and labels only — no model call (`src/hub/needs-you.ts`):

- Tasks (GitHub issues) at `needs info`.
- PRs at `vanguard:needs-human-review` or `vanguard:verify-failed`, or with a review requesting
  changes — unless they already carry `needs revision` (then it is the factory's turn).

Each item shows the factory's own last comment (its `gh` user, the CI identity, or a configured bot
login), redacted for secrets and rendered as plain text. Every list is filtered on GitHub's side and
capped at 100; only the first 30 items fetch their last comment, and a failed fetch drops just that
comment, not the list.

`reply_needs_you` posts the reply as the hub's `gh` user, then hands the item back to the factory:
a Task moves from `needs info` to the project's trigger label (`label` in `.taskcell/app.json`, else
`ready for agent`); a PR gets `needs revision`. Either way it leaves the list. An item that is no
longer waiting is refused with no comment and no label change. The `needs info` label itself is not
configurable here: a repo that runs the factory with a custom `--needs-info-label` shows no Tasks.

`merge_needs_you` merges a waiting PR with the repository's allowed merge method (squash, else merge
commit, else rebase). It refuses a PR that is not in the list and one whose required checks are not
all green, with a message the UI shows; the item leaves the list once merged. The UI's Merge button
names the PR's base branch (`baseRef`) and asks for a second click to confirm. The merge is pinned to the checked head commit (`--match-head-commit`). A PR with no required checks passes the check gate. The button sits on the Needs you card: the card quick view/drawer of the v3 prototype does not exist in the app yet. "Ask for changes" stays `reply_needs_you`.

Replies and merges are a remote mutation, gated like `clone_project`: loopback only, unless
`VANGUARD_HUB_ALLOW_ADD=1`.

`start_task` labels an issue to start the factory on it; see [Starting the factory from the hub](cli.md#starting-the-factory-from-the-hub).

## Enable factory

**Enable factory** on a project card (hub only) turns on the GitHub Actions factory for that repo in
four steps, following [onboarding-another-repo.md](onboarding-another-repo.md)
(`src/hub/enable-factory.ts`). GitLab and Linear show as coming soon.

1. **Plan** reads the repo with `gh` and changes nothing: the slug, the default branch, the signed-in
   `gh` login (it becomes the callers' actor gate), the package manager and scripts, and the caller
   workflows already on the default branch.
2. **Apply** writes the five thin callers (`taskcell-implement`, `-doctor`, `-pr-review`, `-revise`,
   `-resume`) from `templates/github/` on a branch of its own, skips any caller the default branch
   already has (under its `taskcell-` or the older `vanguard-` name), pushes that branch, opens a PR and creates the routing labels. It never pushes to the
   default branch. It refuses a dirty work tree or untracked files at the caller paths, puts back the
   branch you had checked out, and can be re-run after a partial failure. The hub reads the plan again
   before applying and refuses if the login, repo or default branch changed.
3. **Secret** shows the `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner/repo>` command for you to
   run. The hub never reads, prints or stores a secret value.
4. **Verify**, once the PR is merged, dispatches the doctor workflow and links the run it started.

Apply and verify change the remote, so they are gated like `clone_project`: loopback only, unless
`VANGUARD_HUB_ALLOW_ADD=1`. The `gh` login must be able to push workflow files (classic `repo` and
`workflow` scopes), create labels, open a PR and dispatch a workflow.

## Audit log

Every state-changing action appends one JSON line to `<config dir>/audit.jsonl` (time, login or `token`, action, target, outcome `ok`/`refused`/`failed`): sign-in, project add/remove, clone, run start/queue/cancel, task start, settings changes. Targets and detail are names only — never a credential value, token, cookie or URL userinfo/query. Each line is chained (sha256 of the previous record) and carries an actor and subject; the file rotates at 10 MB and rotated files are pruned after 90 days (at most 50 kept); `taskcell audit verify` checks the chain (see [audit.md](audit.md)). A line that cannot be written is reported to the caller instead of being dropped. Runs started from the hub carry `startedBy` in their records (shown in the Runs table). Admins read the log in the Audit view (`read_audit`); non-admins get 403. The owner (header token, or local mode) acts as the shared `token` admin identity; any other signed-in user is logged under their e-mail and is not an admin until roles land (`actorFor` in `createHubServer` overrides this).

## `gh` auth

The hub shells out to `gh` for the Remote screen (listing GitHub Actions runs), CI-run import and
Needs you. Reading needs a token with `actions:read`, `issues:read` and `pull_requests:read`
(fine-grained PAT) or classic `repo` scope. Replying from Needs you also needs `issues:write` and
`pull_requests:write` (comments and labels), and merging also needs `contents:write`; with a read-only token a reply fails when it posts the
comment. Run `gh auth login` or set `GH_TOKEN`.

## CI run import

The reusable `implement.yml` and `revise.yml` workflows take an `upload-run-records` input (boolean,
off by default). When a caller passes `upload-run-records: true`, the job uploads `.taskcell/runs/` as
a `vanguard-runs` artifact kept for 14 days, with `**/*.bundle` excluded (git bundles are large and the
reader ignores them). The step runs under the same gate as `persist-metrics`: only once the run step
finished, pass or fail. This repo's own callers (`taskcell-implement.yml`, `taskcell-revise.yml`) opt
in; a client repo adds the input to its thin caller, see `docs/onboarding-another-repo.md` for the
input table and the "off by default, on purpose" notes.

What the artifact may contain, and what keeps it safe to publish: transcripts and `finalText` go
through `redactTokens`; a secret-blocked run, or a stage whose diff the secret scan flags, leaves no
`.diff`, `.bundle` or transcript (`diffOmitted` on the record says why); the scan exempts test paths,
so a credential added under `tests/` or `*.test.ts` is in the diff exactly as it would be in the PR.
Artifacts are downloadable by anyone with read access to the repository — on a public repo, any
signed-in GitHub user.

A `vanguard-runs` artifact is missing when the caller never opted in, when the run step did not reach
`success` or `failure` (blocked actor gate, failed build), or when the run wrote no record at all; the
empty-artifact case does not arise, because `if-no-files-found: ignore` skips the upload instead.

## Resource limits

Mirror `docker/compose.yaml`'s `mem_limit: 1024m` pattern. The hub runs agent sandboxes in the same
process as the HTTP server, so give the container the same RAM headroom, and keep
`VANGUARD_MAX_SANDBOXES=1` on a small host.

## Per-user provider credentials

Off by default: every run uses the instance credential (the hub's environment, or an instance
credential an admin saved). An **admin** — a GitHub login listed in `--admin-github-login`
(repeatable) or `VANGUARD_HUB_ADMIN_GITHUB_LOGINS` (comma-separated) — can change the
`per-user credentials` switch in Settings:

| Setting | A run uses |
|---|---|
| `off` | the instance credential |
| `user-first` | the starter's own credential, else the instance credential |
| `user-only` | the starter's own credential; with none saved the run is refused before it is queued |

A run on the starter's own credential never reads the hub's provider keys: a provider whose key the user cannot save (a repo custom provider's `keyEnv`, meridian's `MERIDIAN_BASE_URL`) is refused for it.

When the switch is on, each signed-in user saves their own provider credentials in Settings. They are
keyed by GitHub user id and stored encrypted (AES-256-GCM) in `credentials.enc.json` in the hub
config dir, with the key in `credentials.key` (mode 0600) beside it. Credentials are write-only:
the hub lists which variable names are saved, never a value, and no RPC takes a user id, so one user
cannot read, overwrite or use another's. Only admins see the switch and the instance credentials
(anyone else gets 403). The run record carries `credentialSource: 'instance' | 'user'`, never the value.

This needs the hub's GitHub sign-in to identify the caller (`HubServerOptions.identify`); without a
signed-in user there is no admin and no per-user credential.
The admin match uses the login GitHub reports for the account's numeric id at each GitHub sign-in (kept
in `hub_github_login` in `auth.sqlite`), never a profile field a user can edit: after upgrading, an
admin signs out and in with GitHub once before the switch appears.

## CLI flags

```
taskcell hub [--repo <path>] [--host <addr>] [--port <n>] [--ui-dir <dir>] [--no-open] [--allowed-host <host[:port]>] [--token-file <path>] [--admin-github-login <login>]
taskcell hub rotate-token --token-file <path>
```

| Flag | Overrides | Default |
|---|---|---|
| `--repo <path>` | — | cwd; seeded into the project store on startup if it's a git work tree and not already present |
| `--allowed-host <host[:port]>` (repeatable) | `VANGUARD_HUB_ALLOWED_HOSTS` (comma-separated, additive) | `localhost` / any IP literal on any port |
| `--host <addr>` | `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `--port <n>` | `VANGUARD_HUB_PORT` | `7777` (1-65535; an invalid explicit `--port` is a startup error) |
| `--ui-dir <dir>` | `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `--token-file <path>` | `VANGUARD_HUB_TOKEN_FILE` | unset: a fresh token per launch |
| `--no-open` | — | opens the printed URL (loopback: the launch URL `/#token=…`; server mode: the bare URL) in a browser unless passed |

A missing or unbuilt `--ui-dir` fails at startup, naming `pnpm --dir apps/desktop build`
(run `pnpm build:ui`) rather than failing on the first request. Binding a non-loopback host
requires sign-in (warning at startup if no provider or allowlist is configured) and disables `add_project`/`browse_dirs`/`clone_project`,
`enable_factory_apply`/`enable_factory_verify`, `reply_needs_you`, `merge_needs_you` and `start_task` unless
`VANGUARD_HUB_ALLOW_ADD=1`. `SIGINT`/`SIGTERM` close the listener, every connected SSE client,
and the project file watchers.

Each launch mints a fresh token. RPC requests require `x-vanguard-hub-token` and a same-origin
`Origin` header (a request without one is rejected). The SSE stream never takes the token in its
URL: the UI first `POST`s `/events/session` with the header, and the hub answers with an HttpOnly,
`SameSite=Strict` cookie scoped to `/events` (an events-only secret, not the token) that the
`EventSource` sends on every connect and reconnect; a non-browser client can send the header on
`GET /events` instead. `/healthz` stays unauthenticated for container health checks and answers a
constant `{"ok":true}`. No route serves the token — not `index.html`, not `/healthz`. The CLI
prints and opens a launch URL carrying it in the fragment (`/#token=…`), which browsers never send to
the server; the UI moves it into `sessionStorage` and strips it from the address bar, so a reload
keeps working but a new tab on the bare URL needs the launch URL again. Behind a reverse proxy, append
the same `/#token=…` to the public URL. Reaching the port is therefore not enough to drive the hub,
but the token is a launch secret, not per-user authentication: it does not replace authentication at
the reverse proxy. It is regenerated on every hub launch, so an already-open page must be given the
new launch URL once the hub restarts.

With `--token-file <path>` (or `VANGUARD_HUB_TOKEN_FILE`) the token persists instead: an existing file
is read, a missing one is created with a fresh token and mode `0600` (every launch prints the
launch URL, with the token in its fragment, same as without the flag). The hub refuses to start when the file is
group or world readable (`chmod 600 <path>`) or holds fewer than 32 bytes of entropy (hex or
base64url). `taskcell hub rotate-token --token-file <path>` writes a new token; a running hub keeps
the old one until it restarts, after which the old token is rejected. The events cookie secret stays
per launch, so a restart still ends old SSE sessions.

## Open in the original system

Cards, runs, the diff view and Needs-you items link out to where the thing lives. The server returns
every address (`BoardTask.url`/`source`, `RunSummary`/`RunDetail` `prUrl`/`ciUrl`/`diffUrl`,
`NeedsYouItem.url`); the UI never builds one, and renders no link when the field is absent (e.g. a
local run with no pull request). `diffUrl` is `…/pull/N/files` ("Files changed") on GitHub and
`…/-/merge_requests/N/diffs` ("Changes") on GitLab. `ciUrl` is recorded on a run record written inside
GitHub Actions or GitLab CI. Only `https:` addresses are passed on. Links open in a new tab.
