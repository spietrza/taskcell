# taskcell.dev

The landing page for Taskcell. Static HTML, CSS and a little JavaScript in `src/`, no framework and no dependencies. The factory scene in `src/scene/` is a plain ES module that imports a vendored three.js.

## Build and check

```
node build.mjs
```

This copies `src/` to `dist/` and fails if any local reference in the HTML, CSS or JS points at a missing file. Run it after every change.

The readiness quiz and the Hub preview keep their rules in `src/quiz.js` and `src/hub-data.js`; check them with `node quiz-check.mjs` and `node preview-check.mjs`.

To look at the page:

```
node build.mjs && python3 -m http.server 4173 -d dist
```

Check it at 1440 px and at phone width (390 px). There must be no horizontal scroll at any width, and touch targets on phones are at least 44 px high.

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
