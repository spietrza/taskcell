# Taskcell Hub: design audit and critique (November 2026)

Scope: `apps/desktop` as it renders in the browser dev build (`pnpm --dir apps/desktop dev`, mock
backend from `src/dev/mockBackend.ts`) at 1440×900, light theme, plus a dark-theme pass on the task
screen and the command palette. Screens looked at: Home, Runs, run detail (Overview), Task board,
Settings, Workflow, Remote, New Task, command palette. Fleet, the live run view, Diff/Transcript
tabs, the repo picker and the create-task confirmation were reviewed from code only.

Inputs: the rendered screens, the source, the design detector
(`impeccable detect --json apps/desktop/src`) and the baseline in
[`apps/desktop/DESIGN.md`](../../apps/desktop/DESIGN.md) /
[`apps/desktop/PRODUCT.md`](../../apps/desktop/PRODUCT.md).

Method note: the design review and the detector run were done in one pass by the same reviewer,
not by two isolated reviewers, so the critique scores were formed with the detector output in view.
The detector was run before the review; it found little, so the anchoring risk is small.

Severity: **P0** blocks a task · **P1** significant difficulty or a WCAG AA failure · **P2**
annoyance with a workaround · **P3** polish.

Status: **fixed** (in this PR) · **open** · **open PR** (the file is being changed in an open PR;
apply the fix there).

## Summary

| Area | Score | Key finding |
|---|---|---|
| Accessibility | 2 → 3 | Status text below 4.5:1, keyboard-dead project cards, overlays without dialog semantics (fixed); no focus trap yet |
| Performance | 3 | 5 s polling of projects and active runs is fine at this size; nothing janky seen |
| Theming | 2 | Semantic tokens exist but 14 files used raw Tailwind palette for status; dark variants hand-written |
| Responsive | 2 | Desktop-first by design; rail truncates live task ids; page widths differ per screen |
| Implementation integrity | 3 | Coherent: one kit behind `@/ui`, quiet grayscale chrome; drift is in status color and wording |
| **Audit total** | **12/20 → ~14/20 after fixes** | Acceptable → Good |

Critique (Nielsen, 0–4 each):

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Live dots and the rail's Running list work; run detail header shows a raw ISO timestamp |
| 2 | Match with the real world | 3 | Glossary terms mostly right; Settings shows raw config keys (`provider`, `reviewProvider`) |
| 3 | User control and freedom | 2 | Remove project has no confirm or undo; dialogs did not close on Escape (fixed for create-task) |
| 4 | Consistency and standards | 2 | Three date formats, three status vocabularies, three page widths |
| 5 | Error prevention | 3 | Create-task confirmation and the navigation guard are good |
| 6 | Recognition rather than recall | 3 | Labeled rail, breadcrumb, ⌘K |
| 7 | Flexibility and efficiency | 3 | ⌘K exists but only lists Home, Add project, theme and projects, not screens |
| 8 | Aesthetic and minimalist design | 3 | Calm and quiet; duplicate "Taskcell Hub" in title bar and top bar |
| 9 | Error recovery | 2 | Errors are `String(err)` dumps ("No task board. Error: …") without a next step |
| 10 | Help and documentation | 2 | Inline hints help, but leak internal refs like "(S6)" |
| **Total** | | **26/40** | Solid tool, held back by inconsistency rather than by any one screen |

**Design specificity:** the hub reads as its own product. The grayscale-plus-status discipline,
the project identity color in the title bar, the proof-of-work panel and the board's lane colors
come from what the factory does, not from a dashboard template. The one templated element is the
row of five summary tiles on Home, which is acceptable there and should not spread.

**Detector:** 2 findings on `main`, both `side-tab` (`border-l-4`) in `Settings.tsx` (the
unreadable-config banner and the Credentials note); both fixed. After the fix and with DESIGN.md in
place, the detector reports only advisory drift: 10px and 13px literal sizes (now documented as the
Micro and Title-bar steps), CodeMirror's own colors in `DocEditor.tsx`, and project colors in
fixtures (data, not design). No false positives worth an ignore entry.

## What works

- **One UI seam.** Every primitive comes from `@/ui` over chunks-ui, so tokens, focus rings,
  disabled states and both themes are consistent wherever the kit is used.
- **Status color mostly means something.** At rest the screens are gray; green, red and amber show
  up on dots, chips and diff lines. Project identity color is a distinct, well-contained channel.
- **Irreversible writes are honest.** The create-task confirmation names the target, says what
  cannot be undone and offers one action per button.

