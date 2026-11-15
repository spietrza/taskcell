import { expect, test } from 'vitest';
import { markerReadBudget, pausedPullRequests, retryPausedTask, withPausedTasks, withPausedTimes } from './paused.js';
import { triggerLabelsFor } from './start-task.js';
import { rateLimitedMarker } from '../core/rate-limit-marker.js';
import type { GhRunner } from '../tasks/github.js';
import type { BoardTask } from '../wire.js';

const UNTIL = new Date('2026-11-14T18:30:00.000Z');
const triggers = triggerLabelsFor(undefined);

interface Fake {
  state?: string;
  labels?: string[];
  /** What the second read of the issue (just before the writes) returns; default: `labels`. */
  labelsOnReread?: string[];
  pull_request?: unknown;
  comments?: { author: string; body: string; at?: string }[];
  reviews?: { author: string; body: string; at?: string }[];
  prs?: Array<{ number: number; title: string; labels: string[]; url?: string }>;
  repoLabels?: string[];
  fail?: (args: string[]) => string | undefined;
}

// `factory-bot` is the hub's own gh user (a collaborator); everyone else is an outside commenter.
// The Actions bot is `github-actions` with association CONTRIBUTOR, as `gh … --json comments` reports it.
const assoc = (login: string): string => (login === 'factory-bot' || login === 'maintainer' ? 'COLLABORATOR' : login === 'github-actions' ? 'CONTRIBUTOR' : 'NONE');

function fakeGh(issue: Fake): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const failure = issue.fail?.(args);
    if (failure !== undefined) throw new Error(failure);
    if (args[0] === 'api') return JSON.stringify({ state: issue.state ?? 'open', labels: ((calls.filter((c) => c[0] === 'api').length > 1 ? issue.labelsOnReread : undefined) ?? issue.labels ?? []).map((name) => ({ name })), pull_request: issue.pull_request });
    if (args[0] === 'label' && args[1] === 'list') return JSON.stringify((issue.repoLabels ?? triggers).map((name) => ({ name })));
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify((issue.prs ?? []).filter((pr) => pr.labels.includes(args[args.indexOf('--label') + 1]!)).map((pr) => ({ ...pr, labels: pr.labels.map((name) => ({ name })) })));
    const comments = (issue.comments ?? []).map((c, i) => ({ author: { login: c.author }, authorAssociation: assoc(c.author), body: c.body, createdAt: c.at ?? `2026-11-14T0${i}:00:00.000Z` }));
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'pr' && args[1] === 'view') {
      const reviews = (issue.reviews ?? []).map((review, i) => ({ author: { login: review.author }, authorAssociation: assoc(review.author), body: review.body, submittedAt: review.at ?? `2026-11-14T1${i}:00:00.000Z` }));
      return JSON.stringify({ comments, reviews });
    }
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

test('the newest trusted entry wins, including a review marker posted by the Actions identity', async () => {
  const newer = new Date('2026-11-15T09:00:00.000Z');
  const { gh } = fakeGh({
    comments: [{ author: 'factory-bot', body: marker(), at: '2026-11-14T08:00:00.000Z' }],
    reviews: [{ author: 'github-actions', body: marker('ready for spec', newer), at: '2026-11-14T09:00:00.000Z' }],
  });
  const [task] = await withPausedTimes('o/r', [paused('gh-pr-9')], gh);
  expect(task?.paused).toEqual({ reason: 'provider-limit', until: newer.toISOString(), trigger: 'ready for spec' });
});

test('the legacy vanguard marker is read; cards that are not paused cost no read', async () => {
  const { gh, calls } = fakeGh({ comments: [{ author: 'github-actions', body: marker().replace('taskcell-', 'vanguard-') }] });
  const plain: BoardTask = { id: 'gh-1', title: 't', column: 'queued', state: '' };
  const out = await withPausedTimes('o/r', [plain, paused('gh-7')], gh);
  expect(out[0]).toBe(plain);
  expect(out[1]!.paused?.until).toBe(UNTIL.toISOString());
  expect(calls.filter((c) => c[1] === 'view')).toHaveLength(1);
});

test('one marker-read budget is shared across repositories', async () => {
  const first = fakeGh({ comments: [{ author: 'factory-bot', body: marker() }] });
  const second = fakeGh({ comments: [{ author: 'factory-bot', body: marker() }] });
  const budget = markerReadBudget();
  await withPausedTimes('o/a', Array.from({ length: 20 }, (_, i) => paused(`gh-${i + 1}`)), first.gh, budget);
  await withPausedTimes('o/b', Array.from({ length: 20 }, (_, i) => paused(`gh-${i + 21}`)), second.gh, budget);
  expect(first.calls.filter((call) => call[1] === 'view')).toHaveLength(20);
  expect(second.calls.filter((call) => call[1] === 'view')).toHaveLength(10);
  expect(budget.remaining).toBe(0);
});

