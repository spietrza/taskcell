// Checks the Hub preview's sample rules: node preview-check.mjs (no dependencies, no browser). Run node build.mjs
// first: the Polish page and sample it writes to dist/pl/ are checked too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAGES, advance, clock, column, cost, elapsed, log, sample } from './src/hub-data.js';

const runs = sample();
const count = (col) => runs.filter((r) => column(r) === col).length;
const counts = () => ['Queued', 'Claimed', 'Running', 'Verify failed', 'Review', 'Done'].map(count);
assert.deepEqual(counts(), [2, 1, 5, 0, 2, 3]);
assert.equal(STAGES.length, 5);

// The page's rows are the same runs, in the columns the sample starts in.
const html = readFileSync(new URL('./src/index.html', import.meta.url), 'utf8');
const rows = [...html.matchAll(/data-run="([^"]+)" data-col="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
assert.deepEqual(rows, runs.map((r) => `${r.id}:${column(r)}`));

// So are the cost records and the counts the page shows before the script runs.
const costs = Object.fromEntries([...html.matchAll(/data-run="([^"]+)"[^>]*data-cost="([^"]+)"/g)].map((m) => [m[1], m[2]]));
assert.deepEqual(costs, Object.fromEntries(runs.filter((r) => cost(r)).map((r) => [r.id, cost(r)])));
const shown = [...html.matchAll(/data-col="([^"]+)" aria-pressed="false">[^<]+<em>(\d+)<\/em>/g)].map((m) => [m[1], Number(m[2])]);
assert.deepEqual(shown, ['Queued', 'Claimed', 'Running', 'Verify failed', 'Review', 'Done'].map((col) => [col, count(col)]));
assert.ok(html.includes(`All runs<em>${runs.length}</em>`));
for (const [repo, n] of html.matchAll(/data-repo="([^"]+)" aria-pressed="false">[^<]+<em>(\d+)<\/em>/g).map((m) => [m[1], Number(m[2])]))
  assert.equal([...html.matchAll(new RegExp(`data-run="[^"]+" data-col="[^"]+" data-repo="${repo}"`, 'g'))].length, n, `${repo} count`);

for (const r of runs) {
  assert.ok(log(r).length >= 1 && log(r).length <= 12);
  assert.equal(cost(r) !== '', r.p >= 5, 'only a finished run has a cost record');
}

// Playback: never more than five cells busy; every started card ends as a pull request for a person to merge.
let steps = 0;
while (advance(runs, 0.25)) {
  assert.ok(count('Running') <= 5, 'at most five cells busy');
  assert.ok(++steps < 2000, 'the sample ends');
}
assert.deepEqual(counts(), [0, 1, 0, 0, 9, 3]);
// The open run written in index.html is the first sample run as the script paints it.
const first = sample()[0];
assert.deepEqual([...html.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]).filter((t) => log(first).includes(t)), log(first));
assert.equal(log(runs.find((r) => r.id === 'TC-53')).at(-1), 'PR #220 opened, ready for review');
assert.equal(cost(runs[0]), '$1.02 · cache 96% · Claude, Codex review');

// A fresh sample is untouched by the played one.
assert.equal(sample()[6].p, -1);
assert.equal(clock(59), '59s');
assert.equal(clock(422), '7m 02s');
assert.equal(elapsed({ p: 1.5 }, 1), 211);
assert.equal(elapsed({ p: 1.5 }, 2), 0);

// Polish: the page under dist/pl/ shows the same runs, in the same columns, with its own sample's cost lines and log.
const plHtml = readFileSync(new URL('./dist/pl/index.html', import.meta.url), 'utf8');
const pl = await import('./dist/pl/hub-data.js');
const plRuns = pl.sample();
assert.deepEqual([...plHtml.matchAll(/data-run="([^"]+)" data-col="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`), plRuns.map((r) => `${r.id}:${pl.column(r)}`));
const plCosts = Object.fromEntries([...plHtml.matchAll(/data-run="([^"]+)"[^>]*data-cost="([^"]+)"/g)].map((m) => [m[1], m[2]]));
assert.deepEqual(plCosts, Object.fromEntries(plRuns.filter((r) => pl.cost(r)).map((r) => [r.id, pl.cost(r)])));
assert.deepEqual([...plHtml.matchAll(/data-col="([^"]+)" aria-pressed="false">[^<]+<em>(\d+)<\/em>/g)].map((m) => Number(m[2])), [2, 1, 5, 0, 2, 3]);
assert.deepEqual([...plHtml.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]).filter((t) => pl.log(plRuns[0]).includes(t)), pl.log(plRuns[0]));
assert.match(pl.log({ ...plRuns[5], p: 1 }).join('\n'), /5 kryteriów akceptacji/);
assert.equal(pl.cost(plRuns[10]), '$1.27 · cache 96% · Claude, 1 naprawa');

console.log('preview rules ok');
