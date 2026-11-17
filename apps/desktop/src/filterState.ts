/** The one filter state Board and Runs share (persisted): triage, projects, card source, search and grouping. */
import type { BoardTask, RunSummary, TaskSourceId } from './wire';
import { isDemoMode } from './transport';
import { issueNumber } from './runLabels';
import { taskSourceLabel } from './platform';

export type Triage = 'all' | 'running' | 'needs' | 'merged';
export type CardSource = 'github' | 'gitlab' | 'linear' | 'taskcell';
export type Grouping = 'none' | 'project' | 'source' | 'triage';

export interface HubFilter {
  triage: Triage;
  /** Selected repository paths; empty = every repository. */
  repos: string[];
  /** Selected card sources; empty = every source. */
  sources: CardSource[];
  query: string;
  group: Grouping;
}

export const DEFAULT_FILTER: HubFilter = { triage: 'all', repos: [], sources: [], query: '', group: 'none' };

export const TRIAGES: { value: Triage; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'needs', label: 'Waiting for you' },
  { value: 'merged', label: 'Merged' },
];
/** Card sources by the names Settings gives them (`TASK_SOURCES`): one name per source on every screen. */
export const SOURCES: { value: CardSource; label: string }[] = [
  { value: 'github', label: taskSourceLabel('github') },
  { value: 'gitlab', label: taskSourceLabel('gitlab') },
  { value: 'linear', label: taskSourceLabel('linear') },
  { value: 'taskcell', label: taskSourceLabel('hub') },
];
export const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'project', label: 'Project' },
  { value: 'source', label: 'Card source' },
  { value: 'triage', label: 'Triage' },
];

const KEY = 'vanguard.hubFilter';
/** The demo keeps its own filter, so a search typed there never reaches the real projects. */
const key = (): string => (isDemoMode() ? `${KEY}.demo` : KEY);
/** The single-repository choice (a path, or `all`) the filter replaced; carried over once. */
const LEGACY_KEY = 'vanguard.repoFilter';

const oneOf = <T extends string>(list: { value: T }[], v: unknown, fallback: T): T =>
  list.some((x) => x.value === v) ? (v as T) : fallback;

/** Reads the saved state, repairing anything malformed back to its default. */
export function loadFilter(): HubFilter {
  try {
    const saved = localStorage.getItem(key());
    const legacy = isDemoMode() ? null : localStorage.getItem(LEGACY_KEY);
    if (saved === null && legacy && legacy !== 'all') return { ...DEFAULT_FILTER, repos: [legacy] };
    const raw = JSON.parse(saved ?? 'null') as Partial<Record<keyof HubFilter, unknown>> | null;
    if (raw === null || typeof raw !== 'object') return DEFAULT_FILTER;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      triage: oneOf(TRIAGES, raw.triage, 'all'),
      repos: strings(raw.repos),
      sources: strings(raw.sources).filter((s): s is CardSource => SOURCES.some((x) => x.value === s)),
      query: typeof raw.query === 'string' ? raw.query : '',
      group: oneOf(GROUPINGS, raw.group, 'none'),
    };
  } catch {
    return DEFAULT_FILTER;
  }
}