test('paused pull requests are added to the board and read review markers', async () => {
  const { gh } = fakeGh({
    prs: [{ number: 12, title: 'Revise the change', labels: ['taskcell:rate-limited'], url: 'https://github.com/o/r/pull/12' }],
    reviews: [{ author: 'github-actions', body: marker('needs revision') }],
  });
  expect(await pausedPullRequests('o/r', gh)).toEqual([
    expect.objectContaining({ id: 'gh-pr-12', title: 'Revise the change', source: 'github', paused: { reason: 'provider-limit' } }),
  ]);
  const tasks = await withPausedTasks('o/r', [], gh);
  expect(tasks[0]).toMatchObject({ id: 'gh-pr-12', paused: { reason: 'provider-limit', trigger: 'needs revision', until: UNTIL.toISOString() } });
});

test('Retry now creates the trigger when needed, adds it, then removes the hold', async () => {
  const { gh, calls } = fakeGh({ labels: ['vanguard:rate-limited', 'ready for agent'], comments: [{ author: 'factory-bot', body: marker() }] });
  expect(await retryPausedTask('o/r', 7, triggers, gh)).toEqual({ label: 'ready for agent' });
  expect(edits(calls)).toEqual([['--remove-label', 'ready for agent'], ['--add-label', 'ready for agent'], ['--remove-label', 'vanguard:rate-limited']]);

  const missing = fakeGh({ labels: ['taskcell:rate-limited'], repoLabels: [], comments: [{ author: 'factory-bot', body: marker() }] });
  await retryPausedTask('o/r', 7, triggers, missing.gh);
  const create = missing.calls.findIndex((call) => call[0] === 'label' && call[1] === 'create');
  const add = missing.calls.findIndex((call) => call[1] === 'edit' && call[5] === '--add-label');
  const release = missing.calls.findIndex((call) => call[1] === 'edit' && call[5] === '--remove-label');
  expect(create).toBeGreaterThan(-1);
  expect(create).toBeLessThan(add);
  expect(add).toBeLessThan(release);
});

test.each([
  ['creating the trigger', (args: string[]) => args[0] === 'label' && args[1] === 'create' ? 'cannot create label' : undefined, []],
  ['adding the trigger', (args: string[]) => args[1] === 'edit' && args[5] === '--add-label' ? 'cannot add label' : undefined, [['--add-label', 'ready for agent']]],
])('Retry now reports why %s failed while the issue remains paused', async (_name, fail, expectedEdits) => {
  const { gh, calls } = fakeGh({ labels: ['taskcell:rate-limited'], repoLabels: [], comments: [{ author: 'factory-bot', body: marker() }], fail });
  await expect(retryPausedTask('o/r', 7, triggers, gh)).rejects.toThrow(/#7 stays paused: cannot/);
  expect(edits(calls)).toEqual(expectedEdits);
});

test('Retry now says the issue was re-triggered when only the hold could not be removed', async () => {
  const fail = (args: string[]): string | undefined => (args[1] === 'edit' && args[5] === '--remove-label' && args[6] === 'taskcell:rate-limited' ? 'cannot remove hold' : undefined);
  const { gh, calls } = fakeGh({ labels: ['taskcell:rate-limited'], comments: [{ author: 'factory-bot', body: marker() }], fail });
  const error = await retryPausedTask('o/r', 7, triggers, gh).catch((e: unknown) => e as Error);
  expect((error as Error).message).toMatch(/#7 was re-triggered \("ready for agent" added\), but the rate-limited label could not be removed: cannot remove hold/);
  expect((error as Error).message).not.toMatch(/stays paused/);
  expect(edits(calls)).toEqual([['--add-label', 'ready for agent'], ['--remove-label', 'taskcell:rate-limited']]);
});

test('paused pull requests are listed with --label once per spelling, and nothing else', async () => {
  const { gh, calls } = fakeGh({ prs: [{ number: 3, title: 'Old spelling', labels: ['vanguard:rate-limited'] }, { number: 4, title: 'Not paused', labels: ['bug'] }] });
  expect((await pausedPullRequests('o/r', gh)).map((t) => t.id)).toEqual(['gh-pr-3']);
  expect(calls.map((c) => [c[0], c[1], c[c.indexOf('--label') + 1]])).toEqual([['pr', 'list', 'taskcell:rate-limited'], ['pr', 'list', 'vanguard:rate-limited']]);
});

test('a marker pasted by a repository collaborator is honoured, as the scheduled resume does', async () => {
  const { gh } = fakeGh({ comments: [{ author: 'maintainer', body: marker('ready for spec') }] });
  expect((await withPausedTimes('o/r', [paused('gh-7')], gh))[0]!.paused).toEqual({ reason: 'provider-limit', until: UNTIL.toISOString(), trigger: 'ready for spec' });
});

test('Retry now writes nothing when the scheduled resume released the hold meanwhile', async () => {
  const { gh, calls } = fakeGh({ labels: ['taskcell:rate-limited'], labelsOnReread: ['ready for agent'], comments: [{ author: 'factory-bot', body: marker() }] });
  expect(await retryPausedTask('o/r', 7, triggers, gh)).toEqual({ label: 'ready for agent' });
  expect(edits(calls)).toEqual([]);
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
