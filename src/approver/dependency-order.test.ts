import { describe, it, expect } from 'vitest';
import { dependencyHolds, rebaseDependents } from './dependency-order.js';
import { assertActSafeGhArgs } from './act.js';
import type { GhRunner } from '../tasks/github.js';

const R = 'o/r';
const issue = (body: string, state = 'open', extra: object = {}): string => JSON.stringify({ title: 't', body, state, ...extra });

/** A gh double: api reads of issues by number, empty blocked-by lists, optional open PR list. */
const fakeGh = (issues: Record<number, string>, prs: object[] = []): GhRunner => async (args) => {
  if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
  const m = /issues\/(\d+)(\/dependencies\/blocked_by)?$/.exec(args[1] ?? '');
  if (args[0] === 'api' && m !== null) return m[2] !== undefined ? '[]' : (issues[Number(m[1])] ?? issue(''));
  throw new Error(`unexpected gh ${args.join(' ')}`);
};

describe('dependencyHolds', () => {
  it('holds a PR whose task depends on an open issue, naming it', async () => {
    const gh = fakeGh({ 7: issue('Depends on #3'), 3: issue('') });
    const reasons = await dependencyHolds(R, { headRefName: 'chore/taskcell-gh-o-r-7-thing' }, gh);
    expect(reasons.join()).toMatch(/depends on o\/r#3/);
  });

  it('does not hold when the dependency is closed as completed', async () => {
    const gh = fakeGh({ 7: issue('Depends on #3'), 3: issue('', 'closed', { state_reason: 'completed' }) });
    expect(await dependencyHolds(R, { headRefName: 'chore/taskcell-gh-o-r-7-thing' }, gh)).toEqual([]);
  });

  it('leaves a task without dependencies, and a non-factory branch, alone', async () => {
    expect(await dependencyHolds(R, { headRefName: 'chore/taskcell-gh-o-r-7-thing' }, fakeGh({ 7: issue('plain') }))).toEqual([]);
    expect(await dependencyHolds(R, { headRefName: 'feature/x' }, fakeGh({}))).toEqual([]);
  });
});

describe('rebaseDependents', () => {
  const prs = [
    { number: 20, headRefName: 'chore/taskcell-gh-o-r-8-a', mergeStateStatus: 'BEHIND', labels: [] },
    { number: 21, headRefName: 'chore/taskcell-gh-o-r-9-b', mergeStateStatus: 'DIRTY', labels: [] },
    { number: 22, headRefName: 'chore/taskcell-gh-o-r-10-c', mergeStateStatus: 'BEHIND', labels: [] },
  ];
  const issues = { 8: issue('Depends on #3'), 9: issue('Depends on o/r#3'), 10: issue('unrelated') };

  it('updates a behind dependent, revises a conflicting one, skips unrelated PRs', async () => {
    const updated: number[] = [];
    const revised: number[] = [];
    const out = await rebaseDependents(R, { headRefName: 'chore/taskcell-gh-o-r-3-dep' }, fakeGh(issues, prs), {
      update: async (n) => void updated.push(n),
      reviseOne: async (n) => void revised.push(n),
    });
    expect(updated).toEqual([20]);
    expect(revised).toEqual([21]);
    expect(out).toEqual([{ pr: 20, action: 'updated' }, { pr: 21, action: 'revise' }]);
  });

  it('reports a failed update and carries on', async () => {
    const out = await rebaseDependents(R, { headRefName: 'chore/taskcell-gh-o-r-3-dep' }, fakeGh(issues, prs), {
      update: async () => { throw new Error('boom'); },
      reviseOne: async () => undefined,
    });
    expect(out).toEqual([{ pr: 20, action: 'failed' }, { pr: 21, action: 'revise' }]);
  });
});

describe('act allow-list', () => {
  it('allows only the revise label edit', () => {
    expect(() => assertActSafeGhArgs(['pr', 'edit', '5', '--repo', R, '--add-label', 'needs revision'])).not.toThrow();
    expect(() => assertActSafeGhArgs(['pr', 'edit', '5', '--repo', R, '--add-label', 'other'])).toThrow();
  });
});
