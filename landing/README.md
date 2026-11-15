# taskcell.dev

The landing page for Taskcell. Static HTML, CSS and a little JavaScript in `src/`, no framework and no dependencies. The factory scene in `src/scene/` is a plain ES module that imports a vendored three.js.

## Build and check

```
pnpm run check
```

This runs `node build.mjs`, `node quiz-check.mjs` and `node preview-check.mjs`. Run it after every change; `pnpm run deploy` runs it first and stops when one of them fails.

- The build copies `src/` to `dist/` and fails if any local reference in the HTML, CSS or JS points at a missing file.
- The readiness quiz keeps its rules in `src/quiz.js`. The planned prices are typed once for the scripts, in `src/prices.js`; `quiz-check.mjs` compares the plain-text copies in `src/index.html`, `src/hosting/index.html` and `src/llms.txt` with it.
- The Hub preview keeps its sample in `src/hub-data.js`; `preview-check.mjs` compares the rows, costs and counts written in `src/index.html` with it.

To look at the page:

```
node build.mjs && python3 -m http.server 4173 -d dist
```

Check it at 1440 px, at phone width (390 px) and in between (600, 768, 1024 px), in both themes. The request page is `src/hosting/index.html`, linked as `/hosting/`, so its address is the same on any static server and under the Worker's asset handling. There must be no horizontal scroll at any width, and touch targets on phones are at least 44 px high.

## Content rules

- Every claim about Taskcell must be true on `main`. Name the release when a feature is not in the latest tag.
- Security wording must match `docs/security/` and `SECURITY.md`. Do not describe how to exploit anything.
- Keep the existing type (Schibsted Grotesk, Atkinson Hyperlegible, IBM Plex Mono), palette tokens in `src/site.css` and both themes (dark is the design; the light theme re-declares the same tokens, and the factory scene stays dark in it).
- Hosting, the dedicated server, backups and prices are planned: say so wherever they appear. Sample data in the previews must read as sample data.

## Deploy

Deployed by hand by a maintainer, never from CI:

```
pnpm run deploy
```

`wrangler.jsonc` serves `dist/` behind `worker.js`, which only redirects `www` to the apex.