export function saveFilter(f: HubFilter): void {
  try {
    localStorage.setItem(key(), JSON.stringify(f));
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
}

/** The bucket a card falls in: the factory has it, a human has to act, it is merged, or none of those. */
export function cardTriage(t: Pick<BoardTask, 'column'>): Exclude<Triage, 'all'> | 'other' {
  if (t.column === 'claimed' || t.column === 'running') return 'running';
  if (t.column === 'review' || t.column === 'verify-failed') return 'needs';
  if (t.column === 'done') return 'merged';
  return 'other';
}

/**
 * The same bucket for a finished run: failed needs you; merged needs the hub's `prState`, or `cardDone` (its card sits in
 * Done, as the Board's Merged pill reads it). `running` is for active runs only.
 */
export function runTriage(r: Pick<RunSummary, 'anyFailed' | 'prState' | 'stoppedBy' | 'cardDone'>): Exclude<Triage, 'all'> | 'other' {
  if (r.prState === 'merged' || r.cardDone === true) return 'merged';
  return r.anyFailed && r.stoppedBy === undefined ? 'needs' : 'other';
}

/** A card's source; a card without a tracker belongs to the Taskcell board. */
export function cardSource(t: Pick<BoardTask, 'source'>): CardSource {
  return t.source ?? 'taskcell';
}

/** A run's source, from the task id prefix the runners mint (`gh-`, `gl-`, `linear-`). */
export function runSource(taskId: string): CardSource {
  if (/^gh-/i.test(taskId)) return 'github';
  if (/^gl-/i.test(taskId)) return 'gitlab';
  if (/^linear-/i.test(taskId)) return 'linear';
  return 'taskcell';
}

const SOURCE_OF: Record<TaskSourceId, CardSource> = { github: 'github', 'github-project': 'github', gitlab: 'gitlab', linear: 'linear', hub: 'taskcell' };

/** The card sources the projects in scope are configured for (unset = GitHub). */
export function configuredSources(projects: { path: string; taskSource?: TaskSourceId | null }[], scope: string[]): CardSource[] {
  return [...new Set(projects.filter((p) => scope.includes(p.path)).map((p) => SOURCE_OF[p.taskSource ?? 'github']))];
}

/** Sources worth a chip: the configured ones plus any a loaded row actually has (a legacy run stays filterable), in chip order. */
export function offeredSources(configured: CardSource[], present: CardSource[]): CardSource[] {
  const all = new Set([...configured, ...present]);
  return SOURCES.map((s) => s.value).filter((v) => all.has(v));
}

/** The filter as applied: with one source on offer there is no source filter; a saved source no longer offered is ignored
 * (the saved filter itself is never rewritten). `undefined` = rows not loaded yet, nothing to judge by. */
export function effectiveFilter(f: HubFilter, offered: CardSource[] | undefined): HubFilter {
  if (offered === undefined) return f;
  const sources = offered.length <= 1 ? [] : f.sources.filter((s) => offered.includes(s));
  const group = offered.length <= 1 && f.group === 'source' ? 'none' : f.group;
  return sources.length === f.sources.length && group === f.group ? f : { ...f, sources, group };
}

/** A change made in the bar (which shows the effective filter) as it is saved: sources and grouping it did not touch keep their saved value. */
export function saveChange(next: HubFilter, effective: HubFilter, saved: HubFilter): HubFilter {
  return {
    ...next,
    sources: next.sources === effective.sources ? saved.sources : next.sources,
    group: next.group === effective.group ? saved.group : next.group,
  };
}

interface Row {
  triage: Exclude<Triage, 'all'> | 'other';
  source: CardSource;
  repoPath: string | undefined;
  text: string[];
}

function keep(f: HubFilter, r: Row): boolean {
  if (f.triage !== 'all' && r.triage !== f.triage) return false;
  if (f.sources.length > 0 && !f.sources.includes(r.source)) return false;
  if (f.repos.length > 0 && r.repoPath !== undefined && !f.repos.includes(r.repoPath)) return false;
  const q = f.query.trim().toLowerCase();
  return q === '' || r.text.some((s) => s.toLowerCase().includes(q));
}

type RepoRow = { repoPath?: string };

/** What a row's search matches: the task id, `#issue`, and what the board knows of the task (title, labels). */
export function searchText(taskId: string, extra: string[] = []): string[] {
  const n = issueNumber(taskId);
  return [taskId, ...(n !== undefined ? [`#${n}`] : []), ...extra];
}

/** The board's title and labels of a run's task, for its search text; a run record has neither. */
export type RunMeta = (repoPath: string | undefined, taskId: string) => string[];

export function filterCards<T extends BoardTask & RepoRow>(cards: T[], f: HubFilter): T[] {
  return cards.filter((t) => keep(f, { triage: cardTriage(t), source: cardSource(t), repoPath: t.repoPath, text: searchText(t.id, [t.title, ...(t.labels ?? [])]) }));
}

export function filterRuns<T extends RunSummary & RepoRow>(runs: T[], f: HubFilter, meta?: RunMeta): T[] {
  return runs.filter((r) => keep(f, { triage: runTriage(r), source: runSource(r.taskId), repoPath: r.repoPath, text: searchText(r.taskId, meta?.(r.repoPath, r.taskId)) }));
}

/** In-flight runs are "running"; they match no other triage. */
export function filterActive<T extends { taskId: string } & RepoRow>(active: T[], f: HubFilter, meta?: RunMeta): T[] {
  return active.filter((a) => keep(f, { triage: 'running', source: runSource(a.taskId), repoPath: a.repoPath, text: searchText(a.taskId, meta?.(a.repoPath, a.taskId)) }));
}

const TRIAGE_LABEL: Record<string, string> = { running: 'Running', needs: 'Waiting for you', merged: 'Merged', other: 'Other' };
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));

/** The filters narrowing a list, by name, for a "nothing matches" message. */
export function filterNames(f: HubFilter): string[] {
  const q = f.query.trim();
  return [
    ...(f.triage !== 'all' ? [TRIAGE_LABEL[f.triage] ?? f.triage] : []),
    ...f.sources.map((s) => SOURCE_LABEL[s] ?? s),
    ...(f.repos.length > 0 ? ['Projects'] : []),
    ...(q !== '' ? [`search "${q}"`] : []),
  ];
}

/** Can "Clear filters" change anything? It resets search, card source and triage; Projects and grouping stay. */
export const canClearFilters = (f: HubFilter): boolean => f.triage !== 'all' || f.sources.length > 0 || f.query.trim() !== '';
export const clearFilters = (f: HubFilter): HubFilter => ({ ...f, triage: 'all', sources: [], query: '' });

export interface Lane<T> {
  key: string;
  label: string;
  rows: T[];
}

/** Splits rows into lanes by the grouping; `none` is one unlabelled lane. Empty lanes are left out. */
export function groupRows<T extends RepoRow & { repoName?: string }>(
  rows: T[],
  group: Grouping,
  keyOf: { triage: (r: T) => string; source: (r: T) => CardSource },
): Lane<T>[] {
  if (group === 'none') return [{ key: 'all', label: '', rows }];
  const lanes = new Map<string, Lane<T>>();
  for (const r of rows) {
    const named = (k: string, labels: Record<string, string>): [string, string] => [k, labels[k] ?? k];
    const [key, label] =
      group === 'project'
        ? [r.repoPath ?? '', r.repoName ?? r.repoPath ?? 'Project']
        : group === 'source'
          ? named(keyOf.source(r), SOURCE_LABEL)
          : named(keyOf.triage(r), TRIAGE_LABEL);
    const lane = lanes.get(key) ?? { key, label, rows: [] };
    lane.rows.push(r);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export const cardKeys = { triage: cardTriage, source: cardSource };
export const runKeys = { triage: runTriage, source: (r: { taskId: string }): CardSource => runSource(r.taskId) };
