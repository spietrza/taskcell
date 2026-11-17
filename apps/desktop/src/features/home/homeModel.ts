import type { ActivityEvent, BoardTask, FactoryState, LocalWorkerState, NeedsYouItem, Project, RepoStamp, RunSummary, ActiveRun } from '../../wire';
import { effectiveRunLocation } from '../../platform';
import { titleKey } from '../../runLabels';
import { STATIONS, STATION_SHORT, cardStationOf } from '../../stations';
import { stageLabel } from '../inspector/runStages';
import { matchNeedsYou } from '../board/QuickView';
import { retryWords } from '../board/paused';
import { relTime } from '../../time';

export type Card = BoardTask & RepoStamp;
export type RunRow = RunSummary & RepoStamp;
export type StampedActive = ActiveRun & RepoStamp;
export type StampedNeeds = NeedsYouItem & Partial<RepoStamp>;

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Moving = claimed or running and not paused. Paused (a provider limit; the factory retries by itself) counts apart, so M never drifts from the Board's running count by more than the paused ones. */
export function stateCounts(tasks: readonly BoardTask[]): { moving: number; paused: number } {
  let moving = 0;
  let paused = 0;
  for (const t of tasks) {
    if (t.paused !== undefined) paused += 1;
    else if (t.column === 'claimed' || t.column === 'running') moving += 1;
  }
  return { moving, paused };
}

export type InboxKind = { caption: string; action: 'Review' | 'Answer'; broken: boolean };

/** The inbox caption and primary action of a waiting item (both `taskcell:` and `vanguard:` labels). */
export function inboxKind(item: Pick<NeedsYouItem, 'kind' | 'reason' | 'ask'>): InboxKind {
  if (item.kind === 'issue' || item.kind === 'card') return { caption: item.ask === 'too-vague' ? 'Too vague' : 'Question', action: 'Answer', broken: false };
  if (item.reason.endsWith(':verify-failed')) return { caption: 'Verify failed', action: 'Review', broken: true };
  if (item.reason === 'changes requested') return { caption: 'Changes requested', action: 'Review', broken: false };
  return { caption: 'PR ready', action: 'Review', broken: false };
}

export interface MovingRow {
  key: string;
  title: string;
  repoPath: string;
  repoName: string;
  status: string;
  paused: boolean;
  /** A paused card's retry, as "after 18:30" or "soon". */
  retry?: string;
  /** A live local run behind the row: the row opens it. */
  run?: StampedActive;
}

/** The sentence under a moving card: where it is on the line and what it does. */
function statusLine(t: Card): string {
  if (t.paused !== undefined) return 'Paused by a provider limit.';
  if (t.schedule !== undefined) return t.schedule.label;
  if (t.column === 'claimed') return 'Writing the spec.';
  // A moving card has no finished run yet: the one mapping places it by its column.
  const station = STATIONS[cardStationOf(t, undefined).at] ?? 'cell';
  return t.stage === undefined ? `${STATION_SHORT[station]}.` : `${STATION_SHORT[station]}: ${stageLabel(t.stage)}`;
}

/** Cards that are moving or paused (running, then claimed, then paused; then by repository), plus live runs no card explains. */
export function movingRows(tasks: readonly Card[], active: readonly StampedActive[], now: number = Date.now()): MovingRow[] {
  const runs = new Map(active.map((r) => [titleKey(r.repoPath, r.taskId), r]));
  const used = new Set<string>();
  const rank = (t: Card): number => (t.paused !== undefined ? 2 : t.column === 'running' ? 0 : 1);
  const cards = tasks
    .filter((t) => t.paused !== undefined || t.column === 'claimed' || t.column === 'running')
    .sort((a, b) => rank(a) - rank(b) || a.repoName.localeCompare(b.repoName));
  const rows = cards.map((t): MovingRow => {
    const key = titleKey(t.repoPath, t.id);
    const run = runs.get(key);
    if (run) used.add(key);
    return { key: `${t.repoPath}:${t.id}`, title: t.title, repoPath: t.repoPath, repoName: t.repoName, status: statusLine(t), paused: t.paused !== undefined, ...(t.paused !== undefined && retryWords(t.paused, now) !== undefined ? { retry: retryWords(t.paused, now) as string } : {}), ...(run ? { run } : {}) };
  });
  for (const [key, r] of runs) {
    if (!used.has(key)) rows.push({ key: `run:${key}`, title: r.taskId, repoPath: r.repoPath, repoName: r.repoName, status: `Live run, last activity ${relTime(r.lastActivityMs)}`, paused: false, run: r });
  }
  return rows;
}

export interface FloorStation {
  /** Open cards on this station. */
  n: number;
  failed: number;
  /** Cards here that are also waiting in the inbox. */
  waiting: number;
}
export interface FloorRow {
  path: string;
  name: string;
  project: Project;
  open: number;
  stations: FloorStation[];
  spendWeek: number;
}