## Findings

### P0

None. Every task can be completed with mouse and keyboard (the palette was a keyboard workaround for
the project cards).

### P1

**[P1] Status text below 4.5:1 contrast** · Accessibility / Theming · **fixed**
- Where: `Dashboard.tsx` (running count `text-green-600`, 3.3:1; failed count), `LaunchPanel.tsx`
  (running label), `DiffView.tsx` (+/- lines), `ChatPane.tsx` (three `text-rose-500` errors, 3.7:1),
  `StageInspector.tsx`, `WorkflowEditor.tsx` (`text-amber-600` on an amber tint, about 3.2:1),
  `Settings.tsx`.
- Fix applied: the chunks-ui `*-text` tokens (`text-success-text`, `text-destructive-text`,
  `text-warning-text`), which are clamped to 4.5:1 in both themes, replacing the hand-written
  `text-x-600 dark:text-x-400` pairs. WorkflowEditor's warning tint also moved to `warning` tokens.
- Still open in `RunStrip.tsx`: see "For open PRs".

**[P1] Project cards on Home could not be opened by keyboard** · Accessibility · **fixed**
- Where: `Dashboard.tsx`; the card was a `div` with `onClick`.
- Fix applied: the project name is a real `<button>` stretched over the card (`after:inset-0`,
  `cursor-pointer`); the card's own actions (Remove, Enable factory) sit above it with
  `relative z-10`, and the card shows the focus ring when the name button has keyboard focus.
  Covered by `Dashboard.test.tsx`.
- Trade-off (P3): the overlay sits over the path line, so its `title` tooltip no longer shows and
  the path and stats text cannot be selected with the mouse. Any new interactive element on the
  card needs `relative z-10`.

**[P1] Overlays had no dialog semantics** · Accessibility · **fixed (partly)**
- Where: `CommandPalette.tsx`, `RepoPicker.tsx`, `features/task/CreateTaskDialog.tsx`.
- Fix applied: `role="dialog"`, `aria-modal`, an accessible name on all three; the palette is now
  a combobox + listbox with `aria-activedescendant`; the create-task dialog takes focus on open and
  closes on Escape unless the create is in flight.
  Focus returns to the opener when the create-task dialog closes (`CreateTaskDialog.test.tsx`).
- Still open (P2): none of them traps Tab inside the dialog. In the palette the options are now
  `tabIndex={-1}` (arrow keys drive them), so Tab from the search input leaves the open palette
  for the page behind it. New dialogs should use chunks-ui's
  `Dialog` (Base UI, with focus management), and these three should move to it.

**[P1] Inputs labelled only by placeholder** · Accessibility · **fixed (partly)**
- Fixed: the palette search, RepoPicker's URL and folder-name inputs.
- Open (P2): `NewRunForm.tsx` (issue ref, max turns, base branch), Settings custom-provider rows;
  check each has a programmatic label.

**[P1] Errors not announced to assistive tech** · Accessibility · **fixed**
- `role="alert"` added to the Settings unreadable-config banner, ChatPane errors and the RepoPicker
  error line.

**[P1] Thick colored left borders (`side-tab`)** · Implementation integrity · **fixed**
- Both `border-l-4` callouts in `Settings.tsx` are now a full hairline border with a tint
  (destructive for the error, muted for the Credentials note).

### P2

1. **No webfont is loaded.** chunks-ui sets `font-sans: Manrope` and `font-mono: Fira Code`, but
   nothing ships the files, so the app renders in whatever the OS has (Helvetica/SF on the Mac,
   something else on a Linux server's browser). Decide: bundle both faces (the landing page already
   self-hosts woff2 files) or set the stacks to the system fonts on purpose. `src/styles.css`.
2. **Three timestamp formats.** Relative ("484d ago") in the run list and rail, local
   `2026-07-14 10:30` in the run list and Remote, raw ISO `2026-07-14T10:30:00.000Z` in the run
   detail header (`Inspector.tsx` → open PR). Use one helper: relative with the absolute time in a
   tooltip.
3. **Three status vocabularies.** Runs say passed/failed, Remote says success/failure, stages say
   Complete, launches say exit N. Map them to one set in the UI (passed / failed / running / …).
4. **Page widths differ per screen.** Home, Runs, Remote, Workflow use a centered `max-w-5xl`,
   Settings `max-w-2xl`, Board and New Task full width, so the content's left edge jumps when
   switching screens. DESIGN.md now states which width each kind of screen uses; align the rest.
