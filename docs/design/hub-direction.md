# Hub design direction

Decided by the maintainer on 2026-11-12.

## Decision

- Paweł's Taskcell prototype is the baseline for every hub screen, on desktop and phone: `hub-prototype-v3/` (see its `README.md`; `app.js` is a built bundle) and `hub-prototype-v1.html` (readable source, including the `:root` tokens).
- Where v1 and v3 differ, v3 wins.
- The earlier plan to mock 2–3 directions (Works Docket, Night Shift Floor v2, Line Diagram) and pick one is dropped. There is one direction, and it is the prototype's dark Night Shift Floor look.
- `apps/desktop/DESIGN.md` is the written design document and follows this decision. Later 1.16.0 UI cards build on it.

## Why

- Taskcell is a factory, not an agent workstation. The unit of work is a card with acceptance criteria, trust comes from gates and an independent review, and the human approves at the end. The prototype makes that visible (six stages, the receipt, Needs you); the old hub design did not describe it.
- It already exists as a working prototype for desktop and phone, so cards build from one concrete reference instead of choosing between mock-ups.
- Its tokens equal the hub's dark tokens, so adopting it costs no re-skin. Only structure, vocabulary and the colour rule change, in later cards.

## Rules in short

- Stages: Card, Spec, Sealed cell, Gates, Review, Pull request.
- Vocabulary: card, needs you, receipt, line, runner.
- Navigation: Home, Board, Runs, Settings. Line and Runners sit under Settings; sign-off is part of Home.
- Colour: orange means "needs you" only. Self-repair is calm. Red means broken.
- No transcript or diff tabs; code opens in the Git host.

## Token comparison

Colour and type tokens in `apps/desktop/src/styles.css` were compared with `:root` in `hub-prototype-v1.html` (`--bg`, `--surface`, `--surface-2`, `--ink`, `--muted`, `--accent`, `--accent-ink`, `--teal`, `--fail`, `--line`, `--line-strong`, and the three font stacks). Every one already equals the dark theme value (the hairlines as solids over `#0d1013`: `#202c2f`, `#3a5054`), so no token changed. The light theme is untouched. The prototype's `--dim` (`#8a96a0`) and `--dimmer` (`#7b858e`) have no hub token; they sit between `muted-foreground` and the hairlines and are not needed yet.

## Where today's hub breaks the colour rule or the vocabulary

Input for the later cards; not fixed here.

Colour rule (orange = needs you only):

- Orange (`primary`) fills ordinary primary buttons: Add project, New run, Save, Play, Add, Clone (`Dashboard.tsx`, `NewRunForm.tsx`, `TaskDetail.tsx`, `RepoPicker.tsx`, `WorkflowEditor.tsx`).
- Orange marks the active run filter (`RunList.tsx`), the running run row tint (`RunList.tsx`), the running chip, the focus ring and text selection.
- Orange marks activity dots on the task and chat drawers (`TaskDrawer.tsx`, `TaskDraftScreen.tsx`) and the logo card.
- Amber/yellow marks warnings and self-repair-like states: board "Claimed" and "changes" tones (`TaskBoard.tsx`), budget nearing cap (`LiveRun.tsx`), the run strip note (`RunStrip.tsx`), unknown stages (`FlowCanvas.tsx`, `WorkflowEditor.tsx`). Retries and repair should be calm.
- The board gives each column its own hue (slate, amber, blue, rose, violet, emerald), including rose for "Verify failed"; red should mean broken only.

Vocabulary:

- "Dashboard" (rail label, screen key `dashboard`); prototype: Home.
- "Task board" (rail); prototype: Board. "Task", "New Task" and "Proof of Work" instead of card and receipt.
- "Workflow" (rail, `RemoteRuns.tsx` column) and "Fleet"/"Remote" in the rail; prototype: Line and Runners under Settings.
- A separate "Needs you" rail item; prototype folds sign-off into Home.
- Run detail has Diff and Transcript tabs (`DiffView.tsx`, `TranscriptView.tsx`); the prototype has none.
- Stage names and screens do not show the six stages (Card, Spec, Sealed cell, Gates, Review, Pull request) or a quick view with a vertical stage line.
- Navigation is a left rail with a project switcher; no bottom tab bar or bottom drawers for phones.
