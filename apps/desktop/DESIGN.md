---
name: Taskcell Hub
description: The operator's cockpit over a self-hosted software factory, in a Tauri window or a browser.
colors:
  primary: "#f99a2c"
  primary-foreground: "#14100a"
  primary-light: "#c8730f"
  success: "oklch(75.14% 0.1514 166.5)"
  warning: "oklch(0.86 0.16 95)"
  destructive: "oklch(0.582 0.2249 25.88)"
  destructive-text-dark: "#ff6a5c"
  background: "#0d1013"
  foreground: "#e8ecef"
  popover: "#141a1f"
  muted: "#1b2228"
  muted-foreground: "#a3adb6"
  border: "#202c2f"
  input: "#3a5054"
  background-light: "#f7f8f9"
  foreground-light: "#0d1013"
  card-light: "#ffffff"
  muted-light: "#e8ecef"
  muted-foreground-light: "#56616b"
  border-light: "#d3dadd"
  input-light: "#b9c3c7"
typography:
  title:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  card-title:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Atkinson Hyperlegible, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  meta:
    fontFamily: "Atkinson Hyperlegible, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  section-label:
    fontFamily: "Atkinson Hyperlegible, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.025em"
  micro:
    fontFamily: "Atkinson Hyperlegible, sans-serif"
    fontSize: "10px"
    fontWeight: 400
  titlebar:
    fontFamily: "Atkinson Hyperlegible, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  wordmark:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
  mono:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
  xl: "10px"
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

<!-- Recorded from the code in November 2026. Structure comes from chunks-ui's theme.css; the hub
     overrides its colors, fonts and radius in src/styles.css with the identity of taskcell.dev
     (landing/src/site.css). Product context: ./PRODUCT.md. Earlier direction:
     ../../docs/design/brief.md. Audit: ../../docs/design/hub-audit.md. -->

## Overview

