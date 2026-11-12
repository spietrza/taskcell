# Hub UI prototype v3

The current design baseline for the Hub on desktop and phone. It replaces `../hub-prototype-v1.html` wherever the two differ.

Open `index.html` in a browser. `app.js` is a built bundle and is not meant to be read; the notes below say what the prototype shows.

## What changed since v1

Board and Runs

- Board shows all projects at once.
- Board and Runs share one filter bar: triage (All, Running, Needs you, Merged), projects, card source, runner, search.
- Projects is a searchable multi-select, built for 70+ projects, with shortcuts for projects that have cards.
- Swimlanes: group the Board by project, card source, runner or triage. Runs groups its table the same way.
- A card opens in a quick view first, with a vertical stage line. "Full page" opens the run page.

Links out

- "Open in GitHub" or "Open in GitLab" wherever a pull request waits for merge.
- No transcript or diff tabs. Code opens in the Git host.

Structure and meaning

- Line and Runners moved under Settings. The Sign-off tab folded into Home.
- Orange only means "needs you". Self-repair is calm; red means something is broken.
- A third inbox kind: cards sent back as too vague.
- The receipt is four plain facts: tests, second-AI review, secret scan, cost.
- Card sources: GitHub, GitLab, Linear and the Taskcell board.

Phones

- Navigation is a bottom tab bar.
- A card opens as a bottom drawer; the receipt comes first, and Merge and "Open in GitHub/GitLab" are pinned to the bottom edge.
- Filters fold into one Filters drawer. Triage and search stay on screen.
- Board: pick a stage, and cards stack inside each swimlane instead of six columns scrolling sideways.
- Runs: a list instead of a wide table.
- New card, Filters, What's new and Connect a runner open as bottom drawers.
- Setup shows a compact step bar.

## Not in the prototype yet

- A target branch per card. The merge button still says "Merge into main" (#828).
- A full self-hosted setup branch; it is only noted in Setup step 3.
