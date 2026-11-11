---
name: Taskcell Hub
description: The operator's cockpit over a self-hosted software factory, in a Tauri window or a browser.
colors:
  primary: "oklch(0.56 0.2165 257.21)"
  primary-foreground: "oklch(0.985 0 0)"
  success: "oklch(75.14% 0.1514 166.5)"
  warning: "oklch(77.97% 0.1665 72.45)"
  destructive: "oklch(0.582 0.2249 25.88)"
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.53 0 0)"
  border: "oklch(0.922 0 0)"
  background-dark: "oklch(0.145 0 0)"
  foreground-dark: "oklch(0.985 0 0)"
  muted-dark: "oklch(0.269 0 0)"
  muted-foreground-dark: "oklch(0.708 0 0)"
  border-dark: "oklch(0.269 0 0)"
typography:
  title:
    fontFamily: "Manrope, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  card-title:
    fontFamily: "Manrope, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Manrope, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  meta:
    fontFamily: "Manrope, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  section-label:
    fontFamily: "Manrope, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.025em"
  micro:
    fontFamily: "Manrope, sans-serif"
    fontSize: "10px"
    fontWeight: 400
  titlebar:
    fontFamily: "Manrope, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  mono:
    fontFamily: "Fira Code, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  tight: "4px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  control-height: "35px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control-height}"
  button-outlined:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control-height}"
  rail-item:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.tight}"
    padding: "6px 8px"
  rail-item-active:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  card:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.xl}"
    padding: "24px"
  panel:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.lg}"
    padding: "12px"
  dialog:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.lg}"
    width: "512px"
---

# Design System: Taskcell Hub

<!-- Recorded from the code on main (apps/desktop/src, chunks-ui theme) in November 2026. Tokens come
     from chunks-ui's theme.css; the app adds none of its own. Product context: ./PRODUCT.md.
     Earlier direction: ../../docs/design/brief.md. Audit: ../../docs/design/hub-audit.md. -->

## Overview

