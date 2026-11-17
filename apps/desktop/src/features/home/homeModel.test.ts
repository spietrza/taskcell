import { describe, expect, test } from 'vitest';
import type { ActivityEvent, BoardTask, FactoryState, LocalWorkerState, Project } from '../../wire';
import { activityText, cantStart, floorRows, inboxKind, movingRows, stateCounts, thisWeek, type Card, type RunRow, type StampedActive, type StampedNeeds } from './homeModel';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const project = (name: string, extra: Partial<Project> = {}): Project => ({ path: `/r/${name}`, name, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0, ...extra });
const card = (id: string, column: BoardTask['column'], extra: Partial<Card> = {}): Card => ({ id, title: `Card ${id}`, column, state: '', repoPath: '/r/a', repoName: 'a', ...extra });
const run = (taskId: string, ageMs: number, extra: Partial<RunRow> = {}): RunRow => ({ taskId, timestamp: new Date(NOW - ageMs).toISOString(), stages: [], totalCostUsd: 1, anyFailed: false, repoPath: '/r/a', repoName: 'a', ...extra });

describe('stateCounts', () => {
  test('moving is claimed or running; paused counts apart, so a paused card is not also moving', () => {
    const tasks = [card('gh-1', 'claimed'), card('gh-2', 'running'), card('gh-3', 'running', { paused: { reason: 'provider-limit' } }), card('gh-4', 'queued', { paused: { reason: 'provider-limit' } }), card('gh-5', 'review')];
    expect(stateCounts(tasks)).toEqual({ moving: 2, paused: 2 });
  });
});

describe('inboxKind', () => {
  test.each([
    [{ kind: 'pr', reason: 'taskcell:needs-human-review' }, 'PR ready', 'Review', false],
    [{ kind: 'pr', reason: 'vanguard:needs-human-review' }, 'PR ready', 'Review', false],
    [{ kind: 'pr', reason: 'changes requested' }, 'Changes requested', 'Review', false],
    [{ kind: 'pr', reason: 'taskcell:verify-failed' }, 'Verify failed', 'Review', true],
    [{ kind: 'pr', reason: 'vanguard:verify-failed' }, 'Verify failed', 'Review', true],
    [{ kind: 'issue', reason: 'needs info' }, 'Question', 'Answer', false],
    [{ kind: 'issue', reason: 'needs info', ask: 'question' }, 'Question', 'Answer', false],
    [{ kind: 'issue', reason: 'needs info', ask: 'too-vague' }, 'Too vague', 'Answer', false],
    [{ kind: 'card', reason: 'asked', ask: 'question' }, 'Question', 'Answer', false],
  ] as const)('%j', (item, caption, action, broken) => {
    expect(inboxKind(item)).toEqual({ caption, action, broken });
  });
});

describe('movingRows', () => {
  const active = (taskId: string, repoPath = '/r/a'): StampedActive => ({ taskId, sessionFile: '/s', lastActivityMs: NOW, repoPath, repoName: 'a' });

  test('running first, then claimed, then paused; the status line says where the card is', () => {
    const rows = movingRows(
      [card('gh-1', 'claimed'), card('gh-2', 'running', { stage: 'reviewer' }), card('gh-3', 'running', { paused: { reason: 'provider-limit', until: new Date(NOW + 3600 * 1000).toISOString() } }), card('gh-4', 'done')],
      [],
      NOW,
    );
    expect(rows.map((r) => r.title)).toEqual(['Card gh-2', 'Card gh-1', 'Card gh-3']);
    expect(rows.map((r) => r.status)).toEqual(['Review: Review', 'Writing the spec.', 'Paused by a provider limit.']);
    expect(rows[2]).toMatchObject({ paused: true, retry: expect.stringMatching(/^after /) });
  });

  test('a live run joins its card by the folded task id; one with no card is its own row', () => {
    const rows = movingRows([card('gh-12', 'running')], [active('gh-owner-repo-12'), active('gh-owner-repo-99')], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.run?.taskId).toBe('gh-owner-repo-12');
    expect(rows[1]).toMatchObject({ title: 'gh-owner-repo-99', run: { taskId: 'gh-owner-repo-99' } });
  });

  test('the same task number in another repository is not the same card', () => {
    const rows = movingRows([card('gh-12', 'running')], [active('gh-12', '/r/other')], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.run).toBeUndefined();
  });

  test('a hub-board card shows its schedule label', () => {
    const rows = movingRows([card('hub-1', 'running', { schedule: { state: 'running', label: 'running now' } })], [], NOW);
    expect(rows[0]!.status).toBe('running now');
  });
});

