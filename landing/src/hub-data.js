// The Hub preview's sample runs and the rules that move them, kept apart from the page so
// `node preview-check.mjs` can run them without a browser. Everything here is made-up sample data.

export const STAGES = ['Spec', 'Sealed cell', 'Gates', 'Review', 'Pull request'];
/** Seconds a stage takes in the sample, and seconds the preview takes to play it back. */
const SECS = [95, 422, 66, 182, 12];
const PLAY = [2.5, 5, 2.5, 3.5, 1.2];
/** Cells the sample fleet runs at once. */
const SLOTS = 5;

// p: stages finished, as a fraction (-1 = queued, 5 = pull request open). hold: a spec waiting to be read.
// merged: a person merged the pull request. Claude builds every sample run: Codex reports tokens but no cost.
// The ids and their order are the rows of index.html.
const SAMPLE = [
  { id: 'TC-47', file: 'src/webhooks/retry.ts', ac: 4, by: 'Claude', rev: 'Codex', found: 1, pr: 216, cache: 96, cost: 1.02, p: 1.25 },
  { id: 'TC-48', file: 'src/invoices/pdf.ts', ac: 3, by: 'Claude', rev: 'Codex', found: 2, pr: 217, cache: 97, cost: 0.91, p: 1.5 },
  { id: 'TC-49', file: 'src/export/filter.ts', ac: 2, by: 'Claude', rev: 'Codex', found: 0, pr: 218, cache: 98, cost: 0.49, p: 1 },
  { id: 'TC-46', file: 'src/invoices/archive.ts', ac: 3, by: 'Claude', rev: 'Codex', found: 1, pr: 214, cache: 95, cost: 0.77, p: 3.2 },
  { id: 'IN-7', file: 'src/deploy/token.ts', ac: 2, by: 'Claude', rev: 'Codex', found: 0, pr: 215, cache: 97, cost: 0.44, p: 2.3 },
  { id: 'TC-50', file: 'src/audit/list.ts', ac: 5, by: 'Claude', rev: 'Codex', found: 0, pr: 0, cache: 0, cost: 0, p: 0.9, hold: true },
  { id: 'TC-52', file: 'src/export/limit.ts', ac: 4, by: 'Claude', rev: 'Codex', found: 0, pr: 219, cache: 96, cost: 0.66, p: -1 },
  { id: 'TC-53', file: 'src/settings/theme.ts', ac: 3, by: 'Claude', rev: 'Codex', found: 1, pr: 220, cache: 97, cost: 0.72, p: -1 },
  { id: 'TC-44', file: 'src/export/csv.ts', ac: 4, by: 'Claude', rev: 'Codex', found: 1, pr: 212, cache: 97, cost: 0.84, p: 5 },
  { id: 'TC-45', file: 'src/totals/round.ts', ac: 2, by: 'Claude', rev: 'Codex', found: 0, pr: 213, cache: 98, cost: 0.61, p: 5 },
  { id: 'TC-43', file: 'src/fees/late.ts', ac: 3, by: 'Claude', rev: 'Claude', found: 0, pr: 211, cache: 96, cost: 1.27, p: 5, repair: true, merged: true },
  { id: 'TC-42', file: 'src/webhooks/verify.ts', ac: 3, by: 'Claude', rev: 'Codex', found: 2, pr: 210, cache: 95, cost: 0.93, p: 5, merged: true },
  { id: 'TC-41', file: 'src/invoices/number.ts', ac: 2, by: 'Claude', rev: 'Codex', found: 3, pr: 209, cache: 98, cost: 0.58, p: 5, merged: true },
];

/** A fresh copy of the sample, as written. */
export const sample = () => SAMPLE.map((r) => ({ ...r }));

/** The Hub board column a run stands in. */
export const column = (r) => (r.p < 0 ? 'Queued' : r.hold ? 'Claimed' : r.p < 5 ? 'Running' : r.merged ? 'Done' : 'Review');
/** A finished run's cost line; empty while the run has no cost record. */
export const cost = (r) =>
  r.p < 5 ? '' : `$${r.cost.toFixed(2)} · cache ${r.cache}% · ${r.by}, ${r.repair ? '1 repair' : `${r.rev} review`}`;

/**
 * Moves the sample forward by `dt` seconds of playback: running runs advance through their stages and
 * a free cell takes the next queued card. Returns false when nothing is left to move.
 */
export function advance(runs, dt) {
  const moving = (r) => r.p >= 0 && r.p < 5 && !r.hold;
  for (const r of runs) if (moving(r)) r.p = Math.min(5, r.p + dt / PLAY[Math.floor(r.p)]);
  let live = runs.filter(moving).length;
  for (const r of runs) {
    if (live >= SLOTS || r.p >= 0) continue;
    r.p = 0;
    live += 1;
  }
  return live > 0;
}

/** "7m 02s" for a number of seconds. */
export const clock = (s) => {
  const n = Math.round(s);
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`;
};
/** Share of stage `i` a run has done, 0 to 1. */
export const share = (r, i) => Math.min(1, Math.max(0, r.p - i));
/** Sample seconds stage `i` of a run has taken so far (0 when it has not started). */
export const elapsed = (r, i) => SECS[i] * share(r, i);

const stageLines = (r) => [
  ['planner read the code', `spec posted on the issue: ${r.ac} acceptance criteria`],
  ['cell started: non-root, no repository token', `agent is editing ${r.file}`, `agent is writing ${r.file.replace('.ts', '.test.ts')}`],
  r.repair ? ['gates: verify failed, 2 tests red', 'repair 1: verify passed, secret scan clean'] : ['gates: verify passed', 'gates: secret scan clean'],
  [`review (${r.rev}): reading the diff in a fresh context`, r.found ? `review (${r.rev}): ${r.found} finding${r.found > 1 ? 's' : ''} fixed` : `review (${r.rev}): no findings`],
  ['host pushed the branch', `PR #${r.pr} opened, ${r.merged ? 'merged by a person' : 'ready for review'}`],
];
/** The last lines of a run's log at its current progress. */
export function log(r) {
  if (r.p < 0) return ['No run yet. The card is waiting for the factory.'];
  const lines = stageLines(r).flatMap((ls, i) => ls.slice(0, Math.ceil(share(r, i) * ls.length)));
  if (r.hold) lines.push('the build starts when the reading window ends');
  return lines.slice(-5);
}