**Creative North Star: "The Night Shift Floor"** *(the factory floor of taskcell.dev, seen from
the operator's desk)*

The hub is the product the landing page shows: the same near-black floor (`#0d1013`), cool ink,
teal-tinted hairlines and one amber accent, set in the landing's three faces. It is still a tool
people check, not a page they browse, so it takes the landing's palette and type but not its
display sizes, glow or 3D scene. Dark is the default; light is a derived theme for operators who
pick it.

Amber is the only accent. It marks the one main action per screen, focus, selection and live
state (the running chip, an active filter, the selected run row). It is never decoration. The
other colors are status (green passed/running dot, yellow warning, red failed) and the project's
own identity color in the title bar. When a screen is all ink and hairline, nothing needs the
operator.

Density follows content. Tables, the task board, transcripts and diffs are packed (`text-xs` and
`text-sm`, 4–8px gaps); page headers and dialogs get more air. There is no display size in the
hub; the largest text is a 24px number in a summary tile.

Everything visual is imported from `@/ui` (`src/ui/index.ts`), a thin seam over the `chunks-ui` kit
(Base UI + Tailwind v4). New UI composes those primitives at their own proportions; brand values
live only in `src/styles.css`.

**Key Characteristics:**
- Near-black floor, cool ink, teal-tinted hairlines (landing palette).
- One amber accent with dark ink on it, for action, focus and live state only.
- One primary (filled) button per screen; everything else is outlined or text.
- Hairline 1px borders and tonal steps instead of shadows; small, tight radii.
- Schibsted Grotesk headings, Atkinson Hyperlegible text, IBM Plex Mono for machine text, all
  self-hosted (`src/fonts`), so the Tauri window and an offline hub render the same.

## Colors

The landing's palette, set as chunks-ui tokens in `src/styles.css` and switched by a `.dark`
class on `<html>`. Dark is applied before first paint (`class="dark"` in `index.html`); a saved
`vg-theme: light` turns it off.

### Primary
- **Signal Amber** (`primary`): `#f99a2c` in dark (the landing's `--accent`), deepened to `#c8730f`
  in light so a tab underline, the focus ring and the logo card keep 3:1 on the page. Ink on it is
  always the landing's `--accent-ink` `#14100a`. Used for the main action on a screen, the logo's
  card, active tab indicators, focus ring (solid, as on the landing), text selection, the active
  run filter and the running chip. Links and colored text use `text-primary-text`. Never a
  surface fill.

### Status
- **Live Green** (`success`): running dot (`bg-success`, pulsing), passed chips, positive diff
  lines. Text uses `text-success-text`, never the fill. Light sets `--success-text` to
  `oklch(0.47 0.11 166.5)` because chunks-ui's clamp assumes a white page.
- **Caution Yellow** (`warning`): verify issues, unsaved state, unknown stages, budget nearing the
  cap. Shifted from amber to yellow (hue 95) so a warning never reads as the accent. Text uses
  `text-warning-text`.
- **Fault Red** (`destructive`): failed runs, errors, Kill, removed diff lines, error banners. Text
  uses `text-destructive-text` (the landing's `--fail` `#ff6a5c` in dark), banners included.
- **Board and info hues (Tailwind palette, not tokens):** the task board gives each column its own
  hue (slate Queued, amber Claimed, blue Running, rose Verify failed, violet Review, emerald Done),
  and sky marks informational lines (tool calls, `@@` hunks). These are the only sanctioned raw
  palette colors; they are spelled out in `COLUMNS`/`CHIP_TONE` in `TaskBoard.tsx`.

### Identity
- **Project color** (`projectColor()` in `src/color.ts`): a per-project hex, auto-derived from the
  path (HSL 70% / 52%) or set in Settings. It fills the 32px title bar inside a project (text from
  `contrastColor()`), the dashboard card's left edge, and the dot in the project switcher.
- **Doorway mark** (`Logo`): the landing's mark, wall in `currentColor`, card in `fill-primary`.

### Neutral (dark / light)
- **Floor / Paper** (`background`): `#0d1013` / `#f7f8f9`. Cards sit on the floor in dark, white
  in light.
- **Ink** (`foreground`): `#e8ecef` / `#0d1013`.
- **Surface** (`popover`): `#141a1f` / `#ffffff`, for floating layers.
- **Well** (`muted`, `secondary`, `accent`; used at /20–/60): `#1b2228` / `#e8ecef`. Rail, hover
  fills, table headers, code wells.
- **Graphite** (`muted-foreground`): `#a3adb6` / `#56616b`. Metadata, labels, inactive nav,
  placeholders.
- **Hairline** (`border`): `#202c2f` / `#d3dadd` (the landing's teal `--line` at 18% on the floor,
  as a solid). **Input** edge `#3a5054` / `#b9c3c7` (`--line-strong`).

### Contrast (measured in the rendered app, WCAG 2)
| Text | dark: floor / well | light: paper / well |
|---|---|---|
| foreground | 16.1 / 13.5 | 17.9 / 16.1 |
| muted-foreground | 8.4 / 7.1 | 6.0 / 5.3 |
| primary-text | 8.8 / 7.4 | 5.6 / 5.0 |
| success-text | 9.2 / 7.8 | 5.9 / 5.3 |
| warning-text | 12.5 / 10.5 | 5.4 / 4.8 |
| destructive-text | 6.8 / 5.7 | 5.8 / 5.2 |
| ink on amber button | 8.7 | 5.3 |

### Named Rules
**The Ink-At-Rest Rule.** A screen with nothing wrong and nothing running is ink, hairlines and
one amber button. Status color appears only when its state is true.

**The One-Amber Rule.** Amber means "act here" or "live". Do not use it for decoration, headings
or illustration; do not use Tailwind `amber-*` for new status.

**The Text-Shade Rule.** Colored text uses the `*-text` token (`text-success-text`,
`text-warning-text`, `text-destructive-text`, `text-primary-text`), which keeps 4.5:1 in both
themes. Never `text-primary` for text, `text-green-600 dark:text-green-400` or `text-rose-500`.

## Typography

**Heading Font:** Schibsted Grotesk (variable 400–900), via `--font-heading` and a base rule on
`h1`–`h3`.
**Body Font:** Atkinson Hyperlegible (400, 700) as `font-sans`.
**Mono Font:** IBM Plex Mono (500) as `font-mono`.

The same files the landing ships (`landing/src/fonts`, OFL), copied to `src/fonts` and bundled by
Vite. No CDN. Atkinson has two weights, so `font-medium` renders 400 and `font-semibold` renders
700; Plex Mono renders every mono weight at 500.

**Character:** a hyperlegible sans for chrome and prose, a tight grotesk for titles and the
wordmark, monospace only where the content is machine text: task ids, commands, file paths in
code, stage names, diffs, transcripts.

### Hierarchy
- **Title** (Schibsted 600, 16px): page and dialog headings (`h2.font-semibold`, dialog
  `text-sm font-medium`).
- **Card title** (Schibsted 600, 18px, tight): project card names (chunks `Card.Title`).
- **Stat** (600, 24px, tabular): the five summary tiles on Home only.
- **Body** (400, 14px): table cells, form labels, list rows, buttons.
- **Meta** (400, 12px, `text-muted-foreground`): timestamps, counts, hints, chips.
- **Section label** (11px, uppercase, `tracking-wide`, muted): the rail's "Running" group,
  summary tile labels, panel captions. Labels a group of controls; never sits above a page heading.
- **Micro** (400, 10px): inline tags inside a row ("git", ".vanguard", a stage's "review" badge,
  the code block's language and copy labels). Never body text.
- **Title bar** (700, 13px): the window title strip only.
- **Wordmark** (Schibsted 700, `font-heading`): "Taskcell Hub" next to the mark in the top bar.

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

Tight radii, closer to the landing's square edges than chunks-ui's default (`--radius` 6px): 2px
(`rounded-sm`), 4px (`rounded`, `rounded-md`) on buttons, inputs, rail items, inline tags and
banners; 6px (`rounded-lg`) on panels, dialogs and summary tiles; 10px (`rounded-xl`) on chunks
`Card` and board lanes; full pills for chips, counts and live dots. Borders are always 1px; the one
wider edge is the dashboard card's 6px project-color strip, which is identity, not decoration.

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

### App-owned primitives (`src/ui`)
- **Callout**: 11px uppercase muted label + content, `p-3`, no border; labelled asides inside
  prose and panels. A bordered note (the Settings Credentials box) is a Callout inside a hairline
  `rounded-md border bg-muted/30` box; prefer extending Callout over hand-rolling another.
- **CodeBlock**: dark `pre` with highlight.js tokens, a 10px language label and a copy button.
- **Markdown**: `react-markdown` + GFM in Tailwind `prose`, code fences through CodeBlock.
- **ScrollTable** over chunks **Table**: the run list and Remote; rows scroll inside their own
  container under a sticky `bg-muted` header.
- **InlineEdit**: click-to-rename text (the last breadcrumb on New Task).
- **Logo**: the Doorway mark from taskcell.dev; wall `currentColor`, card `fill-primary`.

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
- **Don't** add display-size type, gradients, glass, the landing's glow or decorative illustration.
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
