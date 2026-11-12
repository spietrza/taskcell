# Product

<!-- impeccable:product-schema 1 -->

Scope: the Taskcell Hub UI in `apps/desktop`, shipped as the Tauri desktop app and served in a
browser by `taskcell hub`. The CLI, the GitHub Actions workflows and the landing page
(`landing/`) are separate surfaces with their own context.

Facts come from `README.md`, `docs/hub.md`, `docs/design/brief.md`, `landing/src/index.html` and
the code. Lines marked **(assumption)** were inferred while writing this file and have not been
confirmed by the maintainer; confirm or correct them before relying on them.

## Platform

web

(Tauri 2 webview on macOS plus the same bundle in a desktop browser via `taskcell hub`. Not a
native design language: the UI is React + Tailwind v4 + the `chunks-ui` kit in both shells.)

## Users

- **The factory operator.** A developer who runs Taskcell, an autonomous software factory: a
  labelled issue on GitHub, GitLab or Linear goes to a coding agent in a sealed Docker sandbox, is
  reviewed by a second model, has to pass the repo's verify command, and comes back as a pull
  request a human merges. The hub is where that developer watches runs, reads why one failed,
  starts or drafts tasks, and checks spend.
- Two working styles, both from `docs/design/brief.md`:
  - **Unattended.** Tasks are filed as issues and picked up in CI. The hub is used read-only, at a
    glance, sometimes from a narrow window or a phone (self-hosted hub behind Tailscale). Wants
    high-signal status and failure reasons fast.
  - **Hands-on.** Runs the factory locally, watches live transcripts, inspects diffs and proof of
    work, launches runs and drafts tasks from the app.
- **(assumption)** The operator is technical and fluent in git, PRs, CI and terminal output; the UI
  does not need to explain those concepts, only Taskcell's own ones.

## Product Purpose

Make the factory legible. Turn "why did this run fail, what did it cost, what is it doing now" from
reading JSON under `.taskcell/runs/` into a glance, and let the operator act on it: open the PR,
re-run, draft the next task, enable the factory on a repo.

Success: the operator trusts what the factory did without opening the raw records, and spots the
run that needs a human within seconds.

## Positioning

Taskcell treats the agent as untrusted: no repository token in the sandbox, host-side gates, a
secret scan of the outgoing diff, and a human merge. The hub is the window onto those gates (proof
of work, review, verify result, cost per run), not an agent chat front-end.

## Operating Context

- Runs against a local `.taskcell/` directory (desktop or `taskcell hub --repo`), or imports CI run
  records ("Fetch records") from GitHub Actions artifacts.
- Screens: Home (projects and totals), Runs (list, run detail with Overview / Spec / Diff /
  Transcript, live run), Task board, New Task (doc editor + chat), Fleet (desktop only), Remote (CI
  runs), Workflow (flow editor), Settings (`.taskcell/app.json`), command palette (⌘K).
- Hub mode has a per-launch token in the URL fragment; a restarted hub invalidates open tabs.
  Fleet is disabled in hub mode because it spawns shell commands.
- **(assumption)** Typical session is a laptop-width window next to an editor and a terminal, used
  in short checks rather than long sittings.

## Capabilities and Constraints

- Terminology is fixed by `docs/design/brief.md` §8 and `CONTEXT.md`: Task, Task Source, Run,
  Claim, Watch Loop, Proof of Work, Stage, PR (GitHub) vs MR (GitLab). UI copy uses these exact
  words.
- `vanguard` is the old name of `taskcell` and still works; on-screen copy says Taskcell /
  `taskcell`. Paths and labels keep `.taskcell/` and `vanguard:*`.
- Irreversible writes (creating a real issue, enabling the factory on a repo) are confirmed in a
  dialog that states what will happen and where.
- All visual primitives come through `src/ui/index.ts` (the `@/ui` seam over `chunks-ui`).
- Light and dark themes are both first-class.

## Brand Commitments

- Name: **Taskcell**; the app is **Taskcell Hub**. Mark: the shield-cog logo (`src/ui/Logo.tsx`),
  tinted with the primary color.
- Voice, from the landing page and README: plain, short, factual; says what the system does and
  what it refuses to do ("The agent is treated as hostile", "You merge."). No hype.
- Direction from `docs/design/brief.md`: calm, precise, quiet chrome, "a cockpit, not a template
  dashboard"; status color only where it means something.

## Evidence on Hand

- Mock backend and fixtures for the browser dev build: `src/dev/mockBackend.ts`, `src/dev/fixtures.ts`.
- Design brief and mockups: `docs/design/brief.md`, `docs/design/screens/`.
- No user research, usage analytics or testimonials exist for the hub. Do not invent them.

## Product Principles

1. **Status you can trust at a glance.** Every run state on screen is backed by a record; nothing
   is decorative.
2. **The human merges.** The UI never implies the factory shipped something on its own; it hands
   the operator a PR and the evidence to judge it.
3. **Say where a write goes.** Any action that touches GitHub, GitLab, Linear or the repo names its
   target before it runs.
4. **One vocabulary.** The same word for the same thing on every screen, matching the CLI and docs.

## Accessibility & Inclusion

- **(assumption)** Target WCAG 2.2 AA: 4.5:1 text contrast in both themes, full keyboard use
  (the app already leans on ⌘K), visible focus, and reduced-motion support for the live pulses
  and spinners.