describe('floorRows', () => {
  const a = project('a');

  test('counts open cards per station; done cards are not drawn; a PR run moves Review on to the PR', () => {
    const tasks = [card('gh-1', 'queued'), card('gh-2', 'running'), card('gh-3', 'verify-failed'), card('gh-4', 'review'), card('gh-5', 'review'), card('gh-6', 'done')];
    const { rows } = floorRows([a], tasks, [run('gh-5', DAY, { prUrl: 'https://x/pull/5' })], [], NOW);
    expect(rows[0]!.open).toBe(5);
    expect(rows[0]!.stations.map((s) => s.n)).toEqual([1, 0, 1, 1, 1, 1]);
    expect(rows[0]!.stations[3]!.failed).toBe(1);
  });

  test('a card that is also in the inbox is marked waiting, matched within its own repository', () => {
    const tasks = [card('gh-7', 'review', { source: 'github' }), card('gh-7', 'review', { source: 'github', repoPath: '/r/b', repoName: 'b' })];
    const needs: StampedNeeds[] = [{ id: 'o/a#7', kind: 'issue', number: 7, repoSlug: 'o/a', title: 't', url: '', reason: 'needs info', repoPath: '/r/a', repoName: 'a' }];
    const { rows } = floorRows([a, project('b')], tasks, [], needs, NOW);
    expect(rows.find((r) => r.name === 'a')!.stations[4]!.waiting).toBe(1);
    expect(rows.find((r) => r.name === 'b')!.stations[4]!.waiting).toBe(0);
  });

  test('projects with no open card and no run this week fold into the idle count; busiest first', () => {
    const { rows, idle } = floorRows([project('idle'), a, project('b')], [card('gh-1', 'queued'), card('gh-2', 'queued'), card('gh-3', 'queued', { repoPath: '/r/b', repoName: 'b' })], [], [], NOW);
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(idle).toBe(1);
  });

  test('spend is this week only', () => {
    const { rows } = floorRows([a], [], [run('gh-1', DAY, { totalCostUsd: 2 }), run('gh-2', 8 * DAY, { totalCostUsd: 5 })], [], NOW);
    expect(rows[0]!.spendWeek).toBe(2);
  });
});

describe('thisWeek', () => {
  test('exactly seven days old is in, older is out', () => {
    expect(thisWeek([run('gh-1', 7 * DAY), run('gh-2', 7 * DAY + 1)], NOW).runs).toBe(1);
  });

  test('one card merged across several runs counts once; the same number in another repository counts again', () => {
    const merged = { prState: 'merged' } as const;
    const w = thisWeek([run('gh-1', DAY, merged), run('gh-owner-a-1', 2 * DAY, merged), run('gh-1', DAY, { ...merged, repoPath: '/r/b' }), run('gh-2', DAY)], NOW);
    expect(w.merged).toBe(2);
  });

  test('failed leaves out a provider-limit stop; retried is a passed run with extra attempts (repair or resume alike)', () => {
    const w = thisWeek([run('gh-1', DAY, { anyFailed: true }), run('gh-2', DAY, { anyFailed: true, stoppedBy: 'provider-limit' }), run('gh-3', DAY, { extraAttempts: 1 }), run('gh-4', DAY, { anyFailed: true, extraAttempts: 3 }), run('gh-5', 8 * DAY, { extraAttempts: 1 })], NOW);
    expect(w).toMatchObject({ runs: 4, failed: 2, retried: 1 });
    expect(w).not.toHaveProperty('fixed'); // no figure may claim self-repairs: the records cannot separate them from resumes
  });

  test('spend leaves out runs with no cost data', () => {
    expect(thisWeek([run('gh-1', DAY, { totalCostUsd: 3 }), run('gh-2', DAY, { totalCostUsd: 0, costUnknown: true })], NOW).spend).toBe(3);
  });
});

