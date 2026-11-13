import { beforeEach, expect, test } from 'vitest';
import { DEFAULT_FILTER, cardKeys, filterCards, filterRuns, groupRows, loadFilter, runKeys, runSource, saveFilter, type HubFilter } from './filterState';
import type { BoardTask, RunSummary } from './wire';

const card = (id: string, column: BoardTask['column'], extra: Partial<BoardTask> & { repoPath?: string; repoName?: string } = {}): BoardTask & { repoPath: string; repoName: string } => ({
  id, title: `Title ${id}`, column, state: '', repoPath: '/a', repoName: 'a', ...extra,
});
const cards = [
  card('gh-1', 'running', { source: 'github' }),
  card('gl-2', 'review', { source: 'gitlab', repoPath: '/b', repoName: 'b' }),
  card('linear-3', 'done', { source: 'linear' }),
  card('tc-4', 'queued'),
];
const f = (p: Partial<HubFilter>): HubFilter => ({ ...DEFAULT_FILTER, ...p });
const ids = (l: { id: string }[]): string[] => l.map((x) => x.id);

test('triage narrows cards', () => {
  expect(ids(filterCards(cards, f({ triage: 'running' })))).toEqual(['gh-1']);
  expect(ids(filterCards(cards, f({ triage: 'needs' })))).toEqual(['gl-2']);
  expect(ids(filterCards(cards, f({ triage: 'merged' })))).toEqual(['linear-3']);
  expect(filterCards(cards, f({ triage: 'all' }))).toHaveLength(4);
});

test('several projects, source and search narrow cards', () => {
  expect(ids(filterCards(cards, f({ repos: ['/a', '/b'] })))).toHaveLength(4);
  expect(ids(filterCards(cards, f({ repos: ['/b'] })))).toEqual(['gl-2']);
  expect(ids(filterCards(cards, f({ sources: ['github', 'linear'] })))).toEqual(['gh-1', 'linear-3']);
  expect(ids(filterCards(cards, f({ sources: ['taskcell'] })))).toEqual(['tc-4']);
  expect(ids(filterCards(cards, f({ query: 'TITLE GL-2' })))).toEqual(['gl-2']);
  expect(ids(filterCards(cards, f({ query: 'gl-2' })))).toEqual(['gl-2']);
  expect(ids(filterCards(cards, f({ query: 'title tc' })))).toEqual(['tc-4']);
});

const run = (taskId: string, extra: Partial<RunSummary> = {}): RunSummary & { repoPath: string } => ({
  taskId, timestamp: 't', stages: [], totalCostUsd: 0, anyFailed: false, repoPath: '/a', ...extra,
});

test('runs filter by triage (merged from prState), source and search', () => {
  const runs = [run('gh-1', { prUrl: 'u', prState: 'merged' }), run('gl-2', { anyFailed: true }), run('x-3')];
  expect(filterRuns(runs, f({ triage: 'merged' })).map((r) => r.taskId)).toEqual(['gh-1']);
  expect(filterRuns(runs, f({ triage: 'needs' })).map((r) => r.taskId)).toEqual(['gl-2']);
  expect(filterRuns(runs, f({ sources: ['taskcell'] })).map((r) => r.taskId)).toEqual(['x-3']);
  expect(filterRuns(runs, f({ query: 'gl' })).map((r) => r.taskId)).toEqual(['gl-2']);
  expect(runSource('linear-9')).toBe('linear');
});

test('grouping by project, source and triage', () => {
  expect(groupRows(cards, 'none', cardKeys)).toHaveLength(1);
  expect(groupRows(cards, 'project', cardKeys).map((l) => [l.label, l.rows.length])).toEqual([['a', 3], ['b', 1]]);
  expect(groupRows(cards, 'source', cardKeys).map((l) => l.label)).toEqual(['GitHub', 'GitLab', 'Linear', 'Taskcell board']);
  expect(groupRows(cards, 'triage', cardKeys).map((l) => l.label)).toEqual(['Merged', 'Needs you', 'Other', 'Running']);
  const runs = [run('gh-1'), run('gl-2')];
  expect(groupRows(runs, 'source', runKeys).map((l) => l.label)).toEqual(['GitHub', 'GitLab']);
});

beforeEach(() => localStorage.clear());
test('the whole state survives a reload', () => {
  expect(loadFilter()).toEqual(DEFAULT_FILTER);
  const s = f({ triage: 'needs', repos: ['/a'], sources: ['gitlab'], query: 'x', group: 'source' });
  saveFilter(s);
  expect(loadFilter()).toEqual(s);
  localStorage.setItem('vanguard.hubFilter', '{"triage":"bogus","sources":["nope"]}');
  expect(loadFilter()).toEqual(DEFAULT_FILTER);
});

test('the old single-repository choice carries over once', () => {
  localStorage.setItem('vanguard.repoFilter', '/r/old');
  expect(loadFilter().repos).toEqual(['/r/old']);
  localStorage.setItem('vanguard.repoFilter', 'all');
  expect(loadFilter()).toEqual(DEFAULT_FILTER);
});
