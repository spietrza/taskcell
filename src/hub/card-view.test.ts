import { expect, test } from 'vitest';
import { markDone, newestRuns, runOutcome, withCardViews } from './card-view.js';
import type { BoardTask, NeedsYouItem, RunSummary } from '../wire.js';

const run = (taskId: string, timestamp: string, extra: Partial<RunSummary> = {}): RunSummary => ({ taskId, timestamp, stages: [], totalCostUsd: 0, anyFailed: false, ...extra });
const card = (id: string, column: BoardTask['column'], extra: Partial<BoardTask> = {}): BoardTask => ({ id, title: id, column, state: '', ...extra });
const PR = 'https://github.com/o/r/pull/5';
const item = (extra: Partial<NeedsYouItem>): NeedsYouItem => ({ id: 'o/r#5', kind: 'pr', number: 5, repoSlug: 'o/r', title: 't', url: PR, reason: 'x', ...extra });

interface Case {
  name: string;
  tasks: BoardTask[];
  runs?: RunSummary[];
  needs?: NeedsYouItem[];
  /** The expected view of the first card. */
  place: { at: number; failed: boolean; passed?: number[] };
  state?: string;
  prUrl?: string;
  waiting?: boolean;
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const cases: Case[] = [
  { name: 'no run: placed by its column', tasks: [card('gh-1', 'queued')], place: { at: 0, failed: false } },
  { name: 'running, no repairs: in the cell', tasks: [card('gh-1', 'running')], runs: [run('gh-1', T1)], place: { at: 2, failed: false }, state: 'passed' },
  { name: 'running at a gate stage', tasks: [card('gh-1', 'running', { stage: 'conformance' })], place: { at: 3, failed: false } },
  { name: 'review with a PR: on the PR station', tasks: [card('gh-1', 'review')], runs: [run('gh-1', T1, { prUrl: PR })], place: { at: 5, failed: false }, state: 'PR open', prUrl: PR },
  { name: 'review without a PR (no run): at Review', tasks: [card('gh-1', 'review')], place: { at: 4, failed: false } },
  { name: 'review, passed run without a PR', tasks: [card('gh-1', 'review')], runs: [run('gh-1', T1)], place: { at: 5, failed: false }, state: 'passed' },
  { name: 'completed with no changes: asked, waits in the cell', tasks: [card('hub-1', 'verify-failed', { asked: true })], runs: [run('hub-1', T1, { asked: 'Nothing to do?' })], place: { at: 2, failed: false }, state: 'Waiting for your answer' },
  { name: 'asked after green gates: gates shown passed', tasks: [card('hub-1', 'verify-failed', { asked: true })], runs: [run('hub-1', T1, { anyFailed: true, asked: 'Which?', verifyPassed: true })], place: { at: 2, failed: false, passed: [3] }, state: 'Waiting for your answer' },
  { name: 'failed stage marks its station', tasks: [card('gh-1', 'verify-failed')], runs: [run('gh-1', T1, { anyFailed: true, failedStage: 'reviewer' })], place: { at: 4, failed: true }, state: 'failed' },
  { name: 'failed verify marks Gates', tasks: [card('gh-1', 'verify-failed')], runs: [run('gh-1', T1, { verifyFailed: true, prUrl: PR })], place: { at: 3, failed: true }, state: 'failed', prUrl: PR },
  { name: 'merged: the card is done, past the line', tasks: [card('gh-1', 'done')], runs: [run('gh-1', T1, { prUrl: PR })], place: { at: 6, failed: false }, state: 'merged', prUrl: PR },
  { name: 'done without a PR (local branch)', tasks: [card('hub-1', 'done')], runs: [run('hub-1', T1)], place: { at: 6, failed: false }, state: 'done, no PR' },
  { name: 'done card whose run asked: history, not waiting', tasks: [card('hub-1', 'done')], runs: [run('hub-1', T1, { anyFailed: true, asked: 'q' })], place: { at: 6, failed: false }, state: 'stopped to ask' },
  { name: 'CI-sourced runs are ignored', tasks: [card('gh-1', 'review')], runs: [run('gh-1', T2, { source: 'ci', prUrl: PR })], place: { at: 4, failed: false } },
  { name: 'newest run by timestamp, whatever the input order', tasks: [card('gh-1', 'review')], runs: [run('gh-1', T1, { anyFailed: true, failedStage: 'implementer' }), run('gh-1', T2, { prUrl: PR }), run('gh-1', '2025-12-01T00:00:00.000Z', { anyFailed: true })], place: { at: 5, failed: false }, state: 'PR open', prUrl: PR },
  { name: 'a runner-minted GitHub task id folds onto the board id', tasks: [card('gh-904', 'review')], runs: [run('gh-owner-repo-904', T1, { prUrl: PR })], place: { at: 5, failed: false }, state: 'PR open', prUrl: PR },
  { name: 'a GitLab task id folds the same way', tasks: [card('gl-12', 'review')], runs: [run('gl-group-proj-12', T1)], place: { at: 5, failed: false }, state: 'passed' },
  { name: 'a Linear id differing only in case', tasks: [card('linear-eng-12', 'review')], runs: [run('LINEAR-ENG-12', T1)], place: { at: 5, failed: false }, state: 'passed' },
  { name: 'a PR item waits on its card by address', tasks: [card('gh-1', 'review')], runs: [run('gh-1', T1, { prUrl: PR })], needs: [item({})], place: { at: 5, failed: false }, state: 'PR open', prUrl: PR, waiting: true },
  { name: 'a PR item of another address is not this card', tasks: [card('gh-1', 'review')], runs: [run('gh-1', T1, { prUrl: PR })], needs: [item({ url: 'https://github.com/o/r/pull/9' })], place: { at: 5, failed: false }, state: 'PR open', prUrl: PR },
  { name: 'an issue item matches a GitHub card by number', tasks: [card('gh-12', 'queued', { source: 'github' })], needs: [item({ kind: 'issue', number: 12, url: '' })], place: { at: 0, failed: false }, waiting: true },
  { name: 'an issue item never matches a Linear card by number', tasks: [card('linear-eng-12', 'queued', { source: 'linear' })], needs: [item({ kind: 'issue', number: 12, url: '' })], place: { at: 0, failed: false } },
  { name: 'a card item matches by board id', tasks: [card('hub-4', 'verify-failed', { asked: true })], runs: [run('hub-4', T1, { asked: 'q' })], needs: [item({ kind: 'card', id: 'hub-4', number: 4 })], place: { at: 2, failed: false }, state: 'Waiting for your answer', waiting: true },
];

test.each(cases)('$name', ({ tasks, runs, needs, place, state, prUrl, waiting }) => {
  const [view] = withCardViews(tasks, runs ?? [], needs ?? []).map((t) => t.view);
  expect(view?.place).toEqual(place);
  expect(view?.run?.state).toBe(state);
  expect(view?.run?.prUrl).toBe(prUrl);
  expect(view?.waiting !== undefined).toBe(waiting === true);
});

test('newestRuns keys by board id, skips CI runs and keeps the newest', () => {
  const m = newestRuns([run('gh-owner-r-1', T1), run('gh-1', T2), run('gh-1', '2030-01-01T00:00:00.000Z', { source: 'ci' })]);
  expect([...m.keys()]).toEqual(['gh-1']);
  expect(m.get('gh-1')?.timestamp).toBe(T2);
});

test('markDone marks a PR run merged, a passed local run cardDone, and leaves failures and other cards alone', () => {
  const out = markDone([run('gh-1', T1, { prUrl: PR }), run('gh-2', T1), run('gh-3', T1, { anyFailed: true }), run('gh-4', T1, { prUrl: PR })], new Set(['gh-1', 'gh-2', 'gh-3']));
  expect(out.map((r) => [r.prState, r.cardDone])).toEqual([['merged', undefined], [undefined, true], [undefined, undefined], [undefined, undefined]]);
});

test('a completed run with no changes reads the same on every surface: one outcome', () => {
  const r = run('hub-1', T1, { asked: 'Nothing needed changing' });
  expect(runOutcome(r)).toEqual({ state: 'Waiting for your answer', place: { at: 2, failed: false } });
});
