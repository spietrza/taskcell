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
exact URL from the terminal rather than the bare address. The token lives only in the tab that opened
that link, so a new browser or tab opened by hand needs the link too; reloading does not help. A hub bound beyond loopback (server mode,
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
   `Queued K` (labelled `ready for agent`/`ready for spec`, not yet picked up), then `Waiting for you M`
   (the Board's Waiting for you filter, the same name as Home's section) — so it shows the CI backlog too. A `+` (`12+`) means the board holds only its first page of issues and the count is a
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
- **Direct-mode-only providers** — Anthropic-compatible endpoints: repo custom providers
  (`.taskcell/app.json` `customProviders`, e.g. a self-hosted proxy such as Meridian or CLIProxyAPI; see
  [MERIDIAN-provider.md](MERIDIAN-provider.md) as an example) and the legacy `meridian` alias. They point the Claude CLI at their own
  endpoint and authenticate on that host, exposing no upstream a sidecar could target, so their key
  is injected into the sandbox. A custom provider's `keyEnv` must be a variable of its own: any name
  starting with `TASKCELL_` or `VANGUARD_` (reserved for Taskcell's own settings), and known credential
  names (the built-in providers', git hosts', and `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`,
  `OTEL_EXPORTER_OTLP_HEADERS` and the like), are refused in any letter case. `keyEnv` may be omitted for
  a proxy that holds its own auth: a non-empty placeholder token is injected, the provider stays
  direct-mode only, and under `--egress` its host is allowlisted (an `http://` endpoint still cannot
  traverse the egress enclave). In the Hub, Settings lists these under "Anthropic-compatible endpoints
  (proxy)"; a project already saved with `provider: "meridian"` keeps working and shows as "Anthropic-compatible
  endpoint (MERIDIAN_BASE_URL)".

  **Only an OpenAI-compatible endpoint?** These providers drive the Claude CLI, which speaks only the
  Anthropic Messages API (`/v1/messages`). No provider talks to an OpenAI `/v1/chat/completions`
  endpoint (vLLM, LM Studio, Ollama's OpenAI API, a company LLM gateway) directly: `openrouter` uses
  OpenRouter's Anthropic-compatible API, and `codex` speaks OpenAI's Responses API. To use such an
  endpoint, put a proxy in front of it that translates to the Anthropic Messages API (for example LiteLLM
  or CLIProxyAPI) and add that proxy here as an Anthropic-compatible endpoint. Tool use and streaming then
  depend on how well the proxy and the model behind it handle the Claude CLI's requests, so try one run
  before relying on it.

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

### Mobile sign-in (device flow)

The iPhone app signs a member in with a device authorization flow (RFC 8628 shape); the owner token still works for single-user hubs.

1. The app calls `POST /api/device/code` and gets a secret `device_code` (kept in the app) and a short `user_code` (8 letters), which it shows.
2. The app opens `/device` on the hub's public URL (`TASKCELL_HUB_PUBLIC_URL`, never the request's own scheme) in the browser, and only when that page is http(s) on the same origin as the hub URL the app connected to: connect the app with the public URL. The member signs in as usual (same providers, same sign-up allowlist), **types** the code, reviews when it was requested (the page warns: only enter a code shown on your own phone) and approves with a CSRF-protected form POST. The CSRF cookie is `Secure` when the public URL is https. A `?user_code=` in the link is ignored: nothing is prefilled or approved by opening a link.
3. The app polls `POST /api/device/token` (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, `invalid_grant`) and, once approved, receives a hub session once. It sends it in the `x-vanguard-hub-token` header; the hub treats it as that member (teams, non-admin), never as the owner.

No custom-scheme redirect carries a session or token. Codes are single-use and expire after 10 minutes; at most 200 are pending at once, and at most 20 from one client address (IPv6 counted per /64; behind a reverse proxy set `TASKCELL_HUB_TRUST_PROXY=1` so the client address comes from the last `X-Forwarded-For` entry, otherwise every client shares the proxy's address and that is the limit for the whole hub; only set it when a proxy that overwrites/appends that header is the sole way in). `/api/device/code` and `/api/device/token` refuse requests carrying browser fetch metadata (`Sec-Fetch-Site`, or `Sec-Fetch-Mode: navigate`), so page script cannot run the flow itself. A member who types 5 wrong codes in 10 minutes is locked out of code entry until the window passes (the lockout is per member: one member cannot lock out the others). Mobile sign-in needs `TASKCELL_HUB_PUBLIC_URL`: without it `verification_uri` is the bind address and the app refuses it. Approval re-checks the allowlist, and so does every request made with the session. A member session lasts 7 days (Better Auth's default session length) and is not refreshed by use: after that the app shows "Session ended" and the member signs in again. The app's Disconnect calls `POST /api/device/revoke`, which deletes the session; so does the app when it drops a session it just received (sign-in cancelled, or `/api/device/me` refused it). Better Auth's `/api/auth/list-sessions` is disabled: it would hand every session token, the app's included, to page script. Pending codes live in memory: a hub restart drops them. Only sessions the device flow minted work as app credentials (their token has a `tcd_` prefix); a browser session's token is never accepted there.

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

**UI.** The team switcher sits in the top bar next to the brand as **name · team**: its menu lists the teams (with their people, or their projects on a local hub, which has the one **Default** team) and **Set up a new project** and the choice is remembered in the browser. Home (including Waiting for you), Board and Runs list the selected team's repositories. Settings → **Team & hub** (`?screen=settings&section=hub`) holds the hub-wide settings, apart from any project: the **Team** section (members and repositories of the selected team; an admin edits, a member reads), the per-user and instance credentials, and the setup guide. Team changes apply at once; they are not part of the project's Save.

## Wire format

The UI talks to the hub with `POST /rpc/<command>` (JSON body = the command's camelCase args, `{}` when
none) and listens on `GET /events` (SSE). A success answers `200 {"result": <value>}` (`null` for void
commands, `false` stays `false`); an error answers `400`/`404`/`500 {"error": {"message", "kind"}}` with
`kind` = `bad-request` or `internal`. `apps/desktop/src/transport.ts` unwraps `result` and rejects with
`error.message`, so both sides must keep this envelope.

**`src/hub-wire.ts` is the single source of truth for this envelope, the SSE frame shape, the hub
marker, the token's header name and the events-session path** — a zero-import module copied verbatim into
`packages/hub-client/src/hub-wire.ts` by `pnpm gen:wire`
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
2. In the app, open the **server switcher** in the top bar (it shows **Local** by default) →
   **Add server…**. Enter a name and the hub URL (`https://hub.example.com`; no username or password in the URL).
   Plain `http://` is accepted only for `localhost`.
3. The window loads the server's UI. Sign in there (#617). Runs now execute **on the server**; the sign-in
   screen is shown only in this mode, and the server's team, shared-credential and audit-log features appear
   as the hub provides them. Fleet stays Local-only.
4. Switch between **Local** and any saved server from the same menu, with no restart. The local hub keeps
   running in the background; the trash icon removes a saved server (after a confirmation). From any page —
   even one without the app's top bar, such as a sign-in page or a proxy error — **Server ▸ Switch to Local Hub**
   (Ctrl/Cmd+Shift+L) in the app menu takes you back. The app always starts on Local.

The app stores no password or token. You sign in on the hub's own page and the session cookie stays in the
webview's cookie store (the OS webview's per-app storage); `servers.json` in the app config dir holds only names
and URLs. A saved server's origin (and only that origin) may list saved servers (names only, no URLs) and switch between them; adding
or removing a server is only possible from the Local UI. A remote hub page can call only
`servers_list` and `servers_switch`.

If the server becomes unreachable, the window says "Lost connection to <name> — reconnecting…" and the app
retries every few seconds; when the server answers it reloads the page. Reconnecting only reloads the UI: no
request is replayed, so a run is never started twice.

## Env vars

| Variable | Default |
|---|---|
| `TASKCELL_HUB_HOST` | `127.0.0.1` |
| `TASKCELL_HUB_PORT` | `7777` |
| `TASKCELL_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `TASKCELL_HUB_CONFIG_DIR` | `$XDG_CONFIG_HOME/vanguard-hub` else `~/.config/vanguard-hub` (one hub per dir: a second hub on the same dir refuses to start, since it would mark the first one's live runs as interrupted) |
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
| `TASKCELL_CHAT_LOCAL_ORIGINS` | — (comma-separated origins of keyless local proxies, e.g. `http://192.168.1.20:3000`, the hub may fetch the model list from; link-local and metadata addresses are refused even when listed) |
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

## Home

Home is the landing screen, a command center built only from data the hub already serves. The main navigation (Home, Board, Runs, Settings) is in the top bar, and a tab bar at the bottom on a phone. The top bar has no project picker: Board and Runs choose repositories in their filter (entering a project from its Home tile sets it to that project; the choice is kept while you switch screens), Home always covers every project, and Settings and New card start with a **Project:** picker (not on the hub-wide Team & hub and Audit sections). **Settings** opens a menu of its sections (General, Line, Runners, Lessons, Skills, Team & hub, Audit); the address names the open one, `?screen=settings&section=line`, so a link or a reload lands on it. Until the waiting items, cards and runs first arrive, Home shows one loading skeleton in their place (no half headline, no empty floor). Top to bottom:

- **State sentence.** "N cards wait for you." and, under it, "M are moving, K paused by a provider limit." N is the length of Waiting for you (the number badging Home in the top bar). M counts cards in `claimed` or `running` that are not paused; K counts cards held by a provider limit (the factory retries them itself).
- **Waiting for you.** The list below. Review / Answer opens a row.
- **Cards can't start.** A red banner, shown only when a project has a card waiting for the factory (carrying the trigger label, still queued) and its runner is visibly broken: the Local hub worker is off, blocked, failing (its last pick-up error) or has no model credential, or the CI factory (GitHub Actions or GitLab CI) is `broken`. One line per project (three, then "and n more") with a button to the hub worker or factory checklist. Hub-board projects and self-hosted (`watch`) runners give no signal and are never listed. Worker and factory state are read when the project list changes, so the banner can lag a change made elsewhere.
- **Moving.** Cards that are claimed, running or paused (up to six; "See all N on the Board" opens the Board with the Running filter), plus any live local run no card explains. One sentence per row says where the card is on the six stations (Card, Spec, Cell, Gates, Review, PR) and what it does. A paused row reads "Paused · retries after 18:30". A row with a live local run opens that run; any other opens its project's Board.
- **Cards by station.** One row per project with an open card or a run in the last 7 days, busiest first: a strip of the six stations with a dot per open card (ink = on that station, red = failed gates, orange = also waiting for you), and the week's spend; a project with no open cards shows "No open cards · n runs this week" instead of the strip. Idle projects fold into "and n idle projects". A line under the rows names the stations: Card → Spec (plan) → Cell (the agent codes in a sealed sandbox) → Gates (your tests) → Review → PR.
- **Last 7 days** (right column): pull requests merged (distinct cards with a merged run in the window; by run time, not merge time), failed runs (a provider-limit stop is not a failure), runs that passed after extra attempts (`RunSummary.extraAttempts`: a stage needed another agent call and the run still passed; run records fold gate repairs, auto-resumes and fork variants into one count, so this is not a self-repair count) and spend (reported dollars only; runs with no cost data are left out). With nothing merged it says so and gives the run count and spend.
- **Team and factory** (right column, under Last 7 days): the newest events across the shown repositories, six at most: runs finished or failed (from run records, placed at the run's start time), and from the hub audit log runs started, cards created (a hub-board card by its id: "You created card hub-4"), pull requests merged and settings saved (key names only, never values) in the hub. Actions taken outside the hub (a merge on GitHub, a CLI run start) appear only as run outcomes.
- **Projects.** The project cards ("4 runs on 3 cards": the cards that have runs, not the board's open cards; open, remove, the Auto-run state that links to its setup in Settings → Line), and the first-run setup guide above them.

What each block reads: the sentence, Moving, the floor and the banner read `list_tasks_all` (every 60 s while the page is visible, and when the hub reports a change); Waiting for you reads `list_needs_you_all` (every 30 s); the week and the floor's spend read `list_runs_all` (on open and on a change, no timer); Team and factory reads `list_activity` (run records and the audit log, never a tracker; at most 30, scoped to the team like the other lists; on open and on a change, no timer); live runs read `list_active` only for projects the project list says are running. A card's station is the one mapping the Board's quick view uses (`src/stations.ts`). With no project in the selected team Home shows only the setup guide and the empty Projects state.

## Waiting for you

Formerly **Needs you**. The **Waiting for you** section on **Home** (hub only; the old separate screen and its ⌘K entry open Home there, and the count badges Home in the top bar) lists what the factory is waiting on a human for across the shown
repositories, using `gh` and labels only — no model call (`src/hub/needs-you.ts`). Each row has a caption naming what it is (**PR ready**, **Changes requested**, **Verify failed** in red, **Question**, or **Too vague** when the factory's last comment on the issue is triage's "too vague" notice), the title, the repository, PR or task number and target branch, a primary **Review** (or **Answer**) and **Open in GitHub**. Review / Answer opens the row to the factory's last comment, Merge and the reply box ("Ask for changes"); a card's question shows **Open the card** (its panel on the Board) and **Open the run** (the run that asked: its diff, transcript and gates) on the row itself, and the same question can be answered right there: in the run, in the card's panel and on its full page, each with a line on what the answer does next:

- Tasks (GitHub issues) at `needs info`.
- PRs at `vanguard:needs-human-review` or `vanguard:verify-failed`, or with a review requesting
  changes — unless they already carry `needs revision` (then it is the factory's turn).

Each item shows the factory's own last comment (its `gh` user, the CI identity, or a configured bot
login), redacted for secrets and rendered as plain text. Every list is filtered on GitHub's side and
capped at 100. The read is kept for 60 s per repository and shared with the Board's cards (the Board itself fetches no
comments; the open quick view reads its item's with `needs_you_comment`). Home's lists fetch the first 30 items' last
comments once per kept read, and a failed fetch drops just that comment, not the list. A failed GitHub read is kept for
15 s: the last good items come back flagged unchecked (a failure entry in `list_needs_you_all`, a "Could not check
whether this card waits for you" note in the quick view).

`reply_needs_you` posts the reply as the hub's `gh` user, then hands the item back to the factory:
a Task moves from `needs info` to the project's trigger label (`label` in `.taskcell/app.json`, else
`ready for agent`); a PR gets `needs revision`. Either way it leaves the list. An item that is no
longer waiting is refused with no comment and no label change. The `needs info` label itself is not
configurable here: a repo that runs the factory with a custom `--needs-info-label` shows no Tasks.

`merge_needs_you` merges a waiting PR with the repository's allowed merge method (squash, else merge
commit, else rebase). It refuses a PR that is not in the list and one whose required checks are not
all green, with a message the UI shows; the item leaves the list once merged. The UI's Merge button
names the PR's base branch (`baseRef`) and asks for a second click to confirm. The merge is pinned to the checked head commit (`--match-head-commit`). A PR with no required checks passes the check gate. The button sits in the opened Waiting for you row and in the Board card's quick view (a side panel; a bottom drawer on phones). "Ask for changes" stays `reply_needs_you`.

`rereview_pr` ("Review again" in the opened Waiting for you row and the phone's item sheet, shown with `canStartTask`) puts an open
PR back through review: it removes `taskcell:reviewed` and the review trigger and re-adds the trigger, in the spelling the repo has. It
refuses (no label change) a PR that is closed, from a fork, not on a factory branch, or carrying `taskcell:reviewing` or
`taskcell:revising`. The label is added as the hub's `gh` identity, not the person's, and the review starts only if that user is an allowed actor of the
repo's review workflow, which the hub cannot check. GitHub only; GitLab is out of scope. Audited as `pr-rereview`.

Replies and merges are a remote mutation, gated like `clone_project`: loopback only, unless
`TASKCELL_HUB_ALLOW_ADD=1`.

`start_task` labels an issue to start the factory on it; see [Starting the factory from the hub](cli.md#starting-the-factory-from-the-hub).

## Runs

**Runs** is a split view, like the Runs window on taskcell.dev: the list on the left, the open run on the right.

- **List.** One row per run: an avatar in the project's colour with its initials, the repository, the issue number (or card id) followed by the card title, a status chip (`running`, `PR open`, `merged`, `passed`, `failed`, `stopped: provider limit`) and the age; a running row spins its chip. The title comes from the board (a run record has none) and falls back to the task id when the board cannot be read. The filter bar above it is the one Board shares; the result pills (All results, Passed, Failed) and the count ("4 of 5 runs") sit in the same row. When the filters (the project tab included) hide the open run, a line says "<id> is hidden by your filters — Clear", as the Board does for an open card; Clear resets the filters and the project tab. Its source chips (GitHub, GitLab, Linear, Taskcell board) list only the sources the projects in view use, plus any a loaded row has; the chips sit after a "Card source" label; with one source there is a plain "Card source: …" label instead.
- **Run pane.** Header: the repository, the target branch (`baseBranch` of the run's records), the issue number, the total time (ticking while the run is live) and the status chip. Below it the task title, who started the run, and **Cancel** for a live run (it calls `api_cancel` with the run's id from the event log) or the pull request link for a finished one.
- **Stage line.** One card per stage the run actually has, in the order Sealed cell → Code → Tests → Review → Simplify → PR (the stage names follow the run's flow). Sealed cell is the sandbox container start; the hub logs it as its own stage, first in the run's `run-start` list. Tests and PR are shown from the start as pending ("Waiting") and fill in when the run reaches them. The tests (the verify gate) run between Code and Review and log no stage of their own: Tests is running once Code is done and has passed once Review starts (Review runs only on a green gate); its time is the gap between the two. Each card has its own duration. For a finished run the stages and durations come from its stage records; for a live run from the persisted [run event log](#run-event-log) (`read_run_events`), re-read on every hub event and on every change under `.taskcell`. The running stage is highlighted and shows a progress bar (a stage reports no percentage, so the bar is an activity indicator), stages not started yet are muted. Click a finished stage to read its log; the clicked card is outlined. The breadcrumb names an issue run by its number (`#11`), not the internal task id.
- **Log.** Under the stage line: the tail of the live session while the run is running; for a finished run the transcript of the picked stage (the last one, or the first failed one, to begin with). The run's full record (Overview, Spec, Diff, Transcript) follows below it.
- **Started by.** Shown only for a person: a signed-in user's login. The hub's shared identity (`token` in the audit log and the run records) and the local worker are not people, so the line is left out for them (also in a card's quick view).
- **Wide screens** open the running run, or else the newest finished one, by themselves. **Narrow screens** (under 768 px) show the list full width; opening a run shows the pane full width with a **Back to runs** button.

**Stations.** Board and Runs speak the line's six stations (Card, Spec, Cell, Gates, Review, PR; `apps/desktop/src/stations.ts`). The Board's columns are the stations: Card, Spec, Cell, Gates, **Review / PR** (one column for two stations, because a tracker card does not say whether its pull request exists yet; the header's tooltip says so and each card's mark shows which), then Done; a card sits in the column of its station and shows a small six-tick mark, red on a failed station (a verify failure is Gates, failed). **Where a card sits is decided once, by the hub** (`src/hub/card-view.ts`): `list_tasks` and `list_tasks_all` return each card with a `view` — its place (station index, failed, passed), its newest local run's state word and PR address, and its waiting Needs-you item. A card in Review or failed sits where its newest local run (by timestamp; CI-imported runs never count; `gh-owner-repo-904` and `gh-904` are one card) left it, any other card by its column (a CI-imported run still gives its card the pull request address, so a card whose run ran in CI waits on its PR and sits on the PR station); every view (Board in one or all repositories, Home's floor, the quick view, the phone's board) renders that answer and none joins runs to cards itself. `list_runs`, `list_runs_all` and `read_run` carry the same run `outcome` (state word and place), so a run page and its Runs row always read alike. The waiting items come from the Needs-you read, kept per repository for 15 seconds and shared by concurrent board loads; a reply, a merge, an answer or a hub card's Retry, Start or Accept drops it at once. Every project with a GitHub remote reads GitHub for it, whatever its task source (one comment budget across all repositories, as `list_needs_you_all`); a project without one gets only the questions from its run records. Each Runs row has the same mark: a merged run is past the line, an open pull request is on PR, a failed run is on the station of its last stage, a live run is in the cell. Above both, project tabs set the shared Projects filter in one click; they are the only project control. With six projects or fewer each one is a tab (All projects, then every project; "All projects" so it is not read as the triage pill All). With more, the tabs are the picked projects and those with cards, and **More…** opens the searchable multi-select over all of them; several picked light no tab and the More trigger reads "N projects". On a phone the Board shows one stage at a time: pick a stage (or All stages; the chips scroll under an edge fade and the picked one stays in view) and the cards stack in the desktop's order, Card first and Done last. `?screen=board&card=<id>` opens that card's quick view, and the address follows the open card. A done card whose newest run had a failed stage reads the same in both places: the Board card's warning chip ("delivered, but a stage failed (see Runs)") also heads the quick view's Progress as "Done · …", the station where that run stopped is marked failed, and its Latest run says what the run did ("stopped to ask" for a run that asked, as its Runs row does). Such a run waits on no answer: its Runs row reads "stopped to ask" in grey, not the orange "Waiting for your answer", its run page shows no question banner, and Runs' triage pills put it (like every run whose card is done) under **Merged**, where the Board puts its card, not under Waiting for you. The quick view's status chip reads **Queued** only for a card the factory has queued (the Board header's Queued count), else **Not started**. A running or claimed card's **Open the run** opens that card's live run on Runs.

A run started from the Board or New card switches to Runs by itself and opens in this split view, with the new run selected in the pane (there is no separate full-screen strip). When it ends, the pane swaps the live view for the finished record, with its test result and pull request. The run is listed from its start (run-start), before its first session file exists; while its sealed cell is still starting, the empty list reads "Starting the run…" instead of "No runs found". A run in the CI of the repository (metrics branch) has no local record: its row shows the pull request link and does not open.

The tab icon is the Taskcell cell logo (`apps/desktop/public/favicon.svg`, with `favicon.ico` as the fallback), served by `taskcell hub` from the UI build.

## Paused by a provider limit

When a run ends on a provider usage or rate limit, the issue or pull request gets `taskcell:rate-limited` (or the older `vanguard:rate-limited`) and a comment or review carrying a hidden `taskcell-rate-limited until=<ISO time> trigger="…"` marker; the scheduled `resume-rate-limited` retries it after that time. The Board's `list_tasks` / `list_tasks_all` read this from labels and the marker only (no model call) and return `paused: { reason: 'provider-limit', until?, trigger? }` on the card. The time comes from the newest valid marker by an author the scheduled resume also trusts: the GitHub Actions identity (`github-actions`), a login ending in `[bot]`, or a repository owner, member or collaborator; a marker from an outside commenter is ignored. Paused pull requests come from `gh pr list --label`, once per spelling of the rate-limited label, only for projects whose task source is GitHub; their cards open the pull request and offer no issue actions (skills, full page, Retry now). One `list_tasks` or `list_tasks_all` call reads markers for at most 30 paused cards in total, shared across repositories; the others still show as paused without a time. Paused-PR lists and marker reads are reused for 45 seconds per repository (expired entries are dropped on the next read; the read budget is still spent on a reused read), and a successful Retry now flushes that repository's entries.

- **Card and quick view / task detail:** "Paused: provider limit", with "retries automatically after HH:MM" in local time (the date is included when it is not today; "soon" once that time has passed; no time when the marker is missing).
- **Banner:** on the Board, one banner when at least one task of the shown repositories is paused: how many, the latest retry time, and what you can do (wait, or add credit / switch the model in Settings). No banner when none is paused. On Home a paused card is a row in Moving with "Paused · retries after HH:MM", the same hint line, and counts in the state sentence.
- **Retry now:** `retry_paused_task` (`{ repoPath, number }`) ensures the recorded trigger exists, removes any stale trigger, adds the trigger, and only then removes the rate-limited label. A failed write leaves the hold in place and returns the reason; if only the final removal of the rate-limited label fails, the message says the issue was re-triggered. It has Start's rules: loopback only unless `TASKCELL_HUB_ALLOW_ADD=1`, GitHub issues only, refused for a closed or already-started issue; it also refuses an issue that is not paused, one with no marker from the factory, and a trigger that is not one of the project's. If the hold is removed meanwhile, it succeeds only when the issue was re-triggered: a run has already started (a started label is on the issue) or the recorded trigger was added since the first read; a trigger that was already there, or a hold a person removed, is refused with "no longer paused" and nothing is written. It is audited as `task-retry`.
- **Runs:** a run that ended on a provider limit shows "stopped: provider limit" instead of "failed" (`stoppedBy` on the run summary), including local, imported and metrics-branch CI rows. The flag is written from a typed provider/usage-cap signal at the point the stage stops; final text and crash diagnostics are never matched. If any failed stage in the same run lacks that flag, the run remains failed. Provider-limit stops do not enter the Failed / Waiting for you filters or project failure count, are not remembered as failed runs in retrospective memory, and `taskcell history` prints them as "paused: provider limit".

The views work at phone width (the quick view is a bottom drawer).

## Enable factory (Auto-run)

A project card on Home shows one state, **Auto-run: on** or **off**, with a short reason when the CI factory is broken or setting up. A GitHub or GitLab project is on when the Local hub worker switch is on ("Auto-run: on · this hub") or the CI factory checklist is done ("· CI"). A hub-board project is on only when its worker switch is on; a project never switched is off. Clicking the state opens **Settings → Line, station 01 Card** (`?screen=settings&section=line&station=card`), where **Set up auto-run** opens the setup below (also ⌘K **Auto-run**).

**Set up auto-run** (the Enable factory flow, hub only) turns on the GitHub Actions factory for that repo in
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

1. In Settings → Line → Card, choose **Set up auto-run → GitLab CI**. The plan shows the project, the default branch, the signed-in `glab` user and the CI files. That user becomes the jobs' actor gate: the factory jobs run only in pipelines that this GitLab user starts.
   **Runner tags.** The plan has an editable **Runner tags** field (comma-separated; shown only while `.gitlab/taskcell.yml` is not yet on the default branch, since the hub never rewrites an existing jobs file). The hub pre-fills it from `default: tags` in the project's `.gitlab-ci.yml` (the top-level `default:` only; YAML aliases and `<<` merge keys are resolved, includes are not), so `default: tags: [docker, linux]` gives `docker, linux`. Edit or clear it: the value is written explicitly as a quoted list, `tags: ["docker", "linux"]`, under `.taskcell-base` in `.gitlab/taskcell.yml`, so it shows in the MR diff; an empty field writes no `tags:` key. Each tag must be non-empty, at most 255 characters, with no leading or trailing space and none of `,`, `"`, `\`, control characters or line separators (U+0085, U+2028, U+2029); at most 50 tags. Anything else is rejected. If the project's `default: tags` cannot be copied as is (a `!reference`, a scalar, a tag with a comma or quote), the field starts empty with a note to enter the tags by hand, never a shortened list that would widen the runners that take the jobs; the plan itself goes on, so a project whose jobs file is already on the default branch can still run the doctor. The jobs keep `inherit: default: false` and do not inherit the project's `default:`, so a later change to it never reroutes credential-carrying jobs to another runner; a project whose runners only take tagged jobs sets its tags here instead.
2. Click **Open merge request**. The hub adds the factory jobs (`templates/gitlab/taskcell.yml`: doctor, implement, review) as `.gitlab/taskcell.yml`, includes them from `.gitlab-ci.yml` (created if missing; an existing `include:` in any form gets one more entry), pushes only the branch `vanguard/enable-factory`, creates the routing labels and opens the MR. It never pushes CI config to the default branch. An MR opened from a fork with the same branch name is not mistaken for it.
   - If the plan says the CI file is **not edited automatically** (a custom CI/CD configuration file in the project settings, Auto DevOps with no `.gitlab-ci.yml`, or YAML the hub cannot parse), the MR adds only `.gitlab/taskcell.yml`. Add the line the plan shows, `- local: .gitlab/taskcell.yml`, under the top-level `include:` of the named file before merging. If the jobs file is already on the default branch, there is no MR to open: add the line, then open Set up auto-run again.
3. Copy the **Secret** command and run it in your terminal (bash or zsh). It asks for the Claude token without echoing it and stores it as the **masked and protected** CI/CD variable `CLAUDE_CODE_OAUTH_TOKEN` on that project (`glab variable set`, or `update` when it already exists, so the same command rotates the token). Protected means only pipelines on protected branches, such as the default branch, can read it. The hub never reads, prints or stores the value: it checks that the name exists with one body-less `HEAD` request. A Developer, or a group-level variable, is not visible to that check; a passing doctor marks the step done.
4. In **Settings → CI/CD → Variables**, add `GITLAB_TOKEN` (masked and protected): a project or personal access token that can read and comment on issues and MRs and push branches. The hub does not check it; the doctor does.
5. Review and merge the MR. The checklist notices the merge on its own.
6. Click **Run doctor**. The hub starts a pipeline on the default branch with `TASKCELL_DOCTOR=true` (`glab ci run`), follows exactly the pipeline that call created, and reads the `taskcell-doctor` job in it (all pages of the job list). Only that job passing marks the step done; a finished pipeline without it (the include is not wired, or another user started it) fails the step. GitLab runs every job without `rules:` in such a pipeline, so when your `.gitlab-ci.yml` has such jobs the dialog names them and asks for a second click, **Run doctor anyway**, before starting it. Jobs that come from your own includes are not listed. The hub re-checks the list when it starts the pipeline and refuses any job you did not confirm; it then shows the new list so you can confirm it.
7. To let the factory work, create a **Build → Pipeline schedules** entry owned by the same GitLab user with the variable `TASKCELL_SWEEP=true`; each run sweeps the issues labelled `ready for agent` and the MRs labelled `ready for taskcell review` (or the old `ready for vanguard review`). The hub creates no schedule.

**Comment trust.** GitLab notes carry no association, so the allowlist is the only trust boundary: the `doctor` and `watch` jobs pass `--feedback-authors` with the signed-in `glab` user's login. Without it every user who can comment on a labelled issue would be trusted. To trust more people, edit `.gitlab/taskcell.yml` and extend the comma-separated list (`--feedback-authors "alice,bob"`) on both commands; see `docs/comment-trust-pr-notes.md`. The hub never rewrites a `.gitlab/taskcell.yml` already on the default branch, so a project set up before this flag existed still runs `watch` and `doctor` without an allowlist: add `--feedback-authors "<login>"` to both lines by hand (not to `watch-mrs`, which rejects the option).

The included jobs run only in pipelines started by that user with one of the two variables, so they never join your own pipelines. Each job builds the pinned Taskcell release (`TASKCELL_REF`, default `v1`) in a `node:24` image with a `docker:dind` service, on an amd64 or arm64 runner; `pnpm` and `glab` are pinned (`glab` by checksum), the template sets no global variables, puts the jobs in `test` (or the first stage of your `stages:` when it lacks `test`) and inherits nothing from your `default:` (not even `tags`) and none of your global `variables:` (if your runners only take tagged jobs, extend `.taskcell-base` with `tags:` in your `.gitlab-ci.yml`), points `glab` at your GitLab (`GITLAB_HOST: $CI_SERVER_HOST`) and keeps the two credentials out of the environment while it installs and builds. The `glab` download and its checksums are not exercised by CI; build `docker/hub.Dockerfile` and run a doctor pipeline on amd64 and arm64 after changing them. A self-managed GitLab on a non-default port is not supported (the host has no port, and the fallback pipeline URL is `https://<host>/…`).

Each step shows its state; the dialog polls the MR merge and the pipeline, "Check again" re-reads the variable and "Run doctor again" retries the pipeline. A project with no remote, a missing `glab`, no `glab` sign-in or no permission gets one plain sentence, not the raw command error. The same loopback / `TASKCELL_HUB_ALLOW_ADD=1` gate applies to apply and verify, and both are audited as `enable-factory`.

Apply and verify change the remote, so they are gated like `clone_project`: loopback only, unless
`TASKCELL_HUB_ALLOW_ADD=1`. The `gh` login must be able to push workflow files (classic `repo` and
`workflow` scopes), create labels, open a PR and dispatch a workflow.

### Local hub

**Set up auto-run → Local hub** turns the hub's built-in worker on for one project: for a project with no CI, the hub itself picks up work on a schedule (`src/hub/local-worker.ts`). The switch is **off by default**, per project, and is stored in the hub's config dir (`local-worker.json`, never in the repo), so a hub restart keeps it.

- **What it picks up.** Every scheduler tick (the same timer as the hub board), for a project with the switch on: a **GitHub Issues** project's open issues carrying the trigger label (`ready for agent`, or the project's configured `label`), oldest first, skipping issues the factory already claimed or parked (running, in review, waiting, rate-limited) and, as `taskcell watch` does, issues whose author is not a repo owner, member or collaborator or a GitHub App bot (a failed author lookup skips the issue and shows as the last error); or a **hub-board** project's tasks, through the board scheduler. Both start runs through the same run session as a run started by hand (same pipeline, credential policy and audit). An issue is handed over at most once per hub process, so a run that leaves the label behind is not retried in a loop.
- **Labels.** A picked issue walks the same labels as under `taskcell watch`, so the board and GitHub show where it is: the trigger label is swapped for `taskcell:running` before the run starts (a failed swap starts nothing and shows as the last error), then for `taskcell:needs-human-review` when the run opens a pull request. Any other end removes `taskcell:running` and leaves the issue unlabelled until a person re-applies the trigger.
- **Limit.** At most the project's parallel-run limit (its `concurrency`, capped by what the run session holds) are in flight for a project; a finished run frees a slot on the next tick.
- **Refusals.** The switch cannot be turned on, and the dialog says why, for a project with no task source, with a task source the worker cannot read (GitLab, Linear, GitHub Projects), a GitHub Issues project whose `origin` is not a github.com repository, or when the hub has no provider credential (its environment or an instance credential in Settings → Credentials; names only are shown). Turning it off always works.
- **Checklist and card.** The dialog shows the switch, whether a credential is present, the **doctor** result (`Run doctor` runs the same checks as `taskcell doctor --source github --github-repo <origin> --label <trigger>` against the project, on the hub's machine; a hub-board project has no doctor step) and the worker state. The project card shows it too: on or off, the last pick-up, and the last error (cleared by the next successful pick-up). Doctor is informational: it does not gate the switch.
- **Off.** Stops new pick-ups; a task that is already running is left alone.
- **Hub boards and the switch.** A hub-board project is auto-run only while its switch is **on**; a never-switched project is off, like every other project, and adding a card only records a task. A card then reads `auto-run is off — start it by hand` until it is started by hand (`hub_task_start`, same owner, credential and audit gates as an auto-run start) or auto-run is turned on. **Behaviour change:** hub-board projects used to be served without ever being switched; existing ones now need auto-run switched on to start cards on their own. Pick-ups are shown on the card while it is on.

RPCs: `local_worker_state` (read), `local_worker_doctor` and `local_worker_set` (`{ repoPath, enabled }`); both are refused on a non-loopback bind without `TASKCELL_HUB_ALLOW_ADD=1`. `local_worker_set` is audited as `settings-change`; `local_worker_doctor` writes only the doctor result into the hub's own store and is not audited. Runs started by hand and the other run locations are unchanged.

### Self-hosted (watch)

Picking **Self-hosted (watch)** (`enable_factory_watch`, `src/hub/watch-worker.ts`) shows a checklist for a
worker *you* run with `taskcell watch`, on a server or any always-on machine with Docker. The hub starts and
installs nothing on another machine, and the RPC writes nothing (it is read-only, so it is not in the audit list).

**Which worker.** The checklist follows the project's task source (Settings → Card source; when none is set,
the code host of `origin`). The code host is read the same way as for the other run locations: GitHub means
`github.com`, GitLab means `gitlab.com` or the host in the hub's `GITLAB_HOST`.

| Card source | Worker | Needs `origin` on |
| --- | --- | --- |
| GitHub | `--source=github --github-repo=<owner/repo>` | github.com |
| GitLab | `--source=gitlab --gitlab-project=<group/project> --label=vanguard` | GitLab |
| Linear | `--source=linear --label=vanguard` (PRs go to GitLab when `origin` is on GitLab, else GitHub) | any |
| GitHub Projects | not generated: the hub does not know the project number; run `taskcell watch --source project --project <number>` by hand | github.com |
| Taskcell board | none: a watch worker cannot read the Taskcell board; the hub runs those cards itself | — |

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

## Line

**Settings → Line** is the factory as six stations (Card, Spec, Cell, Gates, Review, PR). Click a station to edit the `.taskcell/app.json` fields it owns:

| Station | Edits |
|---|---|
| Card | Trigger label (`label`) |
| Spec | nothing in the hub: it shows the tech-spec model (`--spec-model`; the flow's own `planner` stage is separate, set under Custom flows) and which flow the project runs with |
| Cell | Engine (`provider`), Budget cap per run (`budgetUsd`) |
| Gates | Verify command (`verifyCmd`) |
| Review | Review engine (`reviewProvider`) |
| PR | Default target branch (`baseBranch`), and the Auto-merge panel (Off, Shadow, Act; Act stays blocked as before) |

Card source, Runs on, Linear team key, parallel runs, usage cap, doc chat model and custom providers stay in General. The doc chat model is typed, or picked from a list; **Fetch models** asks the hub for the models the saved chat endpoint offers (`list_chat_models`): OpenRouter's public list when `chatBaseUrl` is OpenRouter or the project's provider is `openrouter`, `GET <baseUrl>/v1/models` for `chatBaseUrl` or a custom provider (with the key from the matching custom provider's `keyEnv`, read on the hub and never sent to the browser, and sent to an `https://` endpoint only: a plain-http endpoint such as a LAN proxy is asked without it; no redirects; 10 s timeout; the key goes only to an origin the operator allowed for chat (`api.anthropic.com` or `TASKCELL_CHAT_ALLOWED_ORIGINS`, the doc chat's rule), else the fetch is refused with an error and no request is made, and only on the hub owner's fetch: a team member's fetch asks without it; a keyless fetch is limited too: only to an allowed chat origin or an origin the owner lists in `TASKCELL_CHAT_LOCAL_ORIGINS` (a LAN proxy), else it is refused the same way with no request; link-local and metadata addresses (`169.254.x.x`, `fe80::`, `metadata.google.internal`) are always refused), else the built-in list. A failure shows a short reason, never the response body. Only the hub owner can change `chatBaseUrl` or `customProviders`: together they decide which host receives a key named by `keyEnv`, so a team member's save that changes either is refused (403); the member's other settings save as before. Rows the hub cannot change are shown as read-only facts: repairs (`--max-repair-iterations`, 2 by default), the model of the second repair (`--escalate-model`; an implementer whose model a flow sets is never escalated), the tech-spec model (`--spec-model`) and the review model (`--review-model`; a reviewer-stage model set in Custom flows wins over it) are CLI flags. The Budget cap field is empty for no cap; its "No cap" hint is not a value. Two rows are locked and can never be turned off: the secret scan of the outgoing diff, and dropped CI config edits.

**Publish** is the same save as General's Save: it writes `.taskcell/app.json` and does not commit it (the file is git-ignored). Auto-merge has its own save: a mode change opens a pull request. **What Publish writes** shows the file as it will be written, with URL credentials and unknown custom-provider keys masked. **Line history** lists the settings saves the hub recorded for the repository (who, when, which fields by their names on General and Line, such as "Gates · Verify command" for `verifyCmd`, and old → new values for the non-secret keys on the audit allowlist, from the hub audit log; saves made by hand or from the CLI are not in it). **Custom flows (advanced)** holds the flow picker and the flow editor (canvas, stages, models).

## Audit log

Every state-changing action appends one JSON line to `<config dir>/audit.jsonl` (time, login or `token`, action, target, outcome `ok`/`refused`/`failed`): sign-in, project add/remove, clone, run start/queue/cancel (a hub-board task's start is logged under the task's owner), task start, paused-task retry, hub task create (target `<repo>:<card id>`, so the Home feed names the card)/schedule/retry, settings changes, team member and repository changes (`team-member-add`/`-remove`, `team-repository-add`/`-remove`; target `<team id>:<login or repository path>`), label migration with `apply: true` (`labels-migrate`), project watch/unwatch (`project-watch`, `project-unwatch`). A successful sign-in, watch or unwatch repeats on every reconnect and screen visit, so it is logged once per actor and target every 10 minutes; their refusals and every other action are logged each time. Targets and detail are names only — never a credential value, token, cookie or URL userinfo/query. The one exception is an `app.json` save: its line also carries `changes` (old → new values) for the keys on an explicit allowlist (`SETTINGS_VALUE_KEYS` in `src/hub/audit.ts`: task source, run location, label, team, color, providers, flow, parallel runs, budget, usage cap, chat model, base branches). Commands (`verifyCmd`, `runCommand`), URLs (`chatBaseUrl`) and `customProviders` stay names only, and so does any key added later until it is reviewed onto the list. Each line is chained (sha256 of the previous record) and carries an actor and subject; the file rotates at 10 MB and rotated files are pruned after 90 days (at most 50 kept); `taskcell audit verify` checks the chain (see [audit.md](audit.md)). A line that cannot be written is reported to the caller instead of being dropped. Runs started from the hub carry `startedBy` in their records (shown on the Runs screen as "Started by" for a signed-in user; the shared `token` identity shows no "Started by" line). Admins read the log in the Audit view (`read_audit`; a table, and on a phone a stacked list with the outcome first); its Login column shows `token` as "hub token (owner)" and a refused sign-in's `unknown` as "unknown (not signed in)"; non-admins get 403. Members of a repository read its settings-change slice with `read_settings_history` (time, login, outcome, key names and the allowlisted old → new values; no actor or chain fields; live file only), which feeds the Line screen's history. The owner (header token, or local mode) acts as the shared `token` admin identity; any other signed-in user is logged under their e-mail and is not an admin until roles land (`actorFor` in `createHubServer` overrides this).

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
Waiting for you. Reading needs a token with `actions:read`, `issues:read` and `pull_requests:read`
(fine-grained PAT) or classic `repo` scope. Replying from Waiting for you also needs `issues:write` and
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

A run on the starter's own credential never reads the hub's provider keys: a provider whose key the user cannot save (a repo custom provider's `keyEnv`, the legacy `meridian` alias's `MERIDIAN_BASE_URL`) is refused for it, and so is a keyless custom provider (no `keyEnv`): it authenticates on the instance's own endpoint, which a user's own credentials must not borrow.

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

## Several Anthropic accounts, rotated on limits

Settings → Credentials has an **Anthropic accounts** section (instance accounts for the hub owner or an admin, and "Your Anthropic accounts" for each signed-in user when per-user credentials are on). Add up to **20 accounts per scope** (the instance scope is hub-wide; each user has their own 20; disabled ones count). Each has a name, a type — *subscription token* (`CLAUDE_CODE_OAUTH_TOKEN`), *API key* (`ANTHROPIC_API_KEY`) or *auth token (gateway)* (`ANTHROPIC_AUTH_TOKEN`) — and an on/off switch; you can rename, switch off, reorder and remove them. Secrets are write-only: stored encrypted on the hub, never returned by any RPC, and never shown again after saving. A store written by an older hub loads as one account per saved variable, named after the variable; the first save writes the new format, which an older hub binary cannot read.

- **Pick order.** List order: a run uses the first enabled account that is not cooling down ("fill one, then the next"). Reorder with the arrows.
- **Rotation.** An account that hits a provider usage or rate limit is cooled down until the limit's reset (one hour when none is named) and the run restarts on the next account in a fresh sandbox, so the sandbox and LLM proxy always hold exactly one credential. The run shows a warning naming both accounts (names, never secrets). Cool-downs live in `credential-cooldowns.json` in the hub config directory, in the same format as a model pool's `.taskcell/model-pool-cooldowns.json`; the file holds account ids and times only. A credential's accounts are exhausted before a model-pool entry or fallback moves on.
- **All accounts out.** The original limit error stands: a GitHub run parks as `rate-limited`, and a hub-board task stays todo with "all N Claude credentials are cooling down; the first resets at …" until the first reset. With *user first*, a user whose own accounts are all cooling is refused rather than moved onto the instance's accounts.
- **Where the name shows.** The run detail ("billed to the hub's account "Team key 2"") and `taskcell stats` (**BY CREDENTIAL**). Names are written to run records and `metrics.jsonl`, which may be uploaded as CI artefacts: do not put secrets or personal e-mail addresses in names.
- **Only Claude** has several accounts for now; other providers keep one value per variable.

**Terms caveat.** Anthropic's Claude Code terms say plan limits "assume ordinary, individual usage". Rotating several *subscription* accounts to get past limits may breach the Consumer Terms (see #1047); API keys are clearly allowed. So: a user scope allows at most one enabled subscription token, and the instance scope allows more only after you acknowledge this caveat when saving (Settings asks; the status then shows a warning while more than one is enabled). This is a recommendation, not legal advice. Hosted plans are API-key only; this change has no hosted-plan concept to enforce that.

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
`enable_factory_apply`/`enable_factory_verify`/`enable_factory_start`, `reply_needs_you`, `merge_needs_you`, `rereview_pr`, `set_task_skills`, `start_task` and `retry_paused_task` unless
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
a spec or a comment cannot replace a working token, and a launch URL pasted after a restart reconnects. Once the hub refuses a tab's token (it restarted), the tab stops calling it and shows the restart notice until a new launch URL arrives (pasted into its address bar, it reconnects and reloads the page), so an old tab left open does not fill the audit log with refused sign-ins. The address also names the open
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

## Adding skills from a repository

In Settings > Skills, **Add skill** lists the skills found in a pasted repository, grouped by parent folder (`skills/engineering`, `skills/in-progress`). **Select all** and **Clear** act on the whole list, each folder has a checkbox of its own (partly ticked shows as indeterminate), and the button counts what is ticked ("Add 12 skills"). The add opens one pull request in the project, so the skills show in the list only once it is merged and the hub's checkout is updated. The section's caption says this in plain words; **Pull checkout** does the update (`pull_checkout`, owner only, remote, audited as `settings-change`). It is fast-forward only and refuses, with the reason and no change, unless the checkout is on the project's default branch with a clean tree (untracked files count) and origin only moved ahead; it never switches branches. The button sits under **Waiting for merge** and shows when the list is empty; after a pull the list refreshes. Until then a notice keeps the pull request link and the skill names, and **Waiting for merge** lists the project's open skill-add pull requests (branch prefix `chore/taskcell-skills-add-`) from `list_pending_skill_prs`: read-only, owner only, GitHub projects only (other forges show none), one `gh pr list` per refresh. The names come from a hidden `<!-- taskcell-skills: a,b -->` marker that `skills add --pr` writes in the PR body (each name checked against the skill-name pattern, since the body is untrusted); a PR without the marker falls back to its title, which is cut at 100 characters.

## Choosing skills

Skills are picked automatically for a run. To make a task use specific ones, pick them in the hub:

- **On the card.** Open a card on the Board (its quick view; a bottom drawer on a phone). The **Skills** section lists the installed skills as checkboxes; tick the ones the task must use and press **Save skills**. The hub writes them to the task itself, as a `Skills: a, b` line in the issue body (GitHub, GitLab or Linear), so a run started later from the hub, from CI or by `taskcell watch` uses them too. Unticking everything removes the line. The card then shows `skills: a, b`. The card must belong to the project's own task source (and, on Linear, its team). A GitLab issue whose description has a line starting with a quick action such as `/close` is refused; edit its `Skills:` line on GitLab instead.
- **In the New Run form.** Under **Advanced**, the same checkboxes. Opened from a card, the card's skills are already ticked and appear in the command preview as `--skill <id>`; untick one and that run does not load it. What is ticked when you press **Run** is the run's whole hand-picked list. Opened without a card and with nothing ticked, the run reads the issue's own `Skills:` line.

The list comes from the hub's `SKILLS_DIR` plus the project's `.github/vanguard-skills/`, and hub runs on every task source (GitHub, GitLab, Linear) load and check against that same set, so a skill the picker offers is one the run accepts. When the list cannot be read (a missing `SKILLS_DIR` directory, a `skills.lock.json` mismatch) the picker says why instead of showing nothing; fix the directory (see [skills.md](skills.md)) and reopen it. A skill that is ticked but not installed is marked "(not installed)"; a run with it is refused before any model call, with the installed names.

A provider that cannot load skills still runs; the run shows a warning and its record carries the note. The same goes for a `Skills:` line in the issue that is not a list of skill ids: it is ignored, with a warning on the run.

Calls: `list_skills` (`repoPath`; read-only, not audited) returns the installed ids; `set_task_skills` (`repoPath`, `taskId`, `skills`) writes the card's line as the hub's own tracker identity and is audited as `task-edit`. `api_create_run` takes `skills`; an id that is not installed is refused before the run's sandbox context is created.

## Per-project flow and model precedence

**Picking a flow.** Settings → Line → Custom flows → **Runs with flow** (`flow` in `.taskcell/app.json`) lists the built-in flows and the repo's `.taskcell/flows/*.hcl`. Unset runs the standard flow (the Line shows "standard flow (no custom flow)"). Every run the Hub starts for the project, board tasks and the local worker alike, runs with `--flow <name>`, so the `model`/`provider` set per stage in the Custom flows editor take effect. The New Run and Fleet commands carry the same `--flow <name>`. An unknown or invalid name fails the run with the usual unknown-flow / invalid-flow message; it never falls back to the default.

**Starting from a built-in.** The Custom flows editor lists the built-in flows in a read-only **Built-in** group (the one the project runs on is marked *in use*). Selecting one shows its stages. **Duplicate to edit** asks for a name and writes `.taskcell/flows/<name>.hcl` from it, then opens it. Only a built-in whose copy would run exactly the same pipeline can be duplicated (today `flow-b`); the others say "This built-in can't be copied yet."

**Precedence.** A stage's `model`/`provider` set in the flow beats the run-level `--provider-model`, `--review-model` and `--escalate-model` (a flow-pinned implementer is also not escalated on repair). A stage that leaves a field unset inherits the run-level value, as before. A model chosen in the Custom flows editor therefore wins over the factory workflow's `provider-model` / `review-model` / `escalate-model` inputs.

**Model pool per stage.** In the Custom flows editor's stage panel, set **pool** to *on* to give the stage several `provider/model` entries with integer weights (**Add entry**, provider, model id, weight) instead of one model. It is saved as the stage's `model` in the flow file, e.g. `model = "claude/sonnet:3, codex/gpt-6-sol:1"`, so every Hub run and every factory run with `--flow <name>` uses it. Each run picks one entry by weight from a stable hash of the task's issue number (the same issue always gets the same entry); an entry recorded as out of quota (see [cli.md](cli.md#model-pools-per-stage)) is skipped until its reset. An entry on another provider pins the stage to that provider, under the same rule as the stage's `provider` field: a provider that owns the Claude CLI transport (zai, openrouter, meridian, customs) cannot be pinned per stage, and the run needs that provider's credential. A flow stage pool beats the run-level pools (`--provider-model` etc.) like any flow-set model. The run record shows the entry with pick `flow`, and `taskcell stats` compares the entries in **BY MODEL PER STAGE**. Run-level pools, quota skipping, the fallback order (`--fallback-provider` lists) and how to read the stats are in [cli.md](cli.md#model-pools-per-stage).

**GitHub Actions factory.** The reusable `implement.yml` takes an optional `flow` input (empty = today's behaviour) that is passed as `--flow`, e.g. `flow: my-flow` under `with:` in your caller workflow. The flow file must be on the default branch the run checks out.

## Hub board: tasks, dependencies and start dates

A project whose card source is **Taskcell board** (Settings → Card source, `taskSource: hub` in `.taskcell/app.json`) has its tasks in the hub itself instead of a tracker. With such a project open (the project picked in the Board or Runs filter, or in the "Project:" picker at the top of Settings and New card), the Board's **New card** button opens a card form above the board (title, what to do, blocked by and start date, with **Add card** and **Cancel**) instead of the tracker's new-card drawer; the form is closed until you ask for it and closes after a card is added; a card's quick view has a **Schedule** section, and **Full page** shows the task's text. Projects on GitHub, GitLab or Linear are not touched by any of this: the hub-board commands refuse them and the scheduler never looks at them.

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
| `auto-run is off — start it by hand` | the project's auto-run (Settings → Line → Card → Set up auto-run → Local hub) is off, so a card that would start next or wait for a slot waits for a hand start: `hub_task_start` (repoPath, id) marks the to-do task and the next scheduler pass starts it, only it, as the person who pressed Start |
| `queued behind another run (position 1)` | handed over, waiting in the run queue; shown in **Queued**, not **Running** |
| `not started: …` | the last start was refused (no credential under `user-only`, a missing model credential on the hub, the run queue is full, the owner no longer reaches the repository); the task stays to do and is tried again on every pass |
| `failed: …` (red) | the run failed, was cancelled, was held back by the secret scan or a red base branch, or changed nothing, or its run ended with a hub restart; the reason is shown. **Retry** in the quick view (`hub_task_retry`) puts it back to do and clears its old result. A run whose verify failed on a delivered branch or pull request also offers **Accept result** (`hub_task_accept`), which marks it done without a second run (a Retry delivers a second branch or pull request) |
| **Run with flow…** | on a hub-board card (desktop card panel and mobile item sheet; hidden without `canStartTask`): lists the repo's flows (built-ins and valid `.taskcell/flows/*.hcl`) and calls `hub_task_start` (to-do card) or `hub_task_retry` (failed card) with `flow: <name>`. The hub refuses an unknown name before the card changes and lists the valid ones; the scheduler then runs that flow instead of the project's configured one. Without `flow` the configured flow runs as before. The audit line of the start/retry carries `flow.<name>`; the run detail shows the flow from the run's `run-start` event |
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
- **Otherwise** (no remote, or an `origin` that is not on github.com, **a GitLab one included**): the result is committed on a local branch of the repository (`chore/taskcell-hub-<n>-<id>`), nothing is pushed, and the card shows `branch <name>`. Review and merge it yourself. A hub task does not open a GitLab merge request on purpose, unlike a Linear task (which follows `origin` to GitLab): the hub's approver and pull-request bookkeeping read GitHub pull requests, and a GitLab merge request would also need `glab` signed in on the machine that runs the task, so it is not a contained change. Use a GitLab issue source if you want merge requests.

A task is **done** when its run delivered a result that passed verify, not when that result is merged (a delivered result whose verify failed leaves the task `failed` until you accept or retry it), so a dependent task starts from the base branch as it is then. Merge the first task's result before the next should build on it, or set a start date on the dependent.

### Restart

The run session's active run and queue live in memory, so no run survives a hub restart. On start the hub marks every task stored as running `failed` (its card says its run ended with the hub, and that it may already have pushed a branch or opened a pull request); a person presses **Retry**, so the work is never started twice on its own. While the hub runs, a task marked running that the hub holds no run for is marked the same way on the next pass. If the hub could not write the end of a run to the store, it keeps the real end and writes it on the next pass.

Cards from GitHub show the dependencies the issue body already reports (`Depends on #n`, `Start: YYYY-MM-DD`, see `src/tasks/dependencies.ts`); these are display only, GitHub's own gate still decides.


**Search.** The Board and Runs share one search box ("Search title, #issue or id"). It matches a card or run by its title, `#issue` number, task id and the tracker's labels (Taskcell's own routing labels such as `ready for agent` or `taskcell:*` are left out). A run record has no title or labels, so Runs takes them from the board's tasks the Runs screen already reads; a run whose task is no longer on the board matches by id and `#issue` only.
## Push notifications

The mobile app registers an Expo push token per hub user (`register_push_token { token, platform }`, `unregister_push_token { token }`; no RPC takes a user id, so a user only registers or removes their own tokens; each is audited as `push-register` / `push-unregister` without the token). Tokens live in `<config dir>/push-tokens.json`.

Once a minute the hub lists "Needs you" across its repositories and, for each item that is new (PR ready, question, too vague, changes requested), sends one push per registered token of a user whose teams include the repository, through `https://exp.host/--/api/v2/push/send`. The title is `<kind>: <title>`, the body the repository; the data holds only the item id and repository name — no token, secret or diff text. Items already notified are remembered in `<config dir>/push-notified.json`, so a restart does not notify again. The first pass after a token is registered only records what already waits. A token Expo reports as `DeviceNotRegistered` is dropped.

Optional: set `TASKCELL_EXPO_PUSH_TOKEN` to an Expo access token (sent as a bearer header, never logged); without it the hub sends unauthenticated, which Expo allows.

## Slack: agent questions

The hub can post each new agent question (a card whose agent stopped to ask, or a non-vague `needs info` issue) to one Slack channel, in addition to "Waiting for you" and push. A reply in the question's Slack thread can answer it (see "Answering from Slack" below).

Setup:

1. Create a Slack app (api.slack.com/apps, "From scratch") in your workspace.
2. Under *OAuth & Permissions* add the bot token scope `chat:write` and install the app to the workspace.
3. Copy the *Bot User OAuth Token* (`xoxb-…`) and invite the bot to the channel (`/invite @your-app`); copy the channel's ID (channel details → bottom).
4. Start the hub with `TASKCELL_SLACK_BOT_TOKEN=xoxb-…` and `TASKCELL_SLACK_CHANNEL=<channel id>`. The feature is off unless both are set. Set `TASKCELL_HUB_PUBLIC_URL` so each message links to the hub.

The hub reads the token once at start and removes it from its environment, so no child process (runs, doc-chat, Fleet) inherits it; it is never logged. On the push tick (once a minute) each question not yet posted is sent with `chat.postMessage`: project, title, the question (truncated to 3000 characters) and the hub link. Text is posted literally (`mrkdwn` off, `&`, `<`, `>` escaped, `link_names` off), so a question cannot mention people or `@channel` or inject links. Posted items are recorded in `<config dir>/slack-threads.json` (item key → channel, message `ts`, repo path, id and kind; last 5000), so a restart does not repost. When Slack answers `ok: false` (for example `not_in_channel` or a wrong channel id) the warning names Slack's `error` code and the question is posted again on the next tick; after a timeout or network error it is not retried, because the message may have been posted.

**Visibility:** the channel sees questions from every project on the hub, including projects a channel member cannot see in the hub. Use a channel whose members may read all of them.

### Answering from Slack

A reply in the Slack thread of a posted question becomes the answer. Server mode only (hub user ids exist only with Better Auth); in local/token mode the feature stays off and the hub logs one line.

1. In the Slack app enable *Socket Mode* and create an app-level token (`xapp-…`, scope `connections:write`). The hub opens an outbound websocket, so a hub behind NAT needs no public endpoint.
2. Add the bot scopes `channels:history` (public channel) and/or `groups:history` (private channel), subscribe to the `message.channels` / `message.groups` bot events, and reinstall the app.
3. Start the hub with `TASKCELL_SLACK_APP_TOKEN=xapp-…` and `TASKCELL_SLACK_USERS=U123=<hubUserId>,U456=<hubUserId>` (Slack user id → hub user id). Like the bot token, the app token is read once and removed from the environment.

Only a plain reply (no edit, delete or bot message) in the configured channel, in the thread of a posted question, counts; the text is capped at 10000 characters and handled like an answer typed in the hub. The mapping is the trust boundary: an unmapped Slack user gets one thread note and nothing is answered, and a mapped user always acts as that hub user with a non-owner caller, through the same `reply_needs_you` command the UI uses (repository visibility, the write gate and the `needs-reply` audit line apply). Replies are handled one at a time, so a second reply to an answered question gets the refusal note. A refusal the hub states as a bad request or forbidden (already answered, project not visible, writes disabled) is posted as one thread note with the hub's message (secrets redacted); any other error gets a generic note. The client acknowledges each envelope, ignores a duplicate `event_id` and reconnects with a 1 s to 60 s backoff.

**The answer is posted to GitHub as the hub's identity**, not as the Slack user: anyone mapped can write to GitHub issues and PRs they can see in the hub through the hub's credentials.
