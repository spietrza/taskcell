// Checks the Hub section: node preview-check.mjs (run node build.mjs first; it reads dist/). The section is the app's own
// markup, rendered from apps/desktop at build time, so this compares what the page shows with the app's sources: a renamed
// stage or column in apps/desktop changes the page, and a hook the animator needs going missing fails the build or here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const desktop = (p) => read(`../apps/desktop/src/${p}`);
const shared = (p) => read(`../packages/hub-client/src/${p}`); // stations.ts moved here with the mobile app
const pages = { en: read('./dist/index.html'), pl: read('./dist/pl/index.html') };
const css = read('./dist/hub-app.css');
const { JSDOM } = createRequire(fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url)))('jsdom');
const app = (html) => html.slice(html.indexOf('id="hub-app"'), html.indexOf('<ul class="hub-screens">'));

// The app's names, from its own source.
const stations = [...shared('stations.ts').matchAll(/^\s+(card|spec|cell|gates|review|pr): '([^']+)',$/gm)];
const stageLabels = stations.map((m) => m[2]);
// The Board's columns: the stations by their short names (STATION_SHORT), Review and PR sharing one, then Done.
const shortOverrides = Object.fromEntries([...shared('stations.ts').matchAll(/STATION_SHORT[^=]*= \{ \.\.\.STATION_LABEL, ([^}]+)\}/g)].flatMap((m) => [...m[1].matchAll(/(\w+): '([^']+)'/g)].map((o) => [o[1], o[2]])));
const short = stations.map(([, key, label]) => shortOverrides[key] ?? label);
const columnLabels = [...short.slice(0, 4), `${short[4]} / ${short[5]}`, 'Done'];
assert.equal(stageLabels.length, 6, 'six stages in stations.ts');
assert.equal(columnLabels.length, 6, 'six columns');

for (const [lang, html] of Object.entries(pages)) {
  const hub = app(html);
  // The shell: top bar with team switcher and navigation, six-column Board, the card drawer.
  assert.match(hub, /aria-label="Taskcell Hub — home"/, `${lang}: top bar`);
  assert.match(hub, /aria-label="Search \/ command palette"/, `${lang}: ⌘K`);
  assert.match(hub, /<nav aria-label="Main"/, `${lang}: main navigation`);
  for (const nav of ['Home', 'Board', 'Runs', 'Settings']) assert.match(hub, new RegExp(`<span>${nav}</span>`), `${lang}: nav ${nav}`);
  assert.match(hub, /aria-label="Team: [^"]+"/, `${lang}: team switcher`);
  const cols = [...hub.matchAll(/data-hub-col="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, columnLabels, `${lang}: board columns are the app's`);
  assert.match(hub, /aria-label="Quick view: /, `${lang}: card drawer`);
  const frames = [...hub.matchAll(/<template data-hub-step="(\d)">(.*?)<\/template>/g)];
  assert.equal(frames.length, 7, `${lang}: a stage line per step`);
  for (const [, , frame] of frames) assert.deepEqual([...frame.matchAll(/<span class="text-sm[^"]*">([^<]+)<\/span><span class="ml-auto/g)].map((m) => m[1]), short);
  assert.deepEqual([...hub.matchAll(/data-status="([a-z]+)"/g)].slice(0, 6).length, 6);
  // Nothing the app does not show.
  assert.doesNotMatch(hub, /cache\s*\d|cache %|Repositories|repair 1:|\bsealed in\b/i, `${lang}: only what the app shows`);
  assert.doesNotMatch(hub, /\bstyle="/, `${lang}: no inline style (the CSP forbids it)`);
  assert.doesNotMatch(hub, /<script/i, `${lang}: markup only`);
  // Production render: no dev-only overlay (TailwindDebugScreens' viewport badge is `fixed`, and would pin to the visitor's viewport).
  const fixed = [...hub.matchAll(/class="([^"]*)"/g)].filter((m) => m[1].split(/\s+/).includes('fixed'));
  assert.deepEqual(fixed.map((m) => m[1]), [], `${lang}: no fixed (dev debug) element in the Hub section`);
  // The control and the sample label sit on the page; the app's own demo banner says it is sample data.
  assert.match(html, /id="hub-pause"[^>]*>(Play preview|Odtwórz podgląd)</);
  assert.match(hub, /Demo project — sample data, read-only/);
}
assert.match(pages.en, /<button class="pause" id="hub-pause" type="button" hidden>Play preview<\/button>/);
assert.match(read('./src/site.js'), /'Pause preview'/, 'the pause control reads "Pause preview"');
assert.match(read('./dist/pl/site.js'), /'Pauza podglądu'/);
// /pl/ stays Polish around the app's (English) markup: every English string the page itself writes in the Hub section, and
// both pause controls' labels in site.js, have a pl.mjs pair.
{
  const { PL } = await import('./i18n/pl.mjs');
  const english = [...PL['index.html'], ...PL['*.html']].map(([en]) => en);
  const section = new JSDOM(read('./src/index.html')).window.document.getElementById('hub');
  const walker = section.ownerDocument.createTreeWalker(section, 4 /* text */);
  const strings = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) strings.push(n.textContent.trim());
  for (const el of section.querySelectorAll('[aria-label], [title], [alt]')) strings.push(...['aria-label', 'title', 'alt'].map((a) => el.getAttribute(a)));
  for (const s of strings.filter(Boolean)) assert.ok(english.some((en) => en.includes(s)), `pl.mjs: no pair for the Hub section's "${s}"`);
  assert.doesNotMatch(read('./dist/pl/site.js'), /'(Play|Pause)( preview)?'/, 'pl: a pause control label is English');
}
assert.doesNotMatch(read('./src/hub-data.js') + read('./src/site.js'), /from 'react|react-dom/, 'no React on the page');

// Theme follows the page: tokens live on the section, light by default and dark under the page's data-theme.
assert.match(css, /:root\[data-theme=dark\] \.hub-app\{/);
assert.doesNotMatch(css.replace(/\.dark\\:/g, ''), /:root\{|\.dark[{ ,]/);
const tokens = (re) => {
  const out = {};
  for (const [, body] of css.matchAll(re)) for (const [, name, value] of body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\b/g)) out[name] = value;
  return out;
};
const light = tokens(/(?:^|[}\n])\.hub-app\{([^}]*)\}/g);
const dark = { ...light, ...tokens(/:root\[data-theme=dark\] \.hub-app\{([^}]*)\}/g) };
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
for (const [theme, t] of Object.entries({ light, dark })) {
  for (const [fg, bg] of [['foreground', 'background'], ['foreground', 'muted'], ['muted-foreground', 'background'], ['muted-foreground', 'muted'], ['caption', 'background'], ['primary-foreground', 'primary']]) {
    assert.ok(t[fg] && t[bg], `${theme}: ${fg} and ${bg} are tokens`);
    assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${theme}: ${fg} on ${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1, under 4.5:1`);
  }
}
assert.notEqual(light.background, dark.background, 'two themes');

// The animator, on the built page in jsdom: each step shows the stage line, column and counts the app would.
const { hubAnimator, STEPS, COLUMN_AT } = await import('./src/hub-data.js');
const dom = new JSDOM(pages.en);
const root = dom.window.document.getElementById('hub-app');
const hub = hubAnimator(root);
assert.ok(hub, 'the animator finds its hooks in the built markup');
assert.equal(STEPS, 7);
const stageStatuses = () => [...root.querySelectorAll('[data-hub-stages] > li')].map((li) => li.dataset.status).join(' ');
const sizes = () => [...root.querySelectorAll('[data-hub-col]')].map((c) => c.querySelectorAll('[data-hub-card]').length);
const before = sizes();
assert.equal(before.reduce((a, b) => a + b, 0), 10);
for (let step = 0; step < STEPS; step++) {
  hub.paint(step);
  const states = stageStatuses().split(' ');
  assert.equal(states.length, 6);
  assert.deepEqual(states.map((s) => s === 'done').lastIndexOf(true) + 1, step === 6 ? 6 : step, `step ${step}: stages before the current one are done`);
  assert.equal(root.querySelector('[data-hub-open]').closest('[data-hub-col]').dataset.hubCol, columnLabels[COLUMN_AT[step]]);
  assert.equal(sizes().reduce((a, b) => a + b, 0), 10, 'cards move, none appear or vanish');
  const counts = [...root.querySelectorAll('[data-hub-count]')].map((c) => Number(c.textContent));
  assert.deepEqual(counts, sizes(), `step ${step}: the column counts follow the cards`);
  assert.match(root.querySelector('[data-hub-counts]').textContent, /^Running \d+ · Queued \d+ · Waiting for you \d+$/);
}
hub.paint(2);
assert.deepEqual(sizes(), before, 'the app’s own frame is step 2');
console.log('preview rules ok');
