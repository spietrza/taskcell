# taskcell.dev

The landing page for Taskcell. Static HTML, CSS and a little JavaScript in `src/`, no framework and no dependencies. The factory scene in `src/scene/` is a plain ES module that imports a vendored three.js.

## Build and check

```
pnpm run check
```

This runs `node build.mjs`, `node quiz-check.mjs` and `node preview-check.mjs`. Run it after every change; `pnpm run deploy` runs it first and stops when one of them fails.

- The build copies `src/` to `dist/` and fails if any local reference in the HTML, CSS or JS points at a missing file.
- The readiness quiz keeps its rules in `src/quiz.js`. The planned prices are typed once for the scripts, in `src/prices.js`; `quiz-check.mjs` compares the plain-text copies in `src/index.html`, `src/hosting/index.html` and `src/llms.txt` with it.
- The Hub section is the app's own markup: `hub/render.mjs` runs the real `App` on the demo fixtures in jsdom (`apps/desktop/src/dev/landingScene.tsx`), compiles the app's tokens (`apps/desktop/src/tokens.css`) and the utilities that markup uses, and the build writes the result into `index.html` (at `<!--hub-app-->`) and `dist/hub-app.css`. It needs `pnpm --dir apps/desktop install --frozen-lockfile` first. `src/hub-data.js` only animates it (class toggles); `preview-check.mjs` compares the page with the app's stage and column names, runs the animator on the built page and checks contrast in both themes. No React ships.
- Both checks also read the Polish copy in `dist/pl/`, so run them after the build.

## Languages

English is the source and stays at `/`, `/hosting/` and `/404.html`. Polish is generated: `node build.mjs` writes `dist/pl/<file>` for every file named in `i18n/pl.mjs` (the three pages, `site.js`, `hub-data.js`, `quiz.js`, `prices.js` and the scene), by swapping each English string for its Polish one. Links to pages and those scripts are pointed into `/pl/`; assets stay shared. Each page carries `hreflang` alternates (en, pl, x-default) and its own canonical, and `src/sitemap.xml` lists both languages.

To add or change a string: edit the English in `src/`, then add or update its `[english, polish]` pair in `i18n/pl.mjs` under the same file (`'*.html'` for the bar and footer every page shares). The English side must match the source exactly, markup included; a pair that no longer matches fails the build, so a changed English text cannot silently stay English in Polish. Scripts that render text (quiz, Hub preview, price switch, scene labels) are translated the same way, as code strings. Text that CSS writes (`content:`) gets a `:lang(pl)` rule in `src/site.css`.

Polish copy: plain and concrete, no em dashes; names stay as they are (Taskcell, Hub, Self-host, pull request / PR, labels such as `ready for agent`). Prices read `14 €` and `11,20 €`, with a non-breaking space before the sign.

The EN / PL switch in the bar stores the choice in `localStorage` (`lang`). `src/theme.js`, already a blocking script in every head, sends a first visit to the page's Polish alternate when the browser's first language is Polish, or when the visit comes from Poland and the browser's first language is English or unset (the Worker writes the country on `<html data-country>`; on a plain static server only the browser's language counts), only while no choice is stored and only from English to Polish, so a visitor who chose is never moved and crawlers cannot loop. It is a script and not the Worker because the switch has to be remembered without cookies or per-language caching, and it works the same on any static server; it is a file and not an inline script because the CSP allows scripts from `'self'` only. Without JavaScript nobody is redirected and the switch is a plain link.

The fonts in `src/fonts/` are Latin subsets; the `-ext` files add Latin Extended (Polish letters) through `unicode-range`, so only pages that use those letters load them.

To look at the page:

```
node build.mjs && python3 -m http.server 4173 -d dist
```

Check it at 1440 px, at phone width (390 px) and in between (600, 768, 1024 px), in both themes. The request page is `src/hosting/index.html`, linked as `/hosting/`, so its address is the same on any static server and under the Worker's asset handling. There must be no horizontal scroll at any width, and touch targets on phones are at least 44 px high.

## Content rules

