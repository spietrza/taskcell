---
name: setup-taskcell
description: Guide a user through installing and running Taskcell, a self-hosted software factory (CLI taskcell), on their own machine, on a server for a team, or in GitHub Actions or GitLab CI, step by step with a check after each step. Use when someone asks to set up, install, self-host or try Taskcell, or pastes github.com/spietrza/taskcell and asks for help running it.
---

# Set up Taskcell

Taskcell turns a ticket into a pull request: it checks the ticket is clear, builds the change with a coding agent inside a Docker sandbox, has a second model review it, runs the repository's tests, and opens a PR or MR for a human to merge. Source and docs: https://github.com/spietrza/taskcell

You are guiding a person through the setup. Work in the order below. Ask, do one step, check it, then go on. Do not hand them a wall of commands.

## Rules

- **Secrets.** Never print, echo or paste a token, write one into a committed file, or put one on a command line where it lands in shell history. When a secret is needed, tell the person which variable to set and let them type it (`read -rs VAR && export VAR`, their secret manager, or a `gh`/`glab` command that prompts). Check only that the variable is set: `test -n "$VAR" && echo set`.
- **Human steps.** Stop and wait when a step needs the person: creating an OAuth app, a DNS record, a token, paying for a server, merging a PR. Say exactly what to click or type and what value to copy back, and wait until they confirm it is done.
- **Their repository.** Do not push to its default branch, and do not merge a pull request for them. Taskcell opens PRs; a human reviews and merges.
- **Check, don't assume.** After each step run its check. When a check fails, fix that before the next step; the table at the end lists the common failures.
- **Versions.** Use the latest release tag unless the person needs something only on `main`. Hub sign-in (a hub on a server) and the Hub board task source are on `main` until 1.16.0 is released; check with `git tag --sort=-v:refname | head -1` after cloning.

## 1. Ask first

Ask these one at a time, in plain words, and keep the answers. Skip one the person already answered.

1. **Where should it run?**
   - *This computer*: try it on one repository, runs start from the terminal or a local web board. Path A.
   - *A server for a team*: one hub that teammates sign in to from a browser. Path B.
   - *CI*: runs inside GitHub Actions or GitLab CI when an issue gets a label; nothing to keep running. Path C.
2. **Where is the code?** GitHub, GitLab.com, or a self-managed GitLab (ask for its address).
3. **Where are the tasks?** Issues in that same GitHub or GitLab project, a Linear team, or Taskcell's own Hub board (tasks kept in the hub, no tracker needed; Path A with the hub, or Path B).
4. **Which model account?** A Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`, made with `claude setup-token`, uses the plan, no per-token bill), an Anthropic API key (`ANTHROPIC_API_KEY`, billed per token), or another provider: Codex (`--provider codex`, `CODEX_API_KEY`, or `CODEX_AUTH_JSON` for a ChatGPT subscription), Cursor (`CURSOR_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`).

Then say back in two lines what you will set up, and start.

## 2. Requirements (Paths A and B: on the machine that runs Taskcell)

Check each, and install only what is missing, after asking:

```sh
node --version        # 24 or newer
pnpm --version
docker info --format '{{.ServerVersion}}'   # Docker installed and running
git --version
```

Plus the tracker CLI, signed in: `gh auth status` for GitHub, `glab auth status` for GitLab (a self-managed GitLab also needs `GITLAB_HOST=<its host>`), `linear auth login` for Linear (or `LINEAR_API_KEY`). The Hub board needs none.

## Path A: this computer

```sh
git clone https://github.com/spietrza/taskcell.git && cd taskcell
git checkout "$(git tag --sort=-v:refname | head -1)"   # or stay on main, see Versions
pnpm install && pnpm build
docker/build.sh            # builds the sandbox image taskcell-sandbox:latest; takes a few minutes
pnpm link --global         # puts taskcell on PATH
```

**Check:** `taskcell --version` prints a version, and `docker image inspect taskcell-sandbox:latest >/dev/null && echo ok`.

The person sets the model credential in their shell (see Rules). Then, with the source from question 3:

```sh
cd /path/to/their/clone && taskcell doctor --source github --github-repo owner/repo
```

For GitLab issues use `--source gitlab`, for Linear `--source linear`; `taskcell doctor --help` lists the flags each one takes.

**Check:** every line passes. Fix each failure, then run it again. `taskcell doctor --fix` installs the agent CLI version the repo pins into the image.

**First run.** Ask the person for one small issue with acceptance criteria (an `## Acceptance criteria` heading with a checklist). A vague issue is parked with the label `needs info` before any model is called. Then, with a local clone of their repository:

```sh
taskcell run --github owner/repo#42 --repo /path/to/their/clone --llm-proxy
# --gitlab group/project#42, or --linear ENG-7
```

`--llm-proxy` keeps the real model key on the host; the sandbox gets a one-run nonce and an allowlisted network. **Check:** the run ends with a link to a PR (ready for review when every gate passed, a draft when one did not). Run records are in `.taskcell/runs/` in their repository; make sure `.taskcell/` is in its `.gitignore`.

**Keep it running** (optional): `taskcell watch --source github --github-repo owner/repo` picks up issues labelled `ready for agent` (build it) or `ready for spec` (write a spec first, then build), and PRs labelled `needs revision`.

