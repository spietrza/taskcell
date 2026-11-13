import { expect, test } from 'vitest';
import { startGithubTask, triggerLabelsFor } from './start-task.js';
import type { GhRunner } from '../tasks/github.js';

interface FakeIssue {
  state?: string;
  labels?: string[];
  body?: string;
  pull_request?: unknown;
}

function fakeGh(issue: FakeIssue, extra: (args: string[]) => string | undefined = () => undefined): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const custom = extra(args);
    if (custom !== undefined) return custom;
    if (args[0] === 'api' && /^repos\/o\/r\/issues\/\d+$/.test(args[1]!)) {
      return JSON.stringify({ state: issue.state ?? 'open', labels: (issue.labels ?? []).map((name) => ({ name })), body: issue.body ?? '', pull_request: issue.pull_request });
    }
    return '';
  };
  return { gh, calls };
}
const writes = (calls: string[][]): string[][] => calls.filter((c) => c[0] === 'label' || c[1] === 'edit');
const triggers = triggerLabelsFor(undefined);

test('labels an open issue with no status label with exactly the trigger label', async () => {
  const { gh, calls } = fakeGh({ labels: ['bug'] });
  const res = await startGithubTask('o/r', 7, 'ready for agent', triggers, gh);
  expect(res).toEqual({ status: 'labelled', label: 'ready for agent', waitingOn: [] });
  expect(writes(calls).filter((c) => c[1] === 'edit')).toEqual([['issue', 'edit', '7', '--repo', 'o/r', '--add-label', 'ready for agent']]);
});

test('a model pin or a secret-blocked hold does not block a start', async () => {
  for (const labels of [['taskcell:model=opus'], ['taskcell:secret-blocked']]) {
    const { gh } = fakeGh({ labels });
    expect((await startGithubTask('o/r', 7, 'ready for agent', triggers, gh)).status).toBe('labelled');
  }
});

test.each([
  ['a non-trigger label', {}, 'bug', /"bug" is not a trigger label/],
  ['a closed issue', { state: 'closed' }, 'ready for agent', /#7 is closed/],
  ['a pull request', { pull_request: {} }, 'ready for agent', /pull request/],
  ['an issue already running', { labels: ['taskcell:running'] }, 'ready for agent', /already running or queued \(taskcell:running\)/],
  ['an issue already labelled', { labels: ['ready for spec'] }, 'ready for agent', /already running or queued \(ready for spec\)/],
])('refuses %s without a write', async (_n, issue, label, message) => {
  const { gh, calls } = fakeGh(issue);
  await expect(startGithubTask('o/r', 7, label, triggers, gh)).rejects.toThrow(message);
  expect(writes(calls)).toEqual([]);
});

test('matches the configured trigger label case-insensitively', async () => {
  const { gh, calls } = fakeGh({ labels: ['Go'] });
  await expect(startGithubTask('o/r', 7, 'go', triggerLabelsFor('go'), gh)).rejects.toThrow(/already running or queued \(Go\)/);
  expect(writes(calls)).toEqual([]);
});

test('rejects a bad number or slug before any call', async () => {
  const { gh, calls } = fakeGh({});
  await expect(startGithubTask('o/r', 0, 'ready for agent', triggers, gh)).rejects.toThrow(/positive integer/);
  await expect(startGithubTask('--bad', 1, 'ready for agent', triggers, gh)).rejects.toThrow(/Invalid repo slug/);
  expect(calls).toEqual([]);
});

test('a parked rate-limited issue still carrying the trigger is re-triggered, other triggers dropped', async () => {
  const { gh, calls } = fakeGh({ labels: ['taskcell:rate-limited', 'ready for agent', 'ready for spec'] });
  const res = await startGithubTask('o/r', 7, 'ready for agent', triggers, gh);
  expect(res).toMatchObject({ status: 'retried', waitingOn: [] });
  expect(writes(calls).filter((c) => c[1] === 'edit').map((c) => c.slice(5))).toEqual([
    ['--remove-label', 'ready for agent'],
    ['--remove-label', 'ready for spec'],
    ['--add-label', 'ready for agent'],
  ]);
});

test('a parked waiting issue reports only its unmet dependencies', async () => {
  const dep = (state: string): string => JSON.stringify({ state, state_reason: 'completed', labels: [] });
  const { gh, calls } = fakeGh({ labels: ['taskcell:waiting'], body: 'Depends on #3, #4' }, (args) => {
    if (args[0] !== 'api') return undefined;
    if (args[1] === 'repos/o/r/issues/3') return dep('open');
    if (args[1] === 'repos/o/r/issues/4') return dep('closed');
    if (args[1]!.includes('/issues/7/dependencies')) return '[]';
    return undefined;
  });
  const res = await startGithubTask('o/r', 7, 'ready for agent', triggers, gh);
  expect(res).toEqual({ status: 'labelled', label: 'ready for agent', waitingOn: ['o/r#3'] });
  expect(calls.some((c) => c[1] === 'edit')).toBe(true);
});