/** One row per project with an open card or a run this week, busiest first; the rest are counted as idle. */
export function floorRows(
  projects: readonly Project[],
  tasks: readonly Card[],
  runs: readonly RunRow[],
  needs: readonly StampedNeeds[],
  now: number = Date.now(),
): { rows: FloorRow[]; idle: number } {
  const prUrls = new Map<string, string>();
  for (const r of runs) if (r.prUrl !== undefined) prUrls.set(titleKey(r.repoPath, r.taskId), r.prUrl);
  // Each card's newest local run: a finished card sits where that run left it (the Runs row's mapping).
  const latest = new Map<string, RunRow>();
  for (const r of runs) {
    const k = titleKey(r.repoPath, r.taskId);
    if (r.source !== 'ci' && (latest.get(k)?.timestamp ?? '') < r.timestamp) latest.set(k, r);
  }
  const rows: FloorRow[] = [];
  for (const p of projects) {
    const stations = STATIONS.map((): FloorStation => ({ n: 0, failed: 0, waiting: 0 }));
    const mine = tasks.filter((t) => t.repoPath === p.path && t.column !== 'done');
    const mineNeeds = needs.filter((i) => i.repoPath === p.path);
    for (const t of mine) {
      const prUrl = prUrls.get(titleKey(t.repoPath, t.id));
      const { at, failed } = cardStationOf(t, latest.get(titleKey(t.repoPath, t.id)), { prExists: prUrl !== undefined });
      const s = stations[at];
      if (!s) continue;
      s.n += 1;
      if (failed) s.failed += 1;
      if (matchNeedsYou(mineNeeds, t, prUrl) !== null) s.waiting += 1;
    }
    const week = runs.filter((r) => r.repoPath === p.path && now - Date.parse(r.timestamp) <= WEEK_MS);
    if (mine.length === 0 && week.length === 0) continue;
    rows.push({ path: p.path, name: p.name, project: p, open: mine.length, stations, spendWeek: week.reduce((n, r) => n + (r.costUnknown === true ? 0 : r.totalCostUsd), 0) });
  }
  rows.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  return { rows, idle: projects.length - rows.length };
}

/**
 * The last seven days: pull requests merged (distinct cards, by run time), runs, failed runs (a provider-limit stop is
 * not a failure), runs that passed after extra attempts (a gate repair, an auto-resume or a fork variant: the records do not tell them apart,
 * so this is not a count of self-repairs) and spend
 * (reported dollars only; `≈` estimates and unknowns stay out).
 */
export function thisWeek(runs: readonly RunRow[], now: number = Date.now()): { merged: number; runs: number; failed: number; retried: number; spend: number } {
  const week = runs.filter((r) => now - Date.parse(r.timestamp) <= WEEK_MS);
  const merged = new Set(week.filter((r) => r.prState === 'merged').map((r) => titleKey(r.repoPath, r.taskId)));
  return {
    merged: merged.size,
    runs: week.length,
    // A run that stopped to ask waits on a person: not a failure here either (the feed says "stopped to ask").
    failed: week.filter((r) => r.anyFailed && r.stoppedBy !== 'provider-limit' && r.asked === undefined).length,
    retried: week.filter((r) => !r.anyFailed && (r.extraAttempts ?? 0) > 0).length,
    spend: week.reduce((n, r) => n + (r.costUnknown === true ? 0 : r.totalCostUsd), 0),
  };
}

const who = (login: string | undefined): string => (login === undefined ? 'Someone' : login === 'token' ? 'You' : login);

/** One feed line in words: who did what. Settings saves name their keys, never values. */
export function activityText(e: ActivityEvent): string {
  switch (e.kind) {
    case 'run-started':
      return `${who(e.login)} started a run`;
    case 'run-finished':
      return `Run ${e.subject ?? ''} finished`.replace('  ', ' ');
    case 'run-failed':
      return `Run ${e.subject ?? ''} failed`.replace('  ', ' ');
    case 'run-asked':
      return `Run ${e.subject ?? ''} stopped to ask`.replace('  ', ' ');
    case 'card-created':
      return e.subject === undefined ? `${who(e.login)} created a card` : `${who(e.login)} created card ${e.subject}`;
    case 'pr-merged':
      return `${who(e.login)} merged PR ${e.subject ?? ''}`.trim();
    case 'settings-changed':
      return `${who(e.login)} changed settings: ${(e.keys ?? []).join(', ')}`;
  }
}

export interface CantStart {
  path: string;
  name: string;
  /** Cards waiting for the factory in this project. */
  count: number;
  /** What is wrong, as the end of "The … for <repo> ": a clause. */
  reason: string;
  /** The dialog that fixes it: the Local hub worker, or the factory checklist. */
  fix: 'worker' | 'factory';
}

/**
 * Projects whose trigger-labelled cards cannot start, from state the app already loads: the Local hub worker is off,
 * blocked, failing or without a credential; or the CI factory is broken. Hub-board projects and self-hosted
 * (`watch`) runners give no signal and are never listed.
 */
export function cantStart(
  projects: readonly Project[],
  tasks: readonly Card[],
  factory: Readonly<Record<string, FactoryState>>,
  workers: Readonly<Record<string, LocalWorkerState>>,
): CantStart[] {
  const out: CantStart[] = [];
  for (const p of projects) {
    if (p.taskSource === 'hub') continue;
    const count = tasks.filter((t) => t.repoPath === p.path && t.waiting === true).length;
    if (count === 0) continue;
    const location = effectiveRunLocation(p.taskSource, p.runLocation);
    if (location === 'local') {
      const w = workers[p.path];
      if (!w) continue;
      const reason = !w.enabled
        ? `The Local hub worker for ${p.name} is off.`
        : w.blocked
          ? `The Local hub worker for ${p.name} is blocked: ${w.blocked}`
          : w.lastError
            ? `The Local hub worker for ${p.name} failed: ${w.lastError}`
            : !w.credentials.present
              ? `The Local hub worker for ${p.name} has no model credential.`
              : null;
      if (reason !== null) out.push({ path: p.path, name: p.name, count, reason, fix: 'worker' });
    } else if (location !== 'watch' && factory[p.path]?.state === 'broken') {
      out.push({ path: p.path, name: p.name, count, reason: `The factory for ${p.name} is broken: ${factory[p.path]?.reason ?? 'unknown'}.`, fix: 'factory' });
    }
  }
  return out;
}