5. **Rail truncates live runs to "task…".** At 144px the task id is cut and the tooltip only exists
   when the rail is collapsed (`Rail.tsx`). Add a `title`/tooltip in the expanded state or show the
   id's tail.
6. **Duplicate app name and a dead strip in the browser.** The 32px title bar repeats "Taskcell Hub"
   next to the top bar's wordmark and keeps `pl-20` for macOS traffic lights that do not exist in
   the browser hub (`App.tsx`). In hub mode, drop the strip or show only the project color.
7. **Board task cards have double top padding.** `Card.Root` keeps chunks' `py-6 gap-6` under
   `Card.Content p-3` (`TaskBoard.tsx`). Add `py-0 gap-0` on the root.
8. **Raw palette for board lanes and info lines.** Sanctioned in DESIGN.md for now, but they bypass
   the token system and their light-theme text shades need checking (`TaskBoard.tsx`,
   `FlowCanvas.tsx`, `StreamView.tsx`, `DiffView.tsx` hunks `text-sky-600`, about 4.1:1).
9. **Settings copy.** Labels mix raw keys (`provider`, `reviewProvider`) with words ("Task Source",
   "Budget cap per Run"); hints leak "(S6)". `NewRunForm.tsx` has the same "(S6)" pattern in code
   comments only.
10. **Remove project has no confirmation or undo** (`Dashboard.tsx`). It only unregisters the
    project, but a misclick on the 16px × costs the operator a re-add through the folder picker.
11. **Hub restart banner names the old CLI** (`App.tsx`: "open the URL `vanguard hub` printed").
    Should say `taskcell hub`.
12. **Errors are raw strings.** `String(err)` lands on screen in RepoPicker, the board ("No task
    board. Error: …") and Settings. State the problem and the next step.
13. **⌘K cannot reach screens.** The palette lists Home, Add project, theme and projects; adding
    Runs, Task board, Settings, New Task for the current project would make it the fast path the
    brief wants.
14. **No focus trap in the custom dialogs** (see P1 overlays).

### P3

- The chat composer on New Task renders its placeholder in monospace (CodeMirror's theme); prose
  input should use the sans.
- Workflow shows a "Flows" page heading and a "FLOWS" caption directly under it.
- Summary tiles on Home are the only hero-number pattern; keep it there.
- The dev-only breakpoint badge (`TailwindDebugScreens`) covers the theme toggle in dev builds;
  harmless in production.

## For open PRs

These files were being changed in other PRs when this audit was written (#727, #728, #739; some
have since merged), so this PR does not touch them. Apply the fixes there or in a follow-up:

**`features/inspector/RunStrip.tsx`**
- [P1] Stage pills use `text-emerald-500` / `text-rose-500` / `text-blue-500` at 12px (about
  2.5–3.7:1 on white). Use `text-success-text`, `text-destructive-text`, `text-primary-text` and the
  matching `border-*` tokens.
- [P1] Warnings use `text-amber-600` on `bg-amber-500/10`; use `text-warning-text` and
  `bg-warning/10 border-warning/40`, and give the list `role="status"` so new warnings are
  announced.
- [P2] "View PR" link is `text-blue-500`; use `text-primary-text`.
- [P2] Kill acts at once; a run in flight is not undoable, so confirm or allow undo for a few
  seconds.

**`features/inspector/Inspector.tsx`**
- [P2] Run detail header prints `detail.timestamp` raw (ISO with milliseconds). Use the shared
  relative/absolute time helper.
- [P2] The "a run is live in …" note and the empty-state boxes are `bg-muted/30` divs; fine, but
  give the error banner `role="alert"`.

**`features/dashboard/EnableFactoryDialog*`**
- Apply the dialog contract from DESIGN.md: `role="dialog"`, `aria-modal`, `aria-labelledby` on
  the heading, initial focus inside, Escape closes unless a write is in flight, Tab stays inside
  (chunks `Dialog`). It writes to a remote platform, so name the repo and platform in the title
  and keep one irreversible action per button, like `CreateTaskDialog`.
- Status text through `*-text` tokens; no `border-l-4` callouts.

**`features/needs-you/`**
- New surface: follow DESIGN.md (gray at rest, status color only on the dot/chip/text, one primary
  action, `tabular-nums` on counts, glossary words). If it lists items the operator must answer,
  announce new ones with `role="status"`, and make every row reachable by keyboard (a real button
  or link, not a clickable `div`).
- Run the detector over the new files before merge.
