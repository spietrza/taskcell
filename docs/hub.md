# Taskcell Hub

`vanguard` is the old name of `taskcell` and still works (variables: [environment-variables.md](environment-variables.md)).

`taskcell hub` serves the Inspector UI (`apps/desktop`) over plain HTTP/SSE, backed by a real `.taskcell/`
directory. It is the only backend: the desktop app is a client of a hub (see
[the desktop app's local hub](#the-desktop-apps-local-hub)), and a browser can use one directly — useful
without a native app, or on a server. See `src/hub/*.ts` and `src/cli/hub.ts` for the implementation.

## Install the desktop app

Installers (macOS `.dmg`, Windows `.msi`/`-setup.exe`, Linux `.AppImage`/`.deb`) are attached to the
[`desktop-latest` release](https://github.com/spietrza/taskcell/releases/tag/desktop-latest) once the desktop release job is enabled
(see `apps/desktop/README.md`). The app checks for updates on start and offers a new version; it downloads on consent and installs when you quit, so running tasks are not interrupted.

Building the desktop app yourself: in `apps/desktop`, `pnpm test:rust` builds and tests the Rust side and `pnpm bundle -- --locked` makes the installers, both with the committed `Cargo.lock` (see [`apps/desktop/README.md`](../apps/desktop/README.md)).

**macOS, unsigned builds.** Unsigned apps are blocked on first open. On macOS 14 and earlier, right-click the app
and choose **Open**. On macOS 15 and later, try to open it once, then go to **System Settings > Privacy & Security**
and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -cr /Applications/Taskcell.app` and open it again.

**Linux.** `chmod +x Taskcell_*.AppImage && ./Taskcell_*.AppImage`, or `sudo apt install ./Taskcell_*.deb`.

## Quick start

```bash
pnpm hub --repo /path/to/your/repo
```

On a loopback bind this opens a browser at the printed launch URL, `http://127.0.0.1:7777/#token=…`. The
fragment holds the per-launch token the UI needs; the served page itself carries none, so open that
exact URL from the terminal rather than the bare address. A hub bound beyond loopback (server mode,
including the container hub) has no launch URL: open its public URL and sign in at `/sign-in`
(see Server mode sign-in).

### Prerequisites

- Node 24 and pnpm; `pnpm install` at the repo root (the UI bundle is a separate pnpm project that
  `pnpm build:ui` installs and builds).
- `gh auth login` — the Board, Remote (under Settings → Runners) and cloning private repositories go through `gh`.
  A repository needs a git remote for these. `GH_REPO` in the hub's environment also works, but it is hub-wide: every project on that hub then creates issues and lists runs in that one repository, so use it only on a hub with a single project.
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

1. **Local factory.** Add the project, open the Board, click **New Run** on an issue. The
   pipeline runs in the sandbox on this machine; the Runs screen shows the live transcript and, when
   it ends, every stage's record, diff, transcript, proof of work and visual proof. The PR lands on
   GitHub/GitLab like any other Taskcell run.
2. **Observe the CI factory.** Keep running Taskcell in GitHub Actions (see
   [onboarding-another-repo.md](onboarding-another-repo.md); the callers must pass
   `upload-run-records: true`) and use the hub read-only: Remote lists the repo's CI runs,
   **Fetch records** imports a run's `vanguard-runs` artifact into `.taskcell/remote-runs/<id>`, and
   the records open like local ones. No token, no Docker, no sandbox on this machine. The Board
   header counts the factory's work from issue labels — `Running N` (claimed or running) and
   `Waiting K` (labelled `ready for agent`/`ready for spec`, not yet picked up) — so it shows the CI
   backlog too. A `+` (`12+`) means the board holds only its first page of issues and the count is a
   lower bound.
3. **Self-hosted.** Build `docker/hub.Dockerfile`, run it on a VPS (Coolify, Hetzner) behind Tailscale
   or an authenticating reverse proxy, and reach it from a laptop or a phone. Agent code runs on
   that host, so it needs Docker and the token there. Local mode has no login of its own: never
   publish the port. `TASKCELL_HUB_ALLOW_ADD=1` enables Add project and Clone repository on a
   non-loopback bind (see [Modes](#modes) and [Coolify / Docker Compose](#coolify--docker-compose)).
   Reaching it under a hostname (rather than an IP address) needs that hostname allowed:
   `TASKCELL_HUB_ALLOWED_HOSTS=hub.example.com` (or `--allowed-host hub.example.com`).

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

- **Codex on a ChatGPT subscription** (`CODEX_AUTH_JSON`). A Codex run has no Anthropic-family
  credential for the hub's primary sidecar to hold, so the hub runs it without the proxy and the
  `auth.json` is forwarded into the sandbox verbatim. (The CLI's `--llm-proxy` keeps it on the
  host when the run also uses Claude, Z.ai or OpenRouter, or is a Codex-only `review-pr`/`review-mr`/`research`; see [boundaries](security/boundaries.md#host-llm-proxy).) The run still starts; tracked in #585.
- **Codex or Cursor on their own API key** (`CODEX_API_KEY`/`OPENAI_API_KEY`, `CURSOR_API_KEY`). Such a
  run consumes no Anthropic-family credential, so the proxy's primary sidecar has nothing to hold and
  cannot start; exporting `CLAUDE_CODE_OAUTH_TOKEN` as well does not change that, because the run never
  uses it. The key is injected into the sandbox and the run starts.
- **Direct-mode-only providers** — Meridian ([MERIDIAN-provider.md](MERIDIAN-provider.md)) and repo
  custom providers (`.taskcell/app.json` `customProviders`). They point the Claude CLI at their own
  endpoint and authenticate on that host, exposing no upstream a sidecar could target, so their key
  is injected into the sandbox. A custom provider's `keyEnv` must be a variable of its own: any name
  starting with `TASKCELL_` or `VANGUARD_` (reserved for Taskcell's own settings), and known credential
  names (the built-in providers', git hosts', and `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`,
  `OTEL_EXPORTER_OTLP_HEADERS` and the like), are refused in any letter case.

If the proxy's trusted sidecar itself fails to start — usually a missing or stale sandbox image, since
it runs inside `taskcell-sandbox:latest` like the egress enclave — the run fails fast rather than
silently falling back to direct mode or hanging. The run view shows: `Failed to start llm proxy
<id>: rebuild the sandbox image (docker/build.sh builds taskcell-sandbox:latest), or check
TASKCELL_SANDBOX_IMAGE if set.`

## Modes

- **Local mode** — no sign-in screen (the hub acts as one automatic owner user), binds `127.0.0.1` by default. Intended for running on your own
  machine, reachable only from itself.
- **Container mode** — binds `0.0.0.0` because Docker port-mapping requires it. Reached under a
  hostname, set `TASKCELL_HUB_ALLOWED_HOSTS=hub.example.com` (every hostname the browser uses,
  including a non-default port).

A hub bound beyond loopback is **server mode** and requires sign-in (see "Server mode sign-in" below).
Do not publish it on a raw port without TLS: put it behind Tailscale or an HTTPS reverse proxy.

### Server mode sign-in

Whenever the hub binds beyond loopback (`--host 0.0.0.0`, a LAN/Tailscale address, a hostname) — even
with a single user — every page and every RPC/SSE route requires a signed-in user. Sign-in is
[Better Auth](https://www.better-auth.com) mounted on the hub's own HTTP server under `/api/auth/*`;
its data (users, sessions, linked accounts) lives in `auth.sqlite` in the hub state dir
(`TASKCELL_HUB_CONFIG_DIR`) via Node's built-in `node:sqlite` — no native module. The schema is created
or migrated on start. The signing secret is `TASKCELL_HUB_AUTH_SECRET`, or a random one persisted to
`auth-secret` (mode 0600) in the same directory. Signed-out browsers requesting a page are redirected
to `/sign-in`; API calls (`/rpc/*`, `/events`) answer `401` (`sign-in required`, which the web UI turns
into a redirect to `/sign-in`; the top bar has a **Sign out** button). `auth.sqlite` is created mode 0600.

**Behind a reverse proxy on the same host.** A hub bound to `127.0.0.1` behind nginx/Caddy is still
reachable by everyone the proxy serves, so set `TASKCELL_HUB_SERVER_MODE=1`: the loopback bind then runs
in server mode (sign-in required, `add_project` and the other writes need `TASKCELL_HUB_ALLOW_ADD=1`).
Also set `TASKCELL_HUB_PUBLIC_URL` and `--allowed-host` to the public name.

**What the UI offers.** The web UI asks the hub `caller_capabilities` (`{ repoPath? }`, read-only) what
the signed-in caller may do, and disables each button the hub would refuse, with the hub's reason as its
tooltip: Add project, Enable factory, Create task (draft and starter task), Retry now, Save settings, the
Auto-merge mode switch, reply and merge, and the skill buttons (owner only). The commands still enforce
their own rules; when the capabilities cannot be read, the buttons stay open and the hub's refusal shows.

**Providers.** Each is enabled by the operator from env; a provider without both halves is hidden from
the sign-in page. Any enabled provider can sign in — one hub may hold GitHub and GitLab projects, and
Google is for people who only work on cards (e.g. Linear). Setup suggests the provider matching the
hub's repositories, but that is only a suggestion. (Apple arrives with the iOS app, #860.)

| Provider | Env vars |
|---|---|
| GitHub | `TASKCELL_HUB_AUTH_GITHUB_CLIENT_ID`, `TASKCELL_HUB_AUTH_GITHUB_CLIENT_SECRET` |
| GitLab | `TASKCELL_HUB_AUTH_GITLAB_CLIENT_ID`, `TASKCELL_HUB_AUTH_GITLAB_CLIENT_SECRET`, optional `TASKCELL_HUB_AUTH_GITLAB_ISSUER` (self-managed base URL, e.g. `https://gitlab.example.com`; default `https://gitlab.com`) |
| Google | `TASKCELL_HUB_AUTH_GOOGLE_CLIENT_ID`, `TASKCELL_HUB_AUTH_GOOGLE_CLIENT_SECRET` |

Also set `TASKCELL_HUB_PUBLIC_URL` to the URL users open: a bare origin such as `https://hub.example.com`
(a path or query is a startup error). It is the base of the OAuth callback URLs and must match the `Host`
you allow (`--allowed-host`). Unset, it falls back to the bind address — which a provider cannot
redirect to (`0.0.0.0`) — and the hub warns at startup when a provider is configured without it.

**Creating the OAuth apps.** The callback (redirect) URL is always
`<TASKCELL_HUB_PUBLIC_URL>/api/auth/callback/<provider>`, with `<provider>` = `github`, `gitlab` or `google`.

- *GitHub*: Settings → Developer settings → OAuth Apps → New OAuth App. Homepage = the public URL;
  authorization callback URL = `…/api/auth/callback/github`. Generate a client secret.
- *GitLab* (gitlab.com or **self-managed**): User Settings (or Admin → Applications for an
  instance-wide app) → Applications → Add new application. Redirect URI = `…/api/auth/callback/gitlab`;
  scopes `read_user`. Untick "Confidential" only if your GitLab version requires it. For a
  self-managed instance also set `TASKCELL_HUB_AUTH_GITLAB_ISSUER=https://gitlab.example.com`, and add
  that host to `TASKCELL_HUB_CLONE_HOSTS` if projects are cloned from it.
- *Google*: Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID
  (Web application). Authorized redirect URI = `…/api/auth/callback/google`; configure the consent screen.

**Sign-up allowlist.** Sign-up is not open. `TASKCELL_HUB_SIGNUP_ALLOW` is a comma-separated list that
decides who may *create* an account on first sign-in; anyone else is refused with "Sign-up is not open
on this hub". Entries: `alice@example.com` (an e-mail), `@example.com` (a domain), `github:login`,
`gitlab:login`. E-mail and domain entries only match an address the provider reports as verified. A
`gitlab:login` entry matches that login on whichever GitLab the hub is configured for. An empty list
means nobody can sign up (the hub warns at startup). Existing accounts are not re-checked on sign-in.

**Hub admins.** `TASKCELL_HUB_ADMINS` is a comma-separated list of hub admins named by sign-in identity, in the
same entry syntax as `TASKCELL_HUB_SIGNUP_ALLOW` (`alice@example.com`, `@example.com`, `github:login`,
`gitlab:login`). E-mail and domain entries only match a provider-verified address; `github:` / `gitlab:` match the
login the provider reported at sign-in, never a user-editable field. `--admin-github-login` (and
`TASKCELL_HUB_ADMIN_GITHUB_LOGINS`) keep working as one more `github:` entry each. What a hub admin may do is under
"Teams and roles". A user who has linked both GitHub and GitLab matches either login. A GitLab login is
recorded when the user signs in with GitLab, so a `gitlab:` admin entry matches from their next sign-in on. Without the token, a hub admin still cannot `browse_dirs` or `add_project`.

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
admin. A **hub admin** (see "Hub admins"), signed in, may without the token: manage the instance credentials and the
`per-user credentials` switch (everything the token holder may in Settings); `clone_project` from the hosts in
`TASKCELL_HUB_CLONE_HOSTS` (plus github.com and gitlab.com) when `TASKCELL_HUB_ALLOW_ADD=1`, cloned into `taskcell-repos/` under the
browse root (a folder name never starts with a dot) and added to the admin's team (`teamId`, default their first); and add and remove members from Settings. A hub admin is
admin of the teams they belong to, and of the default team while it has no members at all: on a fresh hub they add
the first member from the UI and are recorded in that team as its admin, after which the team is administered as usual. The token holder is the owner, admin of every team, and alone may
`add_project` / `remove_project` / `browse_dirs` (these reach the server's file system; a hub-wide remove also leaves every
team) and use the Fleet (Settings → Runners) commands; `clone_project` with a chosen parent folder is the owner's too. Token-only mode is unchanged: one default team, the token its admin.

*Adding the first members.* On a fresh server-mode hub the default team has no members, so signed-in users
see an empty hub until the owner adds them (the token, or a hub admin in Settings → Members):

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
with `--allowed-host <host[:port]>` (repeatable) or `TASKCELL_HUB_ALLOWED_HOSTS` (comma-separated).
Each value is matched against the `Host` header exactly, case-insensitively, so include the port
whenever the browser's URL has a non-default one. It takes a bare `host[:port]`, with the port between
1 and 65535: a scheme, a path, a wildcard, an unbracketed IPv6 literal or a non-numeric/out-of-range
port is a startup error, not a silent 403. `--host <hostname>` (a non-loopback, non-IP-literal name) is
seeded into the allowlist automatically, on the bound port, so the URL the CLI prints and opens is
never refused.

A **Tailscale MagicDNS name** (`host.tailnet.ts.net`) is a hostname, not an IP literal, so it needs
`--allowed-host host.tailnet.ts.net` / `TASKCELL_HUB_ALLOWED_HOSTS=host.tailnet.ts.net` like any other
hostname. A bare **Tailscale IP** (`100.x.y.z`) is an IP literal and needs no flag.

> **Upgrading:** before this allowlist existed, any `Host` reached the hub. A deployment reached by
> hostname — a Tailscale MagicDNS name, a reverse proxy's public name, a container's service name —
> now needs `--allowed-host`/`TASKCELL_HUB_ALLOWED_HOSTS` added, or it 403s. One reached only by IP
> literal or `localhost` needs no change.

The same-origin check (`sameOriginOk` in `src/hub/server.ts`) compares the request's `Origin` header
against its own `Host` header, not scheme, so the hub works behind an HTTPS-terminating reverse proxy
when `--allowed-host <public-host[:port]>` permits the public Host and the proxy preserves that header (including any
non-default port). Only HTTP(S) origins are accepted; the browser's `https://` Origin matches
the public `Host` even though the proxy connects to the hub over HTTP.

## Teams

A team is a name, members (login + role `admin` or `member`) and repositories, stored in `teams.json` next to `projects.json`. The first start creates a `Default` team holding every project; it mirrors the project list, so its repositories cannot be edited.

**Who is who.** A signed-in user is matched to a member by the provider login the hub stored at sign-up (`github:octocat` matches the member `octocat`; a GitLab member is added as `gitlab:<login>`, a bare login is always a GitHub login, so a same-named account on another provider matches nothing) — never by display name or e-mail, which the user controls. The owner (the hub token, or local mode) is an admin of every team.

**What a caller sees.** `list_teams` and `get_team` return the teams the caller belongs to, plus teams with no members (the default team until someone is added); the owner sees all. `list_runs_all`, `list_tasks_all` and `list_needs_you_all` are limited to those teams' repositories. Per-repository commands (`repoPath` arguments) are still guarded by the project allowlist only, not by team.

**Editing.** `team_add_member`, `team_set_role`, `team_remove_member`, `team_add_repository` and `team_remove_repository` need an admin and the same bind permission as `add_project`. The last admin of a team can be neither removed nor demoted.

**UI.** The team switcher sits at the top of the rail (a menu with more than one team, the plain name with one) and the choice is remembered in the browser. Home, Board, Runs and Needs you list the selected team's repositories. Settings has a Members section: an admin edits, a member reads.

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
(the hub also exits when the app's stdin pipe closes, `TASKCELL_HUB_EXIT_ON_STDIN_EOF=1`, so it is never
orphaned). Its project list lives in the app config dir (`TASKCELL_HUB_CONFIG_DIR`). Installed apps bundle a
Node runtime and the CLI; a source checkout (`pnpm start`) runs the TypeScript CLI — details in
[apps/desktop/README.md](../apps/desktop/README.md#local-hub-the-desktop-backend). To use a remote hub instead, see
[Connect the desktop app to a server](#connect-the-desktop-app-to-a-server).

Only this hub enables **Fleet** (`spawn_run`/`kill_run`/`list_spawns`, `TASKCELL_HUB_ALLOW_FLEET=1`, honoured on
a loopback bind only); every other hub rejects those commands.

**Add a repository from any folder.** The app's hub runs with `TASKCELL_HUB_BROWSE_ANYWHERE=1`: the Add-project
picker opens at your home directory, **Parent directory** goes up to the filesystem root (on Windows, one more step up lists the
drive roots, `C:\`, `D:\`, …), and the **Folder path** field opens any folder you type or paste (`D:\code\repo`, a
network share). A hub served to a browser keeps its browse-root limit.

**Hub variables from your shell are ignored.** The app starts its hub from a fixed set of `TASKCELL_HUB_*`
variables (`CONFIG_DIR`, `ALLOW_FLEET`, `BROWSE_ANYWHERE`, `EXIT_ON_STDIN_EOF`) and removes every other one it
inherited from the shell that launched it, so a `TASKCELL_HUB_TOKEN_FILE`, `ALLOWED_HOSTS`, `UI_DIR`, `ALLOW_ADD`,
`SERVER_MODE`, `BROWSE_ROOT`, `PUBLIC_URL`, `AUTH_*` or `SIGNUP_ALLOW` meant for a server hub never reaches it.
Five settings are kept because they are yours rather than the server's: `TASKCELL_HUB_SECRET`,
`TASKCELL_HUB_CLONE_HOSTS`, `TASKCELL_HUB_MAX_QUEUE`, `TASKCELL_HUB_WATCH_POLL` and
`TASKCELL_HUB_WATCH_INTERVAL_MS`. The old `VANGUARD_HUB_*` spelling of every hub variable is treated the same way: removed, or kept for
those five. Other variables (provider credentials, `PATH`) are inherited as before.

## Connect the desktop app to a server

Besides its own local hub, the desktop app can join a `taskcell hub` running on a VPS or NAS (server mode, see
"Server mode sign-in"), like a chat desktop client joining a workspace.

1. Run the server hub with sign-in enabled (a bind beyond loopback, or `TASKCELL_HUB_SERVER_MODE=1` behind a
   reverse proxy) and reach it over HTTPS.
2. In the app, open the **server switcher** at the top of the left rail (it shows **Local** by default) →
   **Add server…**. Enter a name and the hub URL (`https://hub.example.com`; no username or password in the URL).
   Plain `http://` is accepted only for `localhost`.
3. The window loads the server's UI. Sign in there (#617). Runs now execute **on the server**; the sign-in
   screen is shown only in this mode, and the server's team, shared-credential and audit-log features appear
   as the hub provides them. Fleet stays Local-only.
4. Switch between **Local** and any saved server from the same menu, with no restart. The local hub keeps
   running in the background; the trash icon removes a saved server (after a confirmation). From any page —
   even one without the rail, such as a sign-in page or a proxy error — **Server ▸ Switch to Local Hub**
   (Ctrl/Cmd+Shift+L) in the app menu takes you back. The app always starts on Local.

The app stores no password or token. You sign in on the hub's own page and the session cookie stays in the
webview's cookie store (the OS webview's per-app storage); `servers.json` in the app config dir holds only names
and URLs. A saved server's origin (and only that origin) may list saved servers and switch between them; adding
or removing a server is only possible from the Local UI.

If the server becomes unreachable, the window says "Lost connection to <name> — reconnecting…" and the app
retries every few seconds; when the server answers it reloads the page. Reconnecting only reloads the UI: no
request is replayed, so a run is never started twice.

## Env vars

| Variable | Default |
|---|---|
| `TASKCELL_HUB_HOST` | `127.0.0.1` |
| `TASKCELL_HUB_PORT` | `7777` |
| `TASKCELL_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `TASKCELL_HUB_CONFIG_DIR` | `$XDG_CONFIG_HOME/vanguard-hub` else `~/.config/vanguard-hub` |
| `TASKCELL_HUB_WATCH_POLL` | — |
| `TASKCELL_HUB_WATCH_INTERVAL_MS` | `2000` |
| `TASKCELL_HUB_SECRET` | — (32 bytes, base64: `openssl rand -base64 32`. When set, this operator-held key protects the [credential store](#per-user-provider-credentials); keep it stable across restarts and outside the config directory. It also decrypts the retired `<config dir>/.vanguard-hub/credentials.enc` once on start so its keys can move into the unified store. If migration cannot complete, the hub reports a value-free reason, keeps the legacy file and starts) |
| `TASKCELL_HUB_BROWSE_ROOT` | `$HOME` (where the Add-project picker opens, and the limit of what it can browse, add or clone into. A drive or share root such as `D:\` confines to that drive or share) |
| `TASKCELL_HUB_BROWSE_ANYWHERE` | — (`1` on a loopback bind without server mode lifts that limit: the browse root is then only where the picker opens. Set by the desktop app for its own hub) |
| `TASKCELL_HUB_ALLOW_ADD` | — |
| `TASKCELL_HUB_SERVER_MODE` | — (`1` = require sign-in on a loopback bind, for a same-host reverse proxy) |
| `TASKCELL_HUB_PUBLIC_URL` | `http://<host>:<port>` (server mode: the OAuth callback base) |
| `TASKCELL_HUB_AUTH_{GITHUB,GITLAB,GOOGLE}_CLIENT_ID` / `_CLIENT_SECRET` | — (provider hidden unless both set; see "Server mode sign-in") |
| `TASKCELL_HUB_AUTH_GITLAB_ISSUER` | `https://gitlab.com` |
| `TASKCELL_HUB_AUTH_SECRET` | random, persisted to `auth-secret` in the state dir |
| `TASKCELL_HUB_SIGNUP_ALLOW` | — (comma-separated e-mails, `@domains`, `github:login`, `gitlab:login`) |
| `TASKCELL_HUB_ADMINS` | — (comma-separated hub admins: e-mails, `@domains`, `github:login`, `gitlab:login`) |
| `TASKCELL_HUB_ALLOW_FLEET` | — (`1` on a loopback bind enables Fleet; set by the desktop app) |
| `TASKCELL_HUB_EXIT_ON_STDIN_EOF` | — (`1`: shut down when stdin closes; set by the desktop app) |
| `TASKCELL_HUB_ALLOWED_HOSTS` | — (comma-separated exact Host values, added to `localhost`/any IP literal on any port) |
| `TASKCELL_HUB_MAX_QUEUE` | `10` (runs that may wait behind the one running run; past it a new run is refused, and a [hub-board task](#hub-board-tasks-dependencies-and-start-dates) stays to do. The queue is in memory only: a hub restart drops queued runs) |
| `TASKCELL_HUB_CLONE_HOSTS` | — (comma-separated hosts, added to `github.com`/`gitlab.com`) |
| `TASKCELL_CHAT_ALLOWED_ORIGINS` | — (comma-separated origins a project's `chatBaseUrl` may use; doc chat refuses any other origin than `https://api.anthropic.com`, since the inherited credential is sent there) |

## Add project: existing folder or clone a URL

The **Add project** dialog has two modes:

- **Existing folder** — browse (`browse_dirs`, confined to the browse root) to a directory that's
  already a git work tree and add it, exactly as before. `add_project` applies the same browse-root
  confinement, so a project outside the browse root cannot be added. To add one outside `$HOME`
  (the default root), start the hub with `TASKCELL_HUB_BROWSE_ROOT` set to a directory containing it.
  The **Folder path** field jumps straight to a typed or pasted path, under the same limit; a leading
  `~` is the hub user's home (`~user` is not expanded), a relative path that does not exist under the
  hub's working directory is taken from the browse root, and a path outside the root is refused with the root named. The
  desktop app's own hub has no such limit (see [its section](#the-desktop-apps-local-hub)).
- **Clone repository** — paste a repository URL, pick the parent folder with the same browser, and
  optionally override the folder name (default: the repo name from the URL). The hub clones it under
  the chosen parent and adds it, so a fresh install or a VPS hub with nothing to browse yet doesn't
  need a shell on the host first.

`clone_project { url, parentDir, name? } -> Project` (hub-only, `HUB_ONLY` in `src/wire.ts`) backs the
second mode:

- The URL must be `https://` or `ssh://`/`git@` to `github.com`, `gitlab.com`, or a host listed in
  `TASKCELL_HUB_CLONE_HOSTS` — no local paths, no `file://`.
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

Gated exactly like `add_project`: loopback only, unless `TASKCELL_HUB_ALLOW_ADD=1` — a non-loopback
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
      - vanguard-hub-config:/config                # TASKCELL_HUB_CONFIG_DIR
      - taskcell-hub-state:/state                  # holds the token file (below)
    environment:
      GH_TOKEN: ${GH_TOKEN}
      TASKCELL_MAX_SANDBOXES: "1"
      TASKCELL_HUB_TOKEN_FILE: /state/hub.key      # same token across restarts and redeploys
      TASKCELL_HUB_ALLOWED_HOSTS: hub.example.com # every Host the browser uses; loopback only by default
      TASKCELL_HUB_PUBLIC_URL: https://hub.example.com # the URL users open; OAuth callbacks are built from it
      TASKCELL_HUB_AUTH_SECRET: ${HUB_AUTH_SECRET}   # signing secret; else a random one is kept in /config
      TASKCELL_HUB_AUTH_GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}         # at least one sign-in provider
      TASKCELL_HUB_AUTH_GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      TASKCELL_HUB_SIGNUP_ALLOW: you@example.com  # who may create an account; empty means nobody

volumes:
  vanguard-hub-config:
  taskcell-hub-state:
```

Open the public URL: the hub redirects every page to `/sign-in`, and after signing in you land in the
UI. The container binds beyond loopback, so there is no `/#token=…` launch URL to open. On first start
the hub creates `/state/hub.key`, the token for non-browser clients (the CLI, scripts); later restarts
keep it. Rotate it with
`docker compose exec vanguard-hub taskcell hub rotate-token --token-file /state/hub.key`, then restart
the hub.

**Upgrading an existing container hub.** Earlier versions were opened with the logged `/#token=…` URL.
Now every page redirects to `/sign-in` until you set `TASKCELL_HUB_PUBLIC_URL`, a sign-in provider
(`TASKCELL_HUB_AUTH_<GITHUB|GITLAB|GOOGLE>_CLIENT_ID`/`_CLIENT_SECRET`) and `TASKCELL_HUB_SIGNUP_ALLOW`
in the Compose file, then redeploy. Old bookmarks of the launch URL no longer work; bookmark the public URL.

Mounting the Docker socket is equivalent to root on the host — a process with access to it can start a
privileged container and read or write anything the host can. Only do this when you trust everything
that runs in this container. If you only ever need read-only access to Docker endpoints, use
[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) in front of the
socket instead of mounting it directly. The [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
is the usual reference for "don't mount the docker socket without justification."

## Needs you

The **Needs you** section at the top of **Home** (hub only; the old separate screen and its ⌘K entry now open Home there, and the count badges Home in the rail) lists what the factory is waiting on a human for in the current
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
names the PR's base branch (`baseRef`) and asks for a second click to confirm. The merge is pinned to the checked head commit (`--match-head-commit`). A PR with no required checks passes the check gate. The button sits on the Needs you card and in the Board card's quick view (a side panel; a bottom drawer on phones). "Ask for changes" stays `reply_needs_you`.

Replies and merges are a remote mutation, gated like `clone_project`: loopback only, unless
`TASKCELL_HUB_ALLOW_ADD=1`.

`start_task` labels an issue to start the factory on it; see [Starting the factory from the hub](cli.md#starting-the-factory-from-the-hub).

## Paused by a provider limit

When a run ends on a provider usage or rate limit, the issue or pull request gets `taskcell:rate-limited` (or the older `vanguard:rate-limited`) and a comment or review carrying a hidden `taskcell-rate-limited until=<ISO time> trigger="…"` marker; the scheduled `resume-rate-limited` retries it after that time. The Board's `list_tasks` / `list_tasks_all` read this from labels and the marker only (no model call) and return `paused: { reason: 'provider-limit', until?, trigger? }` on the card. The time comes from the newest valid marker by an author the scheduled resume also trusts: the GitHub Actions identity (`github-actions`), a login ending in `[bot]`, or a repository owner, member or collaborator; a marker from an outside commenter is ignored. Paused pull requests come from `gh pr list --label`, once per spelling of the rate-limited label, only for projects whose task source is GitHub; their cards open the pull request and offer no issue actions (skills, full page, Retry now). One `list_tasks` or `list_tasks_all` call reads markers for at most 30 paused cards in total, shared across repositories; the others still show as paused without a time. Paused-PR lists and marker reads are reused for 45 seconds per repository (expired entries are dropped on the next read; the read budget is still spent on a reused read), and a successful Retry now flushes that repository's entries.

- **Card and quick view / task detail:** "Paused: provider limit", with "retries automatically after HH:MM" in local time (the date is included when it is not today; "soon" once that time has passed; no time when the marker is missing).
- **Banner:** on the Board and on Home, one banner when at least one task of the shown repositories is paused: how many, the latest retry time, and what you can do (wait, or add credit / switch the model in Settings). No banner when none is paused.
- **Retry now:** `retry_paused_task` (`{ repoPath, number }`) ensures the recorded trigger exists, removes any stale trigger, adds the trigger, and only then removes the rate-limited label. A failed write leaves the hold in place and returns the reason; if only the final removal of the rate-limited label fails, the message says the issue was re-triggered. It has Start's rules: loopback only unless `TASKCELL_HUB_ALLOW_ADD=1`, GitHub issues only, refused for a closed or already-started issue; it also refuses an issue that is not paused, one with no marker from the factory, and a trigger that is not one of the project's. If the hold is removed meanwhile, it succeeds only when the issue was re-triggered: a run has already started (a started label is on the issue) or the recorded trigger was added since the first read; a trigger that was already there, or a hold a person removed, is refused with "no longer paused" and nothing is written. It is audited as `task-retry`.
- **Runs:** a run that ended on a provider limit shows "stopped: provider limit" instead of "failed" (`stoppedBy` on the run summary), including local, imported and metrics-branch CI rows. The flag is written from a typed provider/usage-cap signal at the point the stage stops; final text and crash diagnostics are never matched. If any failed stage in the same run lacks that flag, the run remains failed. Provider-limit stops do not enter the Failed / Needs you filters or project failure count, are not remembered as failed runs in retrospective memory, and `taskcell history` prints them as "paused: provider limit".

The views work at phone width (the quick view is a bottom drawer).

## Enable factory

**Enable factory** on a project card (hub only) turns on the GitHub Actions factory for that repo in
four steps, following [onboarding-another-repo.md](onboarding-another-repo.md)
(`src/hub/enable-factory.ts`). GitLab CI has its own flow, below; Linear shows as planned. **Self-hosted (watch)** is a read-only checklist, described under [Self-hosted (watch)](#self-hosted-watch). **Local hub** is the hub's own worker, described under [Local hub](#local-hub).

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

The dialog is a persistent per-project checklist: **callers PR opened → secret set → PR merged →
doctor passed**, saved in the hub's config dir (`factory/<hash>.json`, never inside the repo) so it survives closing the dialog
and restarting the hub (`src/hub/factory-checklist.ts`). While it is open it polls `factory_refresh`:
the secret step has a copy button and "Check again" (`gh secret list`, names only), the merge step
detects the merged PR on its own and links it, and the verify step dispatches the doctor and shows
the linked run's status live. The project card shows the state: not enabled, setting up (current
step), ready, or broken (the reason: a closed PR or a failed doctor run).

### GitLab CI

The dialog offers **GitLab CI** only when `origin` is on GitLab (gitlab.com, or the host named by `GITLAB_HOST`); `enable_factory_host` reports which host it is. For a GitHub project, or one with no remote, the row stays unavailable and says why. The hub does everything through `glab` (`src/hub/enable-factory-gitlab.ts`).

**What the hub needs.** `glab` on the `PATH` of the machine the hub runs on, signed in (`glab auth login`) as an account with at least Developer access to the project (push a branch, create labels, open an MR; Maintainer to see and set CI/CD variables). The Docker hub image (`docker/hub.Dockerfile`) ships a pinned, checksum-verified `glab` next to `gh`; sign it in inside the container, or pass `GITLAB_TOKEN` to it. A hub run from source needs you to install `glab` yourself. For a self-managed GitLab, start the hub with `GITLAB_HOST` set to the host of `origin`. The project needs a runner that allows the privileged `docker:dind` service.

**Step by step:**

1. On the project card, choose **Enable factory → GitLab CI**. The plan shows the project, the default branch, the signed-in `glab` user and the CI files. That user becomes the jobs' actor gate: the factory jobs run only in pipelines that this GitLab user starts.
   **Runner tags.** The plan has an editable **Runner tags** field (comma-separated; shown only while `.gitlab/taskcell.yml` is not yet on the default branch, since the hub never rewrites an existing jobs file). The hub pre-fills it from `default: tags` in the project's `.gitlab-ci.yml` (the top-level `default:` only; YAML aliases and `<<` merge keys are resolved, includes are not), so `default: tags: [docker, linux]` gives `docker, linux`. Edit or clear it: the value is written explicitly as a quoted list, `tags: ["docker", "linux"]`, under `.taskcell-base` in `.gitlab/taskcell.yml`, so it shows in the MR diff; an empty field writes no `tags:` key. Each tag must be non-empty, at most 255 characters, with no leading or trailing space and none of `,`, `"`, `\`, control characters or line separators (U+0085, U+2028, U+2029); at most 50 tags. Anything else is rejected. If the project's `default: tags` cannot be copied as is (a `!reference`, a scalar, a tag with a comma or quote), the field starts empty with a note to enter the tags by hand, never a shortened list that would widen the runners that take the jobs; the plan itself goes on, so a project whose jobs file is already on the default branch can still run the doctor. The jobs keep `inherit: default: false` and do not inherit the project's `default:`, so a later change to it never reroutes credential-carrying jobs to another runner; a project whose runners only take tagged jobs sets its tags here instead.
2. Click **Open merge request**. The hub adds the factory jobs (`templates/gitlab/taskcell.yml`: doctor, implement, review) as `.gitlab/taskcell.yml`, includes them from `.gitlab-ci.yml` (created if missing; an existing `include:` in any form gets one more entry), pushes only the branch `vanguard/enable-factory`, creates the routing labels and opens the MR. It never pushes CI config to the default branch. An MR opened from a fork with the same branch name is not mistaken for it.
   - If the plan says the CI file is **not edited automatically** (a custom CI/CD configuration file in the project settings, Auto DevOps with no `.gitlab-ci.yml`, or YAML the hub cannot parse), the MR adds only `.gitlab/taskcell.yml`. Add the line the plan shows, `- local: .gitlab/taskcell.yml`, under the top-level `include:` of the named file before merging. If the jobs file is already on the default branch, there is no MR to open: add the line, then open Enable factory again.
3. Copy the **Secret** command and run it in your terminal (bash or zsh). It asks for the Claude token without echoing it and stores it as the **masked and protected** CI/CD variable `CLAUDE_CODE_OAUTH_TOKEN` on that project (`glab variable set`, or `update` when it already exists, so the same command rotates the token). Protected means only pipelines on protected branches, such as the default branch, can read it. The hub never reads, prints or stores the value: it checks that the name exists with one body-less `HEAD` request. A Developer, or a group-level variable, is not visible to that check; a passing doctor marks the step done.
4. In **Settings → CI/CD → Variables**, add `GITLAB_TOKEN` (masked and protected): a project or personal access token that can read and comment on issues and MRs and push branches. The hub does not check it; the doctor does.
5. Review and merge the MR. The checklist notices the merge on its own.
6. Click **Run doctor**. The hub starts a pipeline on the default branch with `TASKCELL_DOCTOR=true` (`glab ci run`), follows exactly the pipeline that call created, and reads the `taskcell-doctor` job in it (all pages of the job list). Only that job passing marks the step done; a finished pipeline without it (the include is not wired, or another user started it) fails the step. GitLab runs every job without `rules:` in such a pipeline, so when your `.gitlab-ci.yml` has such jobs the dialog names them and asks for a second click, **Run doctor anyway**, before starting it. Jobs that come from your own includes are not listed. The hub re-checks the list when it starts the pipeline and refuses any job you did not confirm; it then shows the new list so you can confirm it.
7. To let the factory work, create a **Build → Pipeline schedules** entry owned by the same GitLab user with the variable `TASKCELL_SWEEP=true`; each run sweeps the issues labelled `ready for agent` and the MRs labelled `ready for taskcell review` (or the old `ready for vanguard review`). The hub creates no schedule.

The included jobs run only in pipelines started by that user with one of the two variables, so they never join your own pipelines. Each job builds the pinned Taskcell release (`TASKCELL_REF`, default `v1`) in a `node:24` image with a `docker:dind` service, on an amd64 or arm64 runner; `pnpm` and `glab` are pinned (`glab` by checksum), the template sets no global variables, puts the jobs in `test` (or the first stage of your `stages:` when it lacks `test`) and inherits nothing from your `default:` (not even `tags`) and none of your global `variables:` (if your runners only take tagged jobs, extend `.taskcell-base` with `tags:` in your `.gitlab-ci.yml`), points `glab` at your GitLab (`GITLAB_HOST: $CI_SERVER_HOST`) and keeps the two credentials out of the environment while it installs and builds. The `glab` download and its checksums are not exercised by CI; build `docker/hub.Dockerfile` and run a doctor pipeline on amd64 and arm64 after changing them. A self-managed GitLab on a non-default port is not supported (the host has no port, and the fallback pipeline URL is `https://<host>/…`).

Each step shows its state; the dialog polls the MR merge and the pipeline, "Check again" re-reads the variable and "Run doctor again" retries the pipeline. A project with no remote, a missing `glab`, no `glab` sign-in or no permission gets one plain sentence, not the raw command error. The same loopback / `TASKCELL_HUB_ALLOW_ADD=1` gate applies to apply and verify, and both are audited as `enable-factory`.

Apply and verify change the remote, so they are gated like `clone_project`: loopback only, unless
`TASKCELL_HUB_ALLOW_ADD=1`. The `gh` login must be able to push workflow files (classic `repo` and
`workflow` scopes), create labels, open a PR and dispatch a workflow.

### Local hub

**Enable factory → Local hub** turns the hub's built-in worker on for one project: for a project with no CI, the hub itself picks up work on a schedule (`src/hub/local-worker.ts`). The switch is **off by default**, per project, and is stored in the hub's config dir (`local-worker.json`, never in the repo), so a hub restart keeps it.

- **What it picks up.** Every scheduler tick (the same timer as the hub board), for a project with the switch on: a **GitHub Issues** project's open issues carrying the trigger label (`ready for agent`, or the project's configured `label`), oldest first, skipping issues the factory already claimed or parked (running, in review, waiting, rate-limited) and, as `taskcell watch` does, issues whose author is not a repo owner, member or collaborator or a GitHub App bot (a failed author lookup skips the issue and shows as the last error); or a **hub-board** project's tasks, through the board scheduler. Both start runs through the same run session as a run started by hand (same pipeline, credential policy and audit). An issue is handed over at most once per hub process, so a run that leaves the label behind is not retried in a loop.
- **Limit.** At most the project's parallel-run limit (its `concurrency`, capped by what the run session holds) are in flight for a project; a finished run frees a slot on the next tick.
- **Refusals.** The switch cannot be turned on, and the dialog says why, for a project with no task source, with a task source the worker cannot read (GitLab, Linear, GitHub Projects), a GitHub Issues project whose `origin` is not a github.com repository, or when the hub has no provider credential (its environment or an instance credential in Settings → Credentials; names only are shown). Turning it off always works.
- **Checklist and card.** The dialog shows the switch, whether a credential is present, the **doctor** result (`Run doctor` runs the same checks as `taskcell doctor --source github --github-repo <origin> --label <trigger>` against the project, on the hub's machine; a hub-board project has no doctor step) and the worker state. The project card shows it too: on or off, the last pick-up, and the last error (cleared by the next successful pick-up). Doctor is informational: it does not gate the switch.
- **Off.** Stops new pick-ups; a task that is already running is left alone.
- **Hub boards and the switch.** A hub-board project was always served by the board scheduler, whether or not it had a switch; that is unchanged. Only a switch explicitly turned **off** stops it, and pick-ups are shown on the card while it is on.

RPCs: `local_worker_state` (read), `local_worker_doctor` and `local_worker_set` (`{ repoPath, enabled }`); both are refused on a non-loopback bind without `TASKCELL_HUB_ALLOW_ADD=1`. `local_worker_set` is audited as `settings-change`; `local_worker_doctor` writes only the doctor result into the hub's own store and is not audited. Runs started by hand and the other run locations are unchanged.

### Self-hosted (watch)

Picking **Self-hosted (watch)** (`enable_factory_watch`, `src/hub/watch-worker.ts`) shows a checklist for a
worker *you* run with `taskcell watch`, on a server or any always-on machine with Docker. The hub starts and
installs nothing on another machine, and the RPC writes nothing (it is read-only, so it is not in the audit list).

**Which worker.** The checklist follows the project's task source (Settings → Task source; when none is set,
the code host of `origin`). The code host is read the same way as for the other run locations: GitHub means
`github.com`, GitLab means `gitlab.com` or the host in the hub's `GITLAB_HOST`.

| Task source | Worker | Needs `origin` on |
| --- | --- | --- |
| GitHub Issues | `--source=github --github-repo=<owner/repo>` | github.com |
| GitLab Issues | `--source=gitlab --gitlab-project=<group/project> --label=vanguard` | GitLab |
| Linear | `--source=linear --label=vanguard` (PRs go to GitLab when `origin` is on GitLab, else GitHub) | any |
| GitHub Projects | not generated: the hub does not know the project number; run `taskcell watch --source project --project <number>` by hand | github.com |
| Hub board | none: a watch worker cannot read the hub board; the hub runs those tasks itself | — |

The repository slug must look like `owner/repo` (GitHub) or `group/project` (GitLab) before it is put in the
command; a remote with anything else is refused with one sentence.

The checklist shows:

1. **Credentials**, by name only: `CLAUDE_CODE_OAUTH_TOKEN`, the token of the forge the runs publish to
   (`GH_TOKEN`, or `GITLAB_TOKEN` when `origin` is on GitLab, also for Linear), and `LINEAR_API_KEY` for Linear.
   Values never pass through the hub.
2. **Compose snippet** for this repository, in the shape of `docker/compose.yaml`: the same image, socket and
   clone mounts, `mem_limit: 1024m` and `VANGUARD_MAX_SANDBOXES: "1"`. A self-hosted GitLab adds `GITLAB_HOST`.
   **Or run it directly** gives the same worker as one `taskcell watch` command for a clone of the repository.
3. **Worker seen**: whether the hub can read a run record for the repository from the last 7 days that a
   `taskcell watch` worker wrote (`taskcell watch` stamps its records `trigger: "watch"`; hub-started and manual
   `taskcell run` records do not count). It answers *yes* (with the time), *not recently* (with the newest time),
   or *cannot tell* when it reads no such record. A worker on another machine writes its records into its own
   clone, so they show up only if they reach this hub's checkout; "cannot tell" is not proof the worker is down.
   Workers on a version from before the stamp also read as "cannot tell". **Check again** re-reads; **Back**
   returns to the run locations.

**Setting the worker up, end to end:**

1. On the worker machine, build or load the images (`docker/build.sh`; see [deploy.md](deploy.md#what-you-need-on-the-host)).
2. Make a deploy directory, clone the repository into `./target-repo` next to where the compose file will be,
   and let `git push` use the token: `git -C target-repo config credential."https://github.com".helper '!gh auth git-credential'`
   for GitHub ([deploy.md, step 4](deploy.md#4-clone-the-target-repo-the-nas-has-no-git-so-use-the-runner-image)), or
   `git -C target-repo config credential."https://<gitlab host>".helper '!glab auth git-credential'` for GitLab, with an
   `https://` clone URL (`glab` reads `GITLAB_TOKEN`; the runner image ships the same pinned `glab` as the hub image).
   Running the command directly instead of in the image needs `gh` or `glab` signed in, and for Linear
   `SKILLS_DIR` pointing at the linear-cli skills (the image sets `SKILLS_DIR=/opt/skills`).
3. Put the values of the listed credentials in a `.env` next to the compose file (`chmod 600`, never committed).
4. Copy the compose snippet into `compose.yaml` there and run `docker compose up -d`.
5. Check the log (`docker compose logs -f taskcell-watch`) for `watch[<source>]: polling every 120s`, then label
   an issue as [deploy.md, step 6](deploy.md#6-start-and-verify) describes. Back in the hub, **Check again**
   says *yes* once the worker's run records are in this checkout.

## Approver card

Project settings show an **Auto-merge** card (hub only; `src/hub/approver-card.ts`): the approver's current mode (from `.taskcell/approver.json` on the base branch: the configured `baseBranch`, else the branch `origin/HEAD` names, else `main`) and its 90-day scorecard, built from `decisions.jsonl` on the metrics branch and GitHub PR state like `taskcell stats --approver`. Only decisions for the project's own repository (its origin remote's `owner/repo`, compared case-insensitively) are read, so `gh` is never run against any other slug. From the version that added it, every decision also records the repository's node id (`repoId`), which survives a rename: the card matches on it, and counts records written under an old name (and id-less ones under a slug an id-bearing record used), so a renamed repository keeps its history. Older records, with no id anywhere, match on the slug alone. An origin `detectRepoSlug` does not read (an SSH host alias such as `git@github-work:owner/repo.git`, a GitHub Enterprise host) still gives the no-data card on purpose: the card's `gh` calls go to github.com, and guessing what an alias resolves to would read the wrong repository. The card never calls a model.

- **Off, Shadow, Act** open a pull request that sets `enabled`/`act` in the policy file; nothing changes until someone merges it. The mode is never written in place and the base branch is never pushed to. The change is made in a temporary git worktree, so your checkout (HEAD, index, uncommitted changes) is left alone, and one change runs at a time per repo. The fixed branch `vanguard/approver-mode` is reset on each request and its open PR is reused, with its title and body updated. The policy file keeps its formatting byte for byte; only the two top-level boolean values are rewritten in place (a missing `act` is added after `enabled`). The repo's commit and push hooks are skipped (`--no-verify`): the temporary worktree has none of its dependencies.
- **Off always works:** if the scorecard cannot be read, the PR is still opened and its body says so, so a failing `gh` or metrics read cannot keep the approver on.
- **Act is off by default** and is not offered while the hold on #939 stands (`ACT_BLOCKING_ISSUES`; empty it once #939 is closed), nor while the policy's `reviewAuthors` has no dedicated reviewer login (anything but `github-actions`); the card says to add the review App's login. Below the bar (30 correct APPROVEs in a row in one risk class) it also needs explicit confirmation.
- The change is audited as `approver-mode`, with the requested mode in the detail.
- Metrics-branch reads fetch the tip into a named ref (`refs/taskcell/tips/<remote>/<branch>`), not `FETCH_HEAD`, and fetches of the same branch in one hub process run one at a time, so concurrent hub requests do not blank each other's read.

## Audit log

Every state-changing action appends one JSON line to `<config dir>/audit.jsonl` (time, login or `token`, action, target, outcome `ok`/`refused`/`failed`): sign-in, project add/remove, clone, run start/queue/cancel (a hub-board task's start is logged under the task's owner), task start, paused-task retry, hub task create/schedule/retry, settings changes, team member and repository changes (`team-member-add`/`-remove`, `team-repository-add`/`-remove`; target `<team id>:<login or repository path>`), label migration with `apply: true` (`labels-migrate`), project watch/unwatch (`project-watch`, `project-unwatch`). Targets and detail are names only — never a credential value, token, cookie or URL userinfo/query. Each line is chained (sha256 of the previous record) and carries an actor and subject; the file rotates at 10 MB and rotated files are pruned after 90 days (at most 50 kept); `taskcell audit verify` checks the chain (see [audit.md](audit.md)). A line that cannot be written is reported to the caller instead of being dropped. Runs started from the hub carry `startedBy` in their records (shown in the Runs table). Admins read the log in the Audit view (`read_audit`); non-admins get 403. The owner (header token, or local mode) acts as the shared `token` admin identity; any other signed-in user is logged under their e-mail and is not an admin until roles land (`actorFor` in `createHubServer` overrides this).

## Issue history

The card's full page (the task detail) has a **History** section below the run history: every record of the
issue, oldest to newest, each with time, actor (person or `taskcell[bot]`), what happened and a link to its
source (run record, PR comment, audit line). At 390 px it is the same section in the bottom drawer's full
page, with no extra navigation. The card has no tabs. It is read by the `read_issue_history` command, a read
model over the audit streams, run records and the Git host (docs/audit.md § Issue history); the hub's own
audit lines are included for an admin only. A banner names any chain that did not verify, and entries from
sources without a chain are marked "no chain". The desktop app has no separate quick view yet, so there is no
"History" link to add there.

## `gh` auth

The hub shells out to `gh` for the Remote section (Settings → Runners) (listing GitHub Actions runs), CI-run import and
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
`TASKCELL_MAX_SANDBOXES=1` on a small host.

## Per-user provider credentials

Off by default: every run uses the instance credential (the hub's environment, or an instance
credential the hub owner or an admin saved). A **hub admin** — listed in `TASKCELL_HUB_ADMINS`, or a GitHub login in `--admin-github-login`
(repeatable) or `TASKCELL_HUB_ADMIN_GITHUB_LOGINS` (comma-separated) — can change the
`per-user credentials` switch in Settings (as can the hub owner):

| Setting | A run uses |
|---|---|
| `off` | the instance credential |
| `user-first` | per provider: the starter's own credential for the provider the run uses, else the instance credential for that provider |
| `user-only` | the starter's own credential for the provider the run uses; with none saved for it the run is refused before it is queued |

A hub-board task started by the scheduler counts its owner as the starter (see [Who a task runs as](#who-a-task-runs-as)).

Resolution is per provider: a user who saved only `OPENAI_API_KEY` runs Codex on their key and Claude on the
instance's `CLAUDE_CODE_OAUTH_TOKEN` (`credentialSource` records `user` / `instance` for the run's provider).
A run never receives keys of providers it does not use.

A run on the starter's own credential never reads the hub's provider keys: a provider whose key the user cannot save (a repo custom provider's `keyEnv`, meridian's `MERIDIAN_BASE_URL`) is refused for it.

When the switch is on, each signed-in user saves their own provider credentials in Settings. They are
keyed by the hub (Better Auth) user id — a GitHub, GitLab or Google user alike — and stored encrypted (AES-256-GCM) in `credentials.enc.json` in the hub
config dir. When `TASKCELL_HUB_SECRET` is set, that operator-held 32-byte base64 key protects this store as it protected the retired `credentials.enc`; keep the same value across restarts and outside the config directory. A store first written under `credentials.key` is re-encrypted under the secret on the next start and the stale key file is removed; the re-key waits until any retired `credentials.enc` has been migrated, so one secret always opens everything. Once the store is read or written under the secret the hub records that in `credentials.keyed` beside it (best effort), so after a restart a `credentials.key` plus store planted in the config directory is not adopted; a marker (planted or not) is never used as a key. With no usable secret the hub refuses to read a store, and to save, while a marker is present (with no `credentials.enc.json` a read returns empty and only the save is refused, with its own message that Settings also shows), and never deletes the marker; with a usable secret whose re-key waits for the `credentials.enc` migration, the marker is removed before the store is written under `credentials.key` again, and with no store file an existing `credentials.key` is replaced by a fresh one rather than adopted. **Upgrade note:** a save with no usable secret beside a marker is now refused (also with no store file) and a disk-key store beside a marker is no longer read. With a secret the hub also refuses a readable disk-key store beside a marker (for example a restored backup). Every such refusal names `credentials.keyed`, and removing that file (in the config directory) lets the store be read and re-keyed. A planted marker can lock the store out; that is accepted (see [security boundaries](security/boundaries.md#hub-credential-store-marker)), since anyone who can write the config directory can already delete the store. Anyone who can delete the marker can still plant a key, so keep the config directory write-protected. While a retired `credentials.enc` is unmigrated, saves into a store not yet under the secret stay under `credentials.key`, and Settings says so. A store that cannot be decrypted (a different secret value, or the secret removed) is never overwritten, and Settings and the setup guide say which key recovers it. Runs then start only on a provider key in the hub's start-up environment (with the switch `off` or `user-first`); a run that needs a stored credential is refused with that reason. A secret that is not 32 bytes is not used: the store stays on `credentials.key` and the reason is shown. Without it, the hub uses `credentials.key` (mode 0600, generated on first write) beside the store, so a copy of the config directory yields every saved key; keep it out of backups and shares. This is the hub's only credential store (instance and per-user). Credentials are write-only:
the hub lists which variable names are saved, never a value, and no RPC takes a user id, so one user
cannot read, overwrite or use another's. The switch and every instance-credential RPC (`get_credential_policy`, `set_credential_policy`, `instance_credentials_status`, `save_instance_credential`, `delete_instance_credential`) share one gate: the **hub owner** (the hub-token holder, or local mode) or an **admin**; anyone else gets 403. The token owner remains able to manage instance credentials so a token-only hub does not need a configured sign-in admin. The owner's writes (and the switch) are also refused on a non-loopback bind unless `TASKCELL_HUB_ALLOW_ADD=1`, as `set_credential` was. Saved instance credentials are passed explicitly to the provider-specific run and doc-chat child that consume them; the Fleet screen's spawns (any agent CLI) get every saved instance credential the same way. They are not exported into the hub process environment, so host-side `git`/`gh`/`glab` calls, which read none of them, do not inherit them. Removing a saved value makes those consumers fall back to the hub's start-up environment. Settings shows one Credentials panel, including a value-free migration/decryption reason when the store needs operator attention, and the run detail says which credential funded the run. The run record carries `credentialSource: 'instance' | 'user'`, never the value.

Admin and per-user credentials need a sign-in to identify the caller (`HubServerOptions.identify`); without a
signed-in user there is no admin (the hub owner still manages instance credentials) and no per-user credential.
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
| `--allowed-host <host[:port]>` (repeatable) | `TASKCELL_HUB_ALLOWED_HOSTS` (comma-separated, additive) | `localhost` / any IP literal on any port |
| `--host <addr>` | `TASKCELL_HUB_HOST` | `127.0.0.1` |
| `--port <n>` | `TASKCELL_HUB_PORT` | `7777` (1-65535; an invalid explicit `--port` is a startup error) |
| `--ui-dir <dir>` | `TASKCELL_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `--token-file <path>` | `TASKCELL_HUB_TOKEN_FILE` | unset: a fresh token per launch |
| `--no-open` | — | opens the printed URL (loopback: the launch URL `/#token=…`; server mode: the bare URL) in a browser unless passed |

A missing or unbuilt `--ui-dir` fails at startup, naming `pnpm --dir apps/desktop build`
(run `pnpm build:ui`) rather than failing on the first request. Binding a non-loopback host
requires sign-in (warning at startup if no provider or allowlist is configured) and disables `add_project`/`browse_dirs`/`clone_project`,
`enable_factory_apply`/`enable_factory_verify`/`enable_factory_start`, `reply_needs_you`, `merge_needs_you`, `set_task_skills`, `start_task` and `retry_paused_task` unless
`TASKCELL_HUB_ALLOW_ADD=1`. `SIGINT`/`SIGTERM` close the listener, every connected SSE client,
and the project file watchers.

Each launch mints a fresh token. RPC requests require `x-vanguard-hub-token` and a same-origin
`Origin` header (a request without one is rejected). The SSE stream never takes the token in its
URL: the UI first `POST`s `/events/session` with the header, and the hub answers with an HttpOnly,
`SameSite=Strict` cookie scoped to `/events` (an events-only secret, not the token) that the
`EventSource` sends on every connect and reconnect; a non-browser client can send the header on
`GET /events` instead. `/healthz` stays unauthenticated for container health checks and answers a
constant `{"ok":true}`. No route serves the token — not `index.html`, not `/healthz`. On a loopback bind the CLI
prints and opens a launch URL carrying it in the fragment (`/#token=…`), which browsers never send to
the server; the UI moves it into `sessionStorage` and strips it from the address bar, so a reload
keeps working but a new tab on the bare URL needs the launch URL again. A `#token=…` that turns up on
an already-open page is stored at once only when the tab has no token or the hub has refused the one it
holds; otherwise it is kept in memory and used only if the hub then refuses the held token. So a link in
a spec or a comment cannot replace a working token, and a launch URL pasted after a restart reconnects. The address also names the open
screen (`?screen=runs`), so a reload returns to it and Back/Forward move between screens. A hub bound beyond loopback
has no launch URL: browsers sign in at `/sign-in`, also behind a reverse proxy. Reaching the port is therefore not enough to drive the hub,
but the token is a launch secret, not per-user authentication: it does not replace authentication at
the reverse proxy. It is regenerated on every hub launch, so an already-open page must be given the
new launch URL once the hub restarts.

With `--token-file <path>` (or `TASKCELL_HUB_TOKEN_FILE`) the token persists instead: an existing file
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
GitHub Actions or GitLab CI. Only `http:` and `https:` addresses are passed on. Links open in a new tab.

## First-run setup guide

On a hub with no projects the app opens a "Get started" guide: Git host and tasks, model
credential, first repository. Detection is one read-only owner command, `setup_status`, that
returns booleans only (plus, when the credential store cannot be decrypted or migrated, a value-free
reason shown on the model step; saved credentials then count as absent). The model step is Done when a model credential is
present: for Claude, `CLAUDE_CODE_OAUTH_TOKEN` or one saved in Settings → credentials; for Codex,
`CODEX_AUTH_JSON`, `CODEX_API_KEY` or `OPENAI_API_KEY` (or a key saved in Settings → credentials). A
`codex login` sign-in alone does not count, because a hub run never reads `$CODEX_HOME/auth.json`
(default `~/.codex/auth.json`): the guide detects that the file exists (it is never read) and shows
the line that makes it usable, `export CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"`. The step has a Claude / Codex choice, shows only
that option's commands, and remembers the choice in the browser with the rest of the onboarding state.

An `export` line only takes effect for a hub started after it: the hub reads its environment at
start. After exporting, restart the hub (or save the key in Settings → credentials, where that
exists) and then press **Check again**.

## Choosing skills

Skills are picked automatically for a run. To make a task use specific ones, pick them in the hub:

- **On the card.** Open a card on the Board (its quick view; a bottom drawer on a phone). The **Skills** section lists the installed skills as checkboxes; tick the ones the task must use and press **Save skills**. The hub writes them to the task itself, as a `Skills: a, b` line in the issue body (GitHub, GitLab or Linear), so a run started later from the hub, from CI or by `taskcell watch` uses them too. Unticking everything removes the line. The card then shows `skills: a, b`. The card must belong to the project's own task source (and, on Linear, its team). A GitLab issue whose description has a line starting with a quick action such as `/close` is refused; edit its `Skills:` line on GitLab instead.
- **In the New Run form.** Under **Advanced**, the same checkboxes. Opened from a card, the card's skills are already ticked and appear in the command preview as `--skill <id>`; untick one and that run does not load it. What is ticked when you press **Run** is the run's whole hand-picked list. Opened without a card and with nothing ticked, the run reads the issue's own `Skills:` line.

The list comes from the hub's `SKILLS_DIR` plus the project's `.github/vanguard-skills/`, and hub runs on every task source (GitHub, GitLab, Linear) load and check against that same set, so a skill the picker offers is one the run accepts. When the list cannot be read (a missing `SKILLS_DIR` directory, a `skills.lock.json` mismatch) the picker says why instead of showing nothing; fix the directory (see [skills.md](skills.md)) and reopen it. A skill that is ticked but not installed is marked "(not installed)"; a run with it is refused before any model call, with the installed names.

A provider that cannot load skills still runs; the run shows a warning and its record carries the note. The same goes for a `Skills:` line in the issue that is not a list of skill ids: it is ignored, with a warning on the run.

Calls: `list_skills` (`repoPath`; read-only, not audited) returns the installed ids; `set_task_skills` (`repoPath`, `taskId`, `skills`) writes the card's line as the hub's own tracker identity and is audited as `task-edit`. `api_create_run` takes `skills`; an id that is not installed is refused before the run's sandbox context is created.

## Per-project flow and model precedence

**Picking a flow.** Settings → **Flow** (`flow` in `.taskcell/app.json`) lists the built-in flows and the repo's `.taskcell/flows/*.hcl`. Unset keeps the source's default flow. Every run the Hub starts for the project, board tasks and the local worker alike, runs with `--flow <name>`, so the `model`/`provider` set per stage in the Workflow editor take effect. The New Run and Fleet commands carry the same `--flow <name>`. An unknown or invalid name fails the run with the usual unknown-flow / invalid-flow message; it never falls back to the default.

**Precedence.** A stage's `model`/`provider` set in the flow beats the run-level `--provider-model`, `--review-model` and `--escalate-model` (a flow-pinned implementer is also not escalated on repair). A stage that leaves a field unset inherits the run-level value, as before. A model chosen by the Workflow editor therefore wins over the factory workflow's `provider-model` / `review-model` / `escalate-model` inputs.

**GitHub Actions factory.** The reusable `implement.yml` takes an optional `flow` input (empty = today's behaviour) that is passed as `--flow`, e.g. `flow: my-flow` under `with:` in your caller workflow. The flow file must be on the default branch the run checks out.

## Hub board: tasks, dependencies and start dates

A project whose task source is **Hub board** (Settings → Task source, `taskSource: hub` in `.taskcell/app.json`) has its tasks in the hub itself instead of a tracker. With such a project open (the project named in the top bar), the Board shows a **New hub task** form (title, what to do, blocked by and start date) in place of the tracker's **New Task**; a card's quick view has a **Schedule** section, and **Full page** shows the task's text. Projects on GitHub, GitLab or Linear are not touched by any of this: the hub-board commands refuse them and the scheduler never looks at them.

### Where tasks live

Tasks are stored in the hub's config directory, one file per project (`<config dir>/hub-tasks/<hash of the repository path>.json`, mode 0600), not in the repository. Nothing a checkout contains can add a task, change one or start a run: a repository that commits `.taskcell/app.json` with `taskSource: hub` only gets an empty hub board until someone creates a task through the hub. The file is keyed by the repository's resolved path, so moving the repository leaves its tasks behind. An edit appends one line (the task as it now is, or its removal) to a journal next to the store (`<hash>.journal.jsonl`, mode 0600, never through a link), so one change does not rewrite a large store; reads fold the journal in. The store is written whole only when there is none yet, when the journal ends in a line a crash cut short (that line is dropped), or when the journal would grow past the store (at least 64 KiB); then it goes to a fresh, exclusively created temporary file that is renamed over the store under a fresh generation id, and the journal is removed (journal lines carry the generation they were written under; lines of an older one, left by a crash before that removal, are skipped, never replayed). A store or journal that exists but cannot be read or parsed is an error on the Board and for the scheduler and is never overwritten; entries in the store that are not valid tasks are kept in the file, shown as one red card, and never run. A board holds at most 1000 tasks (a done task can be **archived** (`hub_task_archive`: appended to `<hash>.archive.jsonl` next to the store, never read back) or any task that is not running **deleted** (`hub_task_delete`) from its quick view, which frees room; the scheduler finds a board by reading only the head of each store, not parsing it); a title is at most 300 characters, the text 64 KiB, and a task is blocked by at most 50 others.

### Dependencies and start date

Each task has a **blocked by** list (ids such as `hub-1`, other tasks of the same project) and an optional **start date** (`YYYY-MM-DD`, read as 00:00 in the hub's time zone, or a full ISO instant with a zone). Both are edited under **Schedule** (`hub_task_schedule`, audited as `task-schedule`); `hub_task_create` adds a task (audited as `task-create`) and takes the same two fields, so a new task never starts before they are saved. A run whose verify failed, and a task whose run ended with the hub process, are marked `failed` (never `done`, so dependents do not start); a person presses **Retry**. The owner is re-read by id when a task starts: a deleted account, or one the sign-up allowlist no longer names, does not run, and the team check uses current membership. The owner (token) flag holds only while the stored id is still the hub owner's: a task created by the token owner stops running after a local/server mode switch or a recreated `auth.sqlite` (the stored owner id no longer resolves), and fails closed with "…save its schedule to run it as you"; saving its schedule makes the current caller its owner. The audit login and `startedBy` are the account's current ones.

The Board reads `list_tasks` through the same planner the scheduler uses (`src/hub/schedule.ts`), so a card always shows what the scheduler will do:

| Card says | Meaning |
| --- | --- |
| `blocked by hub-1` | a dependency is not done (a failed dependency never unblocks) |
| `waits until Tue 18.11 (Europe/Berlin)` | the start date is in the future; the hub time zone is named |
| `waits for a free slot` | ready, but the project already has as many tasks with the run session as it can hold |
| `starts next` | ready; the next scheduler pass hands it to the run session |
| `queued behind another run (position 1)` | handed over, waiting in the run queue; shown in **Queued**, not **Running** |
| `not started: …` | the last start was refused (no credential under `user-only`, a missing model credential on the hub, the run queue is full, the owner no longer reaches the repository); the task stays to do and is tried again on every pass |
| `failed: …` (red) | the run failed, was cancelled, was held back by the secret scan or a red base branch, or changed nothing, or its run ended with a hub restart; the reason is shown. **Retry** in the quick view (`hub_task_retry`) puts it back to do and clears its old result. A run whose verify failed on a delivered branch or pull request also offers **Accept result** (`hub_task_accept`), which marks it done without a second run (a Retry delivers a second branch or pull request) |
| `cannot start: …` (red) | a missing reference, a dependency cycle (`a → b → a`, also shown on tasks that wait behind the cycle) or an invalid date; the reason is shown and the task never starts |

The Board re-reads every board while the window is visible, so a card follows its task without a reload: a hub board every 5 s, a tracker board (GitHub, GitLab, Linear) and the all-repositories view every 20 s. A failed re-read keeps the cards (and any typed draft or reply, and an open quick view) on screen, shows **Not refreshed — retrying**, and is tried again on the next interval; in the all-repositories view this holds for each repository that could not be read, whose last good cards stay until a successful read of it or a reload.

### What the scheduler starts, and how many at once

Every 15 seconds the hub starts each task that is valid, has every dependency done and has reached its start date. A task without dependencies or a date starts as soon as there is room.

Hub runs go through the same run session as a run started by hand, and that session runs **one run at a time for the whole hub**, holds **one queued run per project** and at most `TASKCELL_HUB_MAX_QUEUE` queued runs in total. So a hub-board project has at most one task running and one more queued; the rest wait. Independent tasks therefore run one after the other, not side by side. The project's `concurrency` setting can lower this to 1 (nothing queued ahead) but cannot raise it. A start the session refuses is not a failure: the task stays to do with the reason on its card.

### Who a task runs as

A task runs as its **owner**: the person who created it, or the last one to save its schedule or retry it. At start the hub applies what `api_create_run` applies to a request: the owner's teams must still include the repository, the [credential policy](#per-user-provider-credentials) picks the credential (under `user-only`, an owner with none saved for the provider is refused, and the card says so), the admission is written to the audit log as `run-start` or `run-queue` under the owner's login (a refusal as `run-start` / `refused`, once per reason), and the run records carry the owner as `startedBy`. The provider is the project's `provider` setting. A client cannot start a hub run directly: the `hub` transport is not accepted by `api_create_run`.

### The run and its result

The run gets the stored title and text as its task, the way a tracker run gets an issue; no tracker is asked, so a repository with no remote works. It runs the standard implement, verify and review pipeline in the sandbox.

- **The repository has a github.com `origin`**: the branch is pushed and a pull request is opened, as for a GitHub issue. The task is done and its card shows the pull request address. The pull request's repository comes from that `origin` only: the hub process's `GITHUB_REPO` environment variable is not read for hub tasks, so one hub-wide variable cannot send every project's result to the same (possibly unrelated) repository.
- **Otherwise**: the result is committed on a local branch of the repository (`chore/taskcell-hub-<n>-<id>`), nothing is pushed, and the card shows `branch <name>`. Review and merge it yourself.

A task is **done** when its run delivered a result that passed verify, not when that result is merged (a delivered result whose verify failed leaves the task `failed` until you accept or retry it), so a dependent task starts from the base branch as it is then. Merge the first task's result before the next should build on it, or set a start date on the dependent.

### Restart

The run session's active run and queue live in memory, so no run survives a hub restart. On start the hub marks every task stored as running `failed` (its card says its run ended with the hub, and that it may already have pushed a branch or opened a pull request); a person presses **Retry**, so the work is never started twice on its own. While the hub runs, a task marked running that the hub holds no run for is marked the same way on the next pass. If the hub could not write the end of a run to the store, it keeps the real end and writes it on the next pass.

Cards from GitHub show the dependencies the issue body already reports (`Depends on #n`, `Start: YYYY-MM-DD`, see `src/tasks/dependencies.ts`); these are display only, GitHub's own gate still decides.


**Runs search.** The Board and Runs share one search box. A run has no title, so on Runs it matches the task id only, and a title search on the Board does not narrow Runs (both boxes say so). Looking titles up would cost a board read per Runs view, so this is a decision, not a gap.