**Creative North Star: "The Quiet Control Room"** *(proposed name; the direction behind it is the
brief's "calm, precise, Mac-native cockpit")*

The hub is a tool people check, not a page they browse. Surfaces are grayscale: white or near-black
background, hairline borders, light muted fills for chrome. The only color at rest is the
primary blue on the one main action per screen and the project's own identity color in the title
bar. Everything else that is colored is status: green means running or passed, red means failed,
amber means a warning or something unsaved. When a screen is all gray, nothing needs the operator.

Density follows content. Tables, the task board, transcripts and diffs are packed (`text-xs` and
`text-sm`, 4–8px gaps); page headers and dialogs get more air. Type stays small and modest: there is
no display size, the largest text in the app is a 24px number in a summary tile.

Everything visual is imported from `@/ui` (`src/ui/index.ts`), a thin seam over the `chunks-ui` kit
(Base UI + Tailwind v4). New UI composes those primitives at their own proportions.

**Key Characteristics:**
- Grayscale chrome, color reserved for status and identity.
- One primary (filled) button per screen; everything else is outlined or text.
- Hairline 1px borders and tonal fills instead of shadows.
- Small type (14px body, 12px metadata), monospace for ids, commands, code and diffs.
- Light and dark are equal; every color comes from a token that has both.

## Colors

A neutral grayscale system with one blue accent and three status hues, all defined in OKLCH by
`chunks-ui/theme.css` and switched by a `.dark` class on `<html>`.

### Primary
- **Signal Blue** (`primary`): the main action on a screen (Add project, New Task, Save, Create
  task), the logo, active tab indicators, the focus ring (60% mix with the background). Never a
  surface fill.

### Status
- **Live Green** (`success`): running dot (`bg-success`, pulsing), passed chips, positive diff
  lines. Text uses `text-success-text`, never the fill.
- **Caution Amber** (`warning`): verify issues, unsaved state, unknown stages, budget nearing the
  cap. Text uses `text-warning-text`.
- **Fault Red** (`destructive`): failed runs, errors, Kill, removed diff lines, error banners. Text
  uses `text-destructive-text` (or `text-destructive` on a `bg-destructive/10` banner).
- **Board and info hues (Tailwind palette, not tokens):** the task board gives each column its own
  hue (slate Queued, amber Claimed, blue Running, rose Verify failed, violet Review, emerald Done),
  and sky marks informational lines (tool calls, `@@` hunks). These are the only sanctioned raw
  palette colors; they are spelled out in `COLUMNS`/`CHIP_TONE` in `TaskBoard.tsx`.

### Identity
- **Project color** (`projectColor()` in `src/color.ts`): a per-project hex, auto-derived from the
  path (HSL 70% / 52%) or set in Settings. It fills the 32px title bar inside a project (text from
  `contrastColor()`), the dashboard card's left edge, and the dot in the project switcher.

### Neutral
- **Paper / Ink** (`background` / `foreground`): page and primary text.
- **Mist** (`muted`, used at /20–/60): rail background, hover fills, table headers, code wells.
- **Graphite** (`muted-foreground`): metadata, labels, inactive nav, placeholders.
- **Hairline** (`border`): every divider and card edge.

### Named Rules
**The Gray-At-Rest Rule.** A screen with nothing wrong and nothing running is grayscale plus one
blue button. Status color appears only when its state is true.

**The Text-Shade Rule.** Colored text uses the `*-text` token (`text-success-text`,
`text-warning-text`, `text-destructive-text`, `text-primary-text`), which chunks-ui clamps to 4.5:1
in both themes. Never `text-green-600 dark:text-green-400` or `text-rose-500`.

## Typography

**Body Font:** Manrope (falls back to the platform sans; see the note below)
**Mono Font:** Fira Code (falls back to the platform monospace)

**Character:** a plain humanist sans for chrome and prose, monospace only where the content is
machine text: task ids, commands, file paths in code, stage names, diffs, transcripts.

Neither font is bundled or loaded today, so the app renders in the system sans (SF / Helvetica on
macOS) and system mono. Treat that as the current reality; shipping the two faces is an open
decision tracked in the audit.

### Hierarchy
- **Title** (600, 16px): page and dialog headings (`h2.font-semibold`, dialog `text-sm font-medium`).
- **Card title** (600, 18px, tight): project card names (chunks `Card.Title`).
- **Stat** (600, 24px, tabular): the five summary tiles on Home only.
- **Body** (400, 14px): table cells, form labels, list rows, buttons.
- **Meta** (400, 12px, `text-muted-foreground`): timestamps, counts, hints, chips.
- **Section label** (500, 11px, uppercase, `tracking-wide`, muted): the rail's "Running" group,
  summary tile labels, panel captions. Labels a group of controls; never sits above a page heading.
- **Micro** (400, 10px): inline tags inside a row ("git", ".vanguard", a stage's "review" badge,
  the code block's language and copy labels). Never body text.
- **Title bar** (600, 13px): the window title strip only.

### Named Rules
**The Tabular Rule.** Every number that can change or be compared (counts, cost, durations,
turns) uses `tabular-nums`.

**The Machine-Text Rule.** Monospace marks text a machine produced or consumes. It is not a
"technical" costume for headings, buttons or chat placeholders.

## Layout

- **Shell:** 32px title bar (drag region on macOS, project-colored inside a project) → top bar
  (logo/home, project switcher, breadcrumb, ⌘K, theme toggle) → rail + main.
- **Rail:** 144px expanded, 56px collapsed (persisted in `localStorage`), project screens only. Home
  has no rail.
- **Main:** `flex-1`, `min-w-0`, scrolls inside itself; the page body never scrolls sideways. Wide
  content (board lanes, tables, diffs) scrolls in its own container.
- **Content widths in use:** Home `max-w-5xl` centered with `p-6`; Runs, Remote, Workflow `max-w-5xl`
  centered; Settings `max-w-2xl`; Task board and New Task full width. A new screen picks one of
  these by content type: lists and detail `max-w-5xl`, forms `max-w-2xl`, canvases full width.
- **Rhythm:** `gap-2` (8px) inside a row of controls, `gap-3` (12px) between cards, `space-y-4` (16px)
  between page sections; panel padding `p-3`, form card padding `p-5`.
- **Minimum window:** about 1100×800 per the brief; the browser hub can be narrower, and screens
  should degrade to one column rather than overflow.

## Elevation & Depth

Flat by default. Depth comes from tonal layering (`bg-muted/20` rail and panels, `bg-muted/30` info
notes, `bg-background` cards on a tinted lane) and 1px borders. Shadows appear in two places only:
floating layers (dialogs and the palette `shadow-xl`, tooltips `shadow-md`) and the board's task
cards (`shadow-sm`, `hover:shadow-md`).

### Named Rules
**The Hairline Rule.** Separation is a 1px `border-border` line or a tonal step, not a shadow. A
shadow means the thing floats above the page.

## Shapes

Soft, small radii from the chunks-ui scale (base `--radius` 10px): 4px (`rounded`) on rail items,
inline tags and banners; 8px (`rounded-md`) on buttons and inputs; 10px (`rounded-lg`) on panels,
dialogs and summary tiles; 14px (`rounded-xl`) on chunks `Card` and board lanes; full pills for
chips, counts and live dots. Borders are always 1px; the one wider edge is the dashboard card's
6px project-color strip, which is identity, not decoration.

## Components

### Buttons (chunks `Button`, 35px tall)
- **Primary** (`contained`, default): one per screen, the action the screen exists for.
- **Outlined** (`variant="outlined"`): secondary actions in toolbars (New Task next to a primary,
  Fetch records).
- **Text** (`variant="text"`, often `color="secondary"`): Cancel, Reload, Remove, icon-only
  buttons (with `aria-label`). `color="destructive"` for Kill.
- **States:** chunks handles hover, `focus-visible` ring and disabled (50% opacity); use `loading`
  for in-flight actions instead of swapping the label.

### Chips (chunks `Chip`)
- Run status (`running` / `passed` / `failed`), stage results, "N in 24h", terminal outcomes.
  `variant="outlined"` with a status `color`; `secondary` for neutral facts.

### Cards and panels
- **Card** (chunks `Card`): project cards on Home, task cards on the board (override padding to
  `py-0` + `p-3` content when dense). Clickable cards must be reachable by keyboard.
- **Panel** (plain `div`, `rounded-lg border border-border`, `p-3`/`p-5`): Settings form, Proof of
  work, launch output, workflow columns.
- **Summary tile** (`Stat` in `Dashboard.tsx`): label + 24px number; Home only.

### Inputs
- chunks `Input` / `Textarea` / `Select` / `Combobox`; labels via a wrapping `<label>` (`Field` in
  Settings) or `aria-label` when the label is visual context only. Placeholder is never the only
  label.

### Navigation
- **Rail** (`Rail.tsx`): icon + label rows, active = `bg-muted font-medium`, inactive =
  `text-muted-foreground hover:bg-muted/60`, `aria-current="page"` on the active row. Collapsed it
  shows icons with right-side tooltips (`RailTip`). A "Running" group lists live runs with a pulsing
  dot.
- **Top bar** (`TopBar.tsx`): logo is Home; project switcher (`ProjectCombobox`) is the first crumb;
  the last crumb can be an `InlineEdit`.
- **Tabs** (chunks `Tabs`): run detail sections, Add-project modes.

### Dialogs and overlays
- Fixed full-screen scrim `bg-black/40`, panel `max-w-lg rounded-lg border bg-background shadow-xl`,
  top-anchored at 15vh for pickers (palette, repo picker), centered for confirmations
  (`CreateTaskDialog`).
- Required: `role="dialog"`, `aria-modal="true"`, an accessible name, Escape closes (unless a write
  is in flight), focus starts inside. Confirmations for irreversible writes name the target and say
  what cannot be undone; one irreversible action per button.
- chunks-ui also ships `Dialog` (Base UI, with focus trap); prefer it for new dialogs and add it to
  `@/ui` when first used.

### Status strips and banners
- **Live indicator:** 8px `bg-success` dot with `animate-pulse` plus a word ("live", "running").
- **Banner:** full 1px border + 10% tint of the status color, `rounded`, `px-3 py-2 text-sm`;
  `role="alert"` for errors. Never a thick left border.
- **Hub connection banners** (`App.tsx`): full-width strip under the title bar.

### Empty, loading and error states
- **Empty:** chunks `Empty` (icon, title, one sentence, the action) for whole screens; a dashed
  `border-dashed` box with "No tasks" inside board lanes.
- **Loading:** a muted line of text ("Loading tasks…") or the button's `loading` state.
- **Error:** the destructive banner, with the reason and the recovery in plain words.

## Do's and Don'ts

### Do:
- **Do** import every visual primitive from `@/ui`; add a re-export there when a screen first needs
  a chunks-ui component.
- **Do** use semantic tokens (`bg-success`, `text-destructive-text`, `border-border`) so both themes
  work; check new UI in light and dark.
- **Do** keep one primary button per screen and put it at the right end of the page header row.
- **Do** use the glossary words (Task, Run, Proof of Work, Stage, PR/MR) exactly.
- **Do** give icon-only buttons an `aria-label` and every overlay dialog semantics.
- **Do** use `tabular-nums` on numbers and monospace on ids, commands and code.
- **Do** run the design detector over changed UI before committing (below).

### Don't:
- **Don't** use raw Tailwind palette colors (`text-green-600`, `bg-rose-500/5`) for status; only
  the board's column hues and sky info lines are allowed, and only where they already live.
- **Don't** put a thick colored left border on cards, callouts or alerts (`border-l-4`).
- **Don't** color a whole panel for a passed state; status color goes on the dot, chip or text.
- **Don't** add display-size type, gradients, glass or decorative illustration.
- **Don't** add uppercase eyebrow labels above page headings.
- **Don't** leak internal ticket refs (`(S6)`, `#491`) or the old `vanguard` name into UI copy.

## Design detector

The project uses a mechanical design detector (the Impeccable CLI) to catch contrast, side-tab,
token-drift and similar issues. The automatic per-edit hook is **not** wired: on this setup
`hooks on` writes user-global or `.github/hooks` config, which this repo keeps out of scope. Run it
by hand over the files you changed:

```bash
<impeccable-skill-dir>/scripts/impeccable detect --json apps/desktop/src
# exit 0 = clean, 2 = findings
```
