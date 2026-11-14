/** The one filter state Board and Runs share (persisted): triage, projects, card source, search and grouping. */
import type { BoardTask, RunSummary } from './wire';
import { isDemoMode } from './transport';

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
  { value: 'needs', label: 'Needs you' },
  { value: 'merged', label: 'Merged' },
];
export const SOURCES: { value: CardSource; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'linear', label: 'Linear' },
  { value: 'taskcell', label: 'Taskcell board' },
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

/** The same bucket for a finished run: failed needs you; merged needs the hub's `prState`. `running` is for active runs only. */
export function runTriage(r: Pick<RunSummary, 'anyFailed' | 'prState'>): Exclude<Triage, 'all'> | 'other' {
  if (r.prState === 'merged') return 'merged';
  return r.anyFailed ? 'needs' : 'other';
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

export function filterCards<T extends BoardTask & RepoRow>(cards: T[], f: HubFilter): T[] {
  return cards.filter((t) => keep(f, { triage: cardTriage(t), source: cardSource(t), repoPath: t.repoPath, text: [t.title, t.id] }));
}

export function filterRuns<T extends RunSummary & RepoRow>(runs: T[], f: HubFilter): T[] {
  return runs.filter((r) => keep(f, { triage: runTriage(r), source: runSource(r.taskId), repoPath: r.repoPath, text: [r.taskId] }));
}

/** In-flight runs are "running"; they match no other triage. */
export function filterActive<T extends { taskId: string } & RepoRow>(active: T[], f: HubFilter): T[] {
  return active.filter((a) => keep(f, { triage: 'running', source: runSource(a.taskId), repoPath: a.repoPath, text: [a.taskId] }));
}

const TRIAGE_LABEL: Record<string, string> = { running: 'Running', needs: 'Needs you', merged: 'Merged', other: 'Other' };
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