**Local board** (optional, and the way to use the Hub board): `pnpm build:ui && taskcell hub --repo /path/to/their/clone`. Open the exact URL it prints (`http://127.0.0.1:7777/#token=…`); the bare address has no token. For the Hub board, choose Settings → Task source → Hub board, then add tasks with **New hub task**. Start the hub from the shell that has the model credential set: the hub passes its environment to runs. Never publish this port: a hub on `127.0.0.1` has no sign-in.

## Path B: a server for a team

Use `scripts/hosted/setup-server.sh` on a fresh Ubuntu 24.04 server (2 vCPU and 4 GB run one task at a time). Full reference: `docs/deploy.md`, "Recipe D". Do the human steps first:

1. **Server.** The person rents it and gives you its IP address and root SSH access. Do not choose or pay for one for them.
2. **Name.** They pick a hostname (e.g. `taskcell.example.com`) and add a DNS `A` record pointing at the server's IP. **Check:** `dig +short <name>` prints that IP.
3. **Sign-in app.** They create an OAuth app with the provider their team signs in with. Callback URL: `https://<name>/api/auth/callback/<github|gitlab|google>`.
   - GitHub: Settings → Developer settings → OAuth Apps → New OAuth App; homepage `https://<name>`.
   - GitLab (gitlab.com or self-managed): User Settings → Applications → Add new application, scope `read_user`.
   - Google: Cloud console → APIs & Services → Credentials → OAuth client ID (Web application).
   They keep the client ID and secret for the next step; you never need to see the secret.
4. **Who may sign up.** A comma-separated list: `github:login`, `gitlab:login`, `alice@example.com` or `@example.com`.

Then, as root on the server (the person runs it, or you run it over SSH with the secrets typed by them, not by you):

```sh
curl -fsSLO https://raw.githubusercontent.com/spietrza/taskcell/main/scripts/hosted/setup-server.sh
HUB_DOMAIN=taskcell.example.com SIGNUP_ALLOW=github:alice \
  GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... bash setup-server.sh
```

Use `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET` or `GOOGLE_…` instead for those providers; for a self-managed GitLab add `GITLAB_ISSUER=https://gitlab.example.com` and `CLONE_HOSTS=gitlab.example.com`. To keep the secret out of shell history, put the variables in a file with mode 600 and `set -a; . ./file; set +a` before running the script.

**Check:**
- `curl -sI https://<name>/` answers `302` to `/sign-in`.
- `curl -s -o /dev/null -w '%{http_code}' https://<name>/rpc/list_projects` prints `401`.

If HTTPS fails, the DNS record has not propagated yet or ports 80 and 443 are blocked by the provider's firewall.

**In the browser:** the person signs in, then:
- adds the model credential under Settings → Credentials (the hub stores it encrypted; it never reaches the sandbox);
- clones their repository with **Add project → Clone repository**;
- picks the task source in Settings.

For GitHub repositories the hub also needs `gh` signed in inside the container: `docker compose -f /opt/taskcell/compose.yaml exec taskcell-hub gh auth login`. For GitLab, sign in `glab` the same way.

The script also sets up a daily backup at 03:15 UTC into `/var/backups/taskcell` (7 days kept). Tell the person this does not survive losing the server. The off-site copy is set with `BACKUP_S3_URL`, `BACKUP_S3_KEY`, `BACKUP_S3_SECRET` and `BACKUP_PASSPHRASE`; see `docs/deploy.md`.

## Path C: CI (GitHub Actions or GitLab CI)

Nothing runs on the person's machine after setup. The easiest route is the hub's **Enable factory** dialog: start a local hub (Path A, local board) on a clone of their repository and click **Enable factory** on the project card. It:
1. opens a PR (GitHub) or an MR (GitLab) that adds thin caller workflows pinned to Taskcell's `v1`;
2. creates the routing labels;
3. shows the one command that stores the model token as a CI secret (`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/repo`, which prompts for the value);
4. runs the doctor workflow after the person merges.

Manual route: `docs/onboarding-another-repo.md` (GitHub Actions) and `docs/hub.md`, "GitLab CI". On GitHub, the repository setting "Allow GitHub Actions to create and approve pull requests" must be on (Settings → Actions → General).

**Check:** the doctor workflow or job passes. Then label one small issue `ready for agent` and watch the run; it ends with a PR.

## When something fails

| Symptom | Cause and fix |
|---|---|
| "Failed to start egress enclave" | The sandbox image is missing: `docker/build.sh`. |
| First run fails at start with no model output | The shell (or the service) that started Taskcell has no model credential. Set it there and restart. |
| Issue relabelled `needs info` | Triage found no acceptance criteria. Add an `## Acceptance criteria` checklist (English heading) and relabel. |
| Doctor: `gh`/`glab` not signed in | `gh auth login` / `glab auth login` on the machine that runs Taskcell (inside the container for Path B). |
| Self-managed GitLab not recognised | Set `GITLAB_HOST` to its host, and use the real hostname in `origin`, not an SSH alias. |
| Hub answers "host not allowed" | Reaching it under a name it does not know: set `TASKCELL_HUB_ALLOWED_HOSTS=<name>` (the server script sets it). |
| "Sign-up is not open on this hub" | The person's login or e-mail is not in `SIGNUP_ALLOW`. Add it to `/opt/taskcell/.env` and run the script again. |
| A run edited CI config and the change vanished | By design: Taskcell drops agent edits to `.github/workflows/`, `.gitlab-ci.yml` and `.gitlab/`. A human makes those edits. |

## Done

The setup is done when one real issue has become a pull request the person can review. Tell them what you set up, where its configuration lives, how to start it again, and which label starts the next run.
