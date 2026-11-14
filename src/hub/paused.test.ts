import { expect, test } from 'vitest';
import { retryPausedTask, withPausedTimes } from './paused.js';
import { triggerLabelsFor } from './start-task.js';
import { rateLimitedMarker } from '../core/rate-limit-marker.js';
import type { GhRunner } from '../tasks/github.js';
import type { BoardTask } from '../wire.js';

const UNTIL = new Date('2026-11-14T18:30:00.000Z');
const triggers = triggerLabelsFor(undefined);

interface Fake {
  state?: string;
  labels?: string[];
  pull_request?: unknown;
  comments?: { author: string; body: string }[];
}

function fakeGh(issue: Fake): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return 'factory-bot\n';
    if (args[0] === 'api') return JSON.stringify({ state: issue.state ?? 'open', labels: (issue.labels ?? []).map((name) => ({ name })), pull_request: issue.pull_request });
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: (issue.comments ?? []).map((c) => ({ author: { login: c.author }, body: c.body })) });
    return '';
  };
  return { gh, calls };
}
const edits = (calls: string[][]): string[][] => calls.filter((c) => c[1] === 'edit').map((c) => c.slice(5));
const paused = (id: string): BoardTask => ({ id, title: 't', column: 'queued', state: 'taskcell:rate-limited', paused: { reason: 'provider-limit' } });
const marker = (trigger = 'ready for agent', until = UNTIL): string => `limit\n\n${rateLimitedMarker(until, trigger)}`;

test('a paused card gets the until time and trigger from the factory marker', async () => {
  const { gh } = fakeGh({ comments: [{ author: 'factory-bot', body: marker() }] });
  const [t] = await withPausedTimes('o/r', [paused('gh-7')], gh);
  expect(t!.paused).toEqual({ reason: 'provider-limit', until: UNTIL.toISOString(), trigger: 'ready for agent' });
});

test('a marker written by another login is ignored; the factory marker still wins over it', async () => {
  const later = new Date('2030-01-01T00:00:00.000Z');
  const { gh } = fakeGh({ comments: [{ author: 'factory-bot', body: marker() }, { author: 'mallory', body: marker('ready for spec', later) }] });
  const [t] = await withPausedTimes('o/r', [paused('gh-7')], gh);
  expect(t!.paused).toEqual({ reason: 'provider-limit', until: UNTIL.toISOString(), trigger: 'ready for agent' });
  const only = fakeGh({ comments: [{ author: 'mallory', body: marker() }] });
  expect((await withPausedTimes('o/r', [paused('gh-7')], only.gh))[0]!.paused).toEqual({ reason: 'provider-limit' });
});

test('the legacy vanguard marker is read; cards that are not paused cost no read', async () => {
  const { gh, calls } = fakeGh({ comments: [{ author: 'github-actions', body: marker().replace('taskcell-', 'vanguard-') }] });
  const plain: BoardTask = { id: 'gh-1', title: 't', column: 'queued', state: '' };
  const out = await withPausedTimes('o/r', [plain, paused('gh-7')], gh);
  expect(out[0]).toBe(plain);
  expect(out[1]!.paused?.until).toBe(UNTIL.toISOString());
  expect(calls.filter((c) => c[1] === 'view')).toHaveLength(1);
});

test('Retry now removes the label (either spelling) and re-applies the recorded trigger', async () => {
  const { gh, calls } = fakeGh({ labels: ['vanguard:rate-limited', 'ready for agent'], comments: [{ author: 'factory-bot', body: marker() }] });
  expect(await retryPausedTask('o/r', 7, triggers, gh)).toEqual({ label: 'ready for agent' });
  expect(edits(calls)).toEqual([['--remove-label', 'vanguard:rate-limited'], ['--remove-label', 'ready for agent'], ['--add-label', 'ready for agent']]);
});

test.each([
  ['a pull request', { pull_request: {}, labels: ['taskcell:rate-limited'] }, /pull request/],
  ['a closed issue', { state: 'closed', labels: ['taskcell:rate-limited'] }, /closed/],
  ['an issue that is not paused', { labels: [] }, /not paused/],
  ['an issue already running', { labels: ['taskcell:rate-limited', 'taskcell:running'] }, /already running/],
  ['an issue whose marker is from another login', { labels: ['taskcell:rate-limited'], comments: [{ author: 'mallory', body: marker() }] }, /no rate-limit marker/],
  ['a marker naming a label that is not a trigger', { labels: ['taskcell:rate-limited'], comments: [{ author: 'factory-bot', body: marker('bug') }] }, /not a trigger label/],
])('Retry now refuses %s without a write', async (_n, issue: Fake, message) => {
  const { gh, calls } = fakeGh(issue);
  await expect(retryPausedTask('o/r', 7, triggers, gh)).rejects.toThrow(message);
  expect(edits(calls)).toEqual([]);
});