- Every claim about Taskcell must be true on `main`. Name the release when a feature is not in the latest tag.
- Security wording must match `docs/security/` and `SECURITY.md`. Do not describe how to exploit anything.
- Keep the existing type (Schibsted Grotesk, Atkinson Hyperlegible, IBM Plex Mono), palette tokens in `src/site.css` and both themes (dark is the design; the light theme re-declares the same tokens). The factory scene takes its colours from `PALETTES` in `src/site.js`, one per theme, and is rebuilt when the theme changes; in the light theme the poster is the dark render inverted by CSS.
- Hosting, the dedicated server, backups and prices are planned: say so wherever they appear. Sample data in the previews must read as sample data.

## Deploy

Deployed by hand by a maintainer, never from CI:

```
pnpm run deploy
```

`wrangler.jsonc` serves `dist/` behind `worker.js`, which redirects `www` to the apex, answers Markdown requests with `llms.txt`, and writes the visitor's country on `<html data-country>`.

### Currency and checkout

The Worker writes the visitor's currency on `<html data-currency>`: złoty in Poland, euro in the rest of Europe and when the country is unknown, dollars elsewhere (`currencyFor` in `checkout.js`). `src/prices.js` holds the amounts for all three (`AMOUNTS`, the same as the Stripe prices, VAT included) and repaints the euro prices typed into the pages; without the Worker or without JavaScript the page shows euro.

`GET /checkout?plan=solo|team|pro|pass&period=monthly|yearly` opens a Stripe Checkout session in that currency, with automatic tax, and redirects to it. The `CHECKOUT` variable in `wrangler.jsonc` decides who gets one:

- unset: nobody; `/checkout` answers with the request page.
- `test` (the current value): only links that carry `test=1`, against the Stripe sandbox. Open the site as `https://taskcell.dev/?checkout=test` and the plan buttons lead to a sandbox checkout; for everyone else they keep leading to the request page.
- `live`: everybody, against the live account. Do not set it while hosting is planned: the page says nothing can be bought, no server is started for an order, and the notice after a payment on `/hosting/` speaks of a test payment.

After a paid pass, `/hosting/` offers Solo with the pass credited; that link carries the pass's checkout session id, which the Worker looks up in the orders database to reuse the same Stripe customer.

`node checkout-check.mjs` (part of `pnpm run check`) covers the currency rule, the closed default and what is sent to Stripe.

### Security scores

The three scores under Security (OpenSSF Scorecard, OpenSSF Best Practices, Mozilla Observatory) are text chips in
the page's own style, not badge images. Each value sits in `<b data-score="<name>">` with the last known value as
its text; the Worker (`badges.js`) fetches the live one from the issuer, caches it for a day and writes it in with
HTMLRewriter. A value that does not match its expected shape (a number from 0 to 10, a badge level, a letter grade)
is dropped and the page keeps its own text. `badges-check.mjs` covers it. When a score changes for good, update the
text in `index.html` too, so the page is right even when an issuer is down.

## Stripe webhook

`worker.js` also hands `POST /stripe/webhook` to `stripe-webhook.js`. It checks Stripe's signature, records each paid checkout once in the D1 database `taskcell-orders` (binding `ORDERS`, table in `orders.sql`), and credits a paid 7-day pass to the customer's Stripe balance so their first subscription invoice is lower by that amount. Each order keeps what was charged after any credit (`paid_amount`, in the order's `currency`) next to what Stripe pays out after its fee (`payout_amount`, `payout_currency`); the payout currency is the bank account the money lands on. It does not start a server yet: orders stay in status `paid` until provisioning exists. Hosting is still planned and the pricing buttons do not lead to a checkout.

The Worker needs four secrets, set with `pnpm dlx wrangler@4 secret put <NAME>` and never committed: `STRIPE_WEBHOOK_SECRET_TEST` and `STRIPE_WEBHOOK_SECRET_LIVE` (the signing secret of the webhook endpoint in the Stripe sandbox and in the live account), `STRIPE_KEY_TEST` and `STRIPE_KEY_LIVE` (a Stripe key that can read checkout sessions and charges and write customer balance transactions). An event is checked against the secret of its own mode, so a missing live secret refuses live events and leaves the sandbox working. The checkout must create a customer (`customer_creation: always` for the pass), or there is nobody to credit.

`node stripe-webhook-check.mjs` (part of `pnpm run check`) covers the signature, the repeated delivery and the single credit.
