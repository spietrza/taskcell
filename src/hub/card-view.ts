// Where a card sits on the line: the card, its newest local run and its waiting needs-you item, joined here once for every
// client (Board, quick view, Home, Runs, the phone). Pure: run records, the board and the needs-you list in, views out.
// The clients render the answer; none of them joins runs to cards itself.
import { newestRuns } from '../core/run-store.js';
import { runStateWord } from '../run-labels.js';
import { STATIONS, stationOf, stationOfStage } from '../stations.js';
import { taskRefKey } from '../tasks/board.js';
import type { BoardTask, CardPlace, CardView, NeedsYouItem, RunOutcome, RunSummary } from '../wire.js';

export { newestRuns };

const PAST_THE_LINE = STATIONS.length;

/**
 * Where a finished run leaves its card: a merged PR, or a passed run whose card is done without a PR (a local branch), is
 * past the line; a failed verify marks Gates red; a failed stage marks its station red (a provider-limit stop sits
 * there, not failed); a run whose agent stopped to ask waits in the Cell (Gates shown passed when its proof says so);
 * anything else, with or without a PR, waits on the PR station.
 */
function runPlace(run: RunSummary): CardPlace {
  const failed = run.anyFailed || run.verifyFailed === true;
  if (run.prState === 'merged' || (run.cardDone === true && !failed)) return { at: PAST_THE_LINE, failed: false };
  const stageAt = STATIONS.indexOf(stationOfStage(run.failedStage) ?? 'cell');
  if (run.stoppedBy !== undefined) return { at: stageAt, failed: false };
  if (run.asked !== undefined && run.verifyFailed !== true) return { at: 2, failed: false, ...(run.verifyPassed === true ? { passed: [3] } : {}) };
  if (run.verifyFailed === true) return { at: 3, failed: true };
  if (run.anyFailed) return { at: stageAt, failed: true };
  return { at: 5, failed: false };
}

/** A run's outcome: its state word and its place on the line. The one derivation behind the Runs row, the run page and the card. */
export function runOutcome(run: RunSummary): RunOutcome {
  return { state: runStateWord(run), place: runPlace(run) };
}

/** `runs` with their outcome (what the Runs row shows). Mark done cards first (`markDone`): merged and "done, no PR" depend on it. */
export function withOutcomes<T extends RunSummary>(runs: readonly T[]): T[] {
  return runs.map((r) => ({ ...r, outcome: runOutcome(r) }));
}

/**
 * Runs whose card sits in the board's Done column (`done`: their `taskRefKey`s): one with a PR is marked merged; a passed
 * one without a PR (a hub card's local branch), or one whose agent stopped to ask (a done card waits on no answer), `cardDone`.
 */
export function markDone<T extends RunSummary>(runs: readonly T[], done: ReadonlySet<string>): T[] {
  return runs.map((r) => {
    if (!done.has(taskRefKey(r.taskId))) return r;
    if (r.prUrl !== undefined) return { ...r, prState: 'merged' as const };
    return r.anyFailed && r.asked === undefined ? r : { ...r, cardDone: true as const };
  });
}

/**
 * The needs-you item that is THIS card: its question (a `card` item), its pull request (same address), or, for a GitHub
 * card only, the issue with the card's number. Never by number alone across trackers: a Linear card's digits can equal
 * an unrelated GitHub issue's.
 */
function waitingItem(items: readonly NeedsYouItem[], task: BoardTask, prUrl: string | undefined): NeedsYouItem | undefined {
  const key = taskRefKey(task.id);
  const m = /(\d+)$/.exec(key);
  const number = m !== null && !/^gh-pr-\d+$/.test(key) ? Number(m[1]) : undefined;
  return items.find((i) =>
    i.kind === 'card' ? i.id === key
    : i.kind === 'pr' ? prUrl !== undefined && i.url === prUrl
    : task.source === 'github' && number !== undefined && i.number === number);
}

/**
 * Each card of one repository with its view. `runs`: every run record of the repository (CI imports are ignored; a done
 * card's runs are marked from the board itself); `needsYou`: the repository's waiting items.
 * A card in Review or failed sits where its newest run left it; any other card by its column.
 */
export function withCardViews<T extends BoardTask>(tasks: readonly T[], runs: readonly RunSummary[], needsYou: readonly NeedsYouItem[]): T[] {
  const done = new Set(tasks.filter((t) => t.column === 'done').map((t) => taskRefKey(t.id)));
  const newest = newestRuns(markDone(runs, done));
  return tasks.map((task) => {
    const run = newest.get(taskRefKey(task.id));
    const finished = task.column === 'review' || task.column === 'verify-failed';
    const outcome = run === undefined ? undefined : runOutcome(run);
    const place = finished && outcome !== undefined ? outcome.place : stationOf(task, { prExists: run?.prUrl !== undefined });
    const waiting = waitingItem(needsYou, task, run?.prUrl);
    const view: CardView = {
      place,
      ...(run !== undefined && outcome !== undefined ? { run: { ...outcome, timestamp: run.timestamp, ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}) } } : {}),
      ...(waiting !== undefined ? { waiting } : {}),
    };
    return { ...task, view };
  });
}