describe('activityText', () => {
  const ev = { time: '', repoPath: '/r/a', repoName: 'a' };
  test.each<[Omit<ActivityEvent, 'time' | 'repoPath' | 'repoName'>, string]>([
    [{ kind: 'run-started', login: 'token' }, 'You started a run'],
    [{ kind: 'run-finished', subject: 'gh-1' }, 'Run gh-1 finished'],
    [{ kind: 'run-failed', subject: 'gh-2' }, 'Run gh-2 failed'],
    [{ kind: 'run-asked', subject: 'hub-4' }, 'Run hub-4 stopped to ask'],
    [{ kind: 'card-created', login: 'ann' }, 'ann created a card'],
    [{ kind: 'pr-merged', login: 'ann', subject: '#12' }, 'ann merged PR #12'],
    [{ kind: 'settings-changed', login: 'bob', keys: ['budgetUsd', 'label'] }, 'bob changed settings: budgetUsd, label'],
  ])('%j', (e, text) => {
    expect(activityText({ ...ev, ...e })).toBe(text);
  });
});

describe('cantStart', () => {
  const waiting = (n = 1): Card[] => Array.from({ length: n }, (_, i) => card(`gh-${i}`, 'queued', { waiting: true }));
  const worker = (extra: Partial<LocalWorkerState> = {}): LocalWorkerState => ({ enabled: true, credentials: { names: ['X'], present: true }, ...extra });
  const local = project('a', { taskSource: 'github', runLocation: 'local' });
  const one = (w: LocalWorkerState, tasks = waiting()): ReturnType<typeof cantStart> => cantStart([local], tasks, {}, { '/r/a': w });

  test.each([
    ['off', worker({ enabled: false }), /is off/],
    ['blocked', worker({ blocked: 'no task source' }), /blocked: no task source/],
    ['failed', worker({ lastError: 'gh is signed out' }), /failed: gh is signed out/],
    ['no credential', worker({ credentials: { names: ['X'], present: false } }), /no model credential/],
  ])('the Local hub worker %s', (_, w, reason) => {
    const [s] = one(w, waiting(2));
    expect(s).toMatchObject({ name: 'a', count: 2, fix: 'worker' });
    expect(s!.reason).toMatch(reason);
  });

  test('a healthy worker, or no waiting card, says nothing; an old error of a worker that is off is just "off"', () => {
    expect(one(worker())).toEqual([]);
    expect(one(worker({ enabled: false }), [])).toEqual([]);
    expect(one(worker({ enabled: false, lastError: 'old' }))[0]!.reason).toMatch(/is off/);
  });

  test('a broken factory on GitHub Actions; ready or none says nothing; watch and hub-board give no signal', () => {
    const actions = project('a', { taskSource: 'github', runLocation: 'github-actions' });
    const state = (s: FactoryState['state'], reason?: string): Record<string, FactoryState> => ({ '/r/a': { state: s, steps: [], ...(reason ? { reason } : {}) } });
    expect(cantStart([actions], waiting(), state('broken', 'doctor failed'), {})[0]).toMatchObject({ fix: 'factory', reason: expect.stringContaining('doctor failed') });
    expect(cantStart([actions], waiting(), state('ready'), {})).toEqual([]);
    expect(cantStart([project('a', { taskSource: 'github', runLocation: 'watch' })], waiting(), state('broken', 'x'), {})).toEqual([]);
    expect(cantStart([project('a', { taskSource: 'hub', runLocation: 'local' })], waiting(), {}, { '/r/a': worker({ enabled: false }) })).toEqual([]);
  });
});
