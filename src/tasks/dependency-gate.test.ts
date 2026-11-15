import { describe, expect, it, vi } from 'vitest';
import { escalatesToNeedsInfo, evaluateDependencies, invalidStart, MAX_NODES, parseStartDate, postUnlessRepeated, readWithRetry, runDependencyGate } from './dependency-gate.js';
import type { DependencyVerdict, WalkAdapter } from './dependency-gate.js';
import type { Task, TaskRef } from './fetcher.js';

interface Fake {
  open?: boolean;
  never?: boolean;
  blockers?: number[];
  unreadable?: boolean;
}

const ref = (number: number): TaskRef => ({ repo: 'r', number });
const now = new Date('2030-01-01T00:00:00Z');

/** A fake source: issues by number; a number absent from `issues` is missing, `throws` fails the read. */
function fake(issues: Record<number, Fake>, throws: number[] = []): WalkAdapter<Fake> & { fetched: number[] } {
  const fetched: number[] = [];
  return {
    fetched,
    text: (r) => `R-${r.number}`,
    async fetch(dep, by) {
      fetched.push(dep.number);
      if (throws.includes(dep.number)) throw new Error('boom');
      const issue = issues[dep.number];
      return issue === undefined ? { problem: `${dep.number} does not exist (referenced by ${by.number})` } : { issue };
    },
    finished: (issue) => issue.open !== true,
    async blockers(_ref, issue) {
      return issue.unreadable === true ? { waiting: 'blockers unreadable' } : (issue.blockers ?? []).map(ref);
    },
    judge: (issue, r) => (issue.never === true ? { invalid: `${r.number} can never complete` } : issue.open === true ? 'open' : 'met'),
  };
}

const run = (adapter: WalkAdapter<Fake>, direct: number[], start?: string) =>
  evaluateDependencies(adapter, { self: ref(1), direct: direct.map(ref), start: start === undefined ? undefined : parseStartDate(`Start: ${start}`), now });

describe('evaluateDependencies', () => {
  it('is ready when every dependency is met, and with none', async () => {
    expect(await run(fake({ 2: {} }), [2])).toEqual({ status: 'ready', dependsOn: [ref(2)] });
    expect(await run(fake({}), [])).toEqual({ status: 'ready', dependsOn: [] });
  });
  it('waits for open blockers and a future start date, in one reason', async () => {
    expect(await run(fake({ 2: { open: true } }), [2], '2031-02-03')).toMatchObject({ status: 'waiting', blockers: [ref(2)], reason: 'waiting for R-2; start date 2031-02-03' });
    expect(await run(fake({}), [], '2020-01-01')).toMatchObject({ status: 'ready' });
  });
  it('is invalid for a bad start date, a missing reference, a never-met dependency and a cycle', async () => {
    expect(await run(fake({}), [], '2030-02-31')).toMatchObject({ status: 'invalid', reason: expect.stringContaining('not a valid') });
    expect(await run(fake({}), [9])).toMatchObject({ status: 'invalid', reason: '9 does not exist (referenced by 1)' });
    expect(await run(fake({ 2: { never: true } }), [2])).toMatchObject({ status: 'invalid', reason: '2 can never complete' });
    expect(await run(fake({ 2: { open: true, blockers: [3] }, 3: { open: true, blockers: [2] } }), [2])).toMatchObject({ status: 'invalid', reason: 'dependency cycle: R-1 → R-2 → R-3 → R-2' });
  });
  it('follows blockers of open dependencies only, and reads each issue once', async () => {
    const adapter = fake({ 2: { open: true, blockers: [3, 4] }, 3: { open: true, blockers: [4] }, 4: {}, 5: { blockers: [99] } });
    expect(await run(adapter, [2, 5])).toMatchObject({ status: 'waiting' });
    expect(adapter.fetched).toEqual([2, 3, 4, 5]);
  });
  it('holds, never invalidates, when a dependency\'s blockers cannot be read', async () => {
    expect(await run(fake({ 2: { open: true, unreadable: true } }), [2])).toEqual({ status: 'waiting', blockers: [], reason: 'blockers unreadable' });
  });
  it('is invalid beyond the node limit', async () => {
    const chain: Record<number, Fake> = {};
    for (let n = 2; n <= MAX_NODES + 3; n++) chain[n] = { open: true, blockers: [n + 1] };
    expect(await run(fake(chain), [2])).toMatchObject({ status: 'invalid', reason: expect.stringContaining('too large') });
  });
  it('lets a failed read throw (callers turn it into an error verdict)', async () => {
    await expect(run(fake({ 2: {} }, [2]), [2])).rejects.toThrow('boom');
  });
});

describe('escalation and helpers', () => {
  it('only an invalid verdict goes to needs-info', () => {
    const verdicts: DependencyVerdict[] = [{ status: 'ready', dependsOn: [] }, { status: 'waiting', blockers: [], reason: 'x' }, { status: 'error', reason: 'x' }, { status: 'invalid', reason: 'x' }];
    expect(verdicts.map(escalatesToNeedsInfo)).toEqual([false, false, false, true]);
  });
  it('invalidStart', () => {
    expect(invalidStart(parseStartDate('Start: 2030-13-01'))?.status).toBe('invalid');
    expect(invalidStart(parseStartDate('Start: 2030-01-01'))).toBeUndefined();
  });
  it('retries a read except for a final error', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const flaky = readWithRetry(async () => (++calls < 3 ? Promise.reject(new Error('5xx')) : 'ok'), () => false);
    await vi.runAllTimersAsync();
    expect(await flaky).toBe('ok');
    const final = vi.fn(async () => Promise.reject(new Error('404')));
    await expect(readWithRetry(final, () => true)).rejects.toThrow('404');
    expect(final).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('posts a hold comment once', async () => {
    const post = vi.fn(async () => undefined);
    expect(await postUnlessRepeated('held', 'held', (s) => s, post)).toBe(false);
    expect(await postUnlessRepeated('held', 'other', (s) => s, post)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('runDependencyGate', () => {
  const task = (id: string): Task => ({ id, title: id, description: '', labels: [], children: [], comments: [] });
  it('starts ready tasks, holds the rest and turns a throwing check into an error verdict', async () => {
    const hold = vi.fn(async (_t: Task, _v: DependencyVerdict, _all: DependencyVerdict[]) => undefined);
    const out = await runDependencyGate([task('a'), task('b'), task('c')], {
      check: async (t) => {
        if (t.id === 'c') throw new Error('down');
        return t.id === 'a' ? { status: 'ready', dependsOn: [] } : { status: 'waiting', blockers: [], reason: 'w' };
      },
      release: async (t) => t,
      hold,
    });
    expect(out.map((t) => t.id)).toEqual(['a']);
    expect(hold.mock.calls.map((c) => [c[0].id, c[1].status])).toEqual([['b', 'waiting'], ['c', 'error']]);
  });
});
