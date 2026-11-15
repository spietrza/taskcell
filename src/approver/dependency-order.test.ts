import { describe, it, expect, vi } from 'vitest';
import { NoRetryError } from '../core/errors.js';
import { checkDependencies } from '../tasks/dependencies.js';
import { dependencyHolds, rebaseDependents, scopedGh, MAX_DEPENDENTS } from './dependency-order.js';
import { actSafeGhRunner, assertActSafeGhArgs } from './act.js';
import { assertShadowSafeGhArgs } from './publish.js';
import { emptyDiffFacts } from './diff-facts.js';
import type { GhRunner } from '../tasks/github.js';
import type { ApproverPolicy, DiffFacts, PrFacts } from './types.js';

const diffs = vi.hoisted(() => ({ byPr: new Map<number, object>() }));
vi.mock('./diff-facts.js', async (orig) => {
  const mod = await orig<typeof import('./diff-facts.js')>();
  return { ...mod, collectDiffFacts: async (input: { prNumber: number }) => diffs.byPr.get(input.prNumber) };
});

const R = 'o/r';
const issue = (body: string, state = 'open', extra: object = {}): string => JSON.stringify({ title: 't', body, state, ...extra });
const POLICY = {
  schemaVersion: 1, enabled: true, act: true, factoryAuthors: ['app/taskcell'], factoryBranchPrefix: 'chore/taskcell-',
  requiredChecks: [{ name: 'build', appId: 1 }], reviewAuthors: ['bot'], testGlobs: [], pathRules: {},
  shape: { maxLines: 1, maxFiles: 1 }, ledger: { windowDays: 1, maxLines: 1 }, auditSample: { p: 0 },
} as ApproverPolicy;

interface Fake {
  issues: Record<number, string>;
  prs?: object[];
  /** Trusted comments already on a PR. */
  comments?: Record<number, string[]>;
  fail?: (args: string[]) => boolean;
  /** Who the trusted comments come back from (default: a repo owner). */
  commentAuthor?: { login: string; association: string; viewerDidAuthor?: boolean };
  /** How long ago `needs revision` was last applied to a PR, in ms (default: two hours). */
  labeledAgo?: Record<number, number>;
}

/** A gh double behind act mode's allow-list: issue reads, empty blocked-by lists, the open PR list, comments; every call is recorded. */
const fakeGh = (calls: string[][], f: Fake): GhRunner =>
  actSafeGhRunner(async (args) => {
    calls.push(args);
    if (f.fail?.(args) === true) throw new Error('gh: boom (HTTP 403)');
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(f.prs ?? []);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ comments: (f.comments?.[Number(args[2])] ?? []).map((body) => ({ body, author: { login: f.commentAuthor?.login ?? 'o' }, authorAssociation: f.commentAuthor?.association ?? 'OWNER', viewerDidAuthor: f.commentAuthor?.viewerDidAuthor })) });
    if (args[0] === 'pr') return '';
    const t = /^repos\/o\/r\/issues\/(\d+)\/timeline$/.exec(args[1] ?? '');
    if (args[0] === 'api' && t !== null) {
      const at = new Date(Date.now() - (f.labeledAgo?.[Number(t[1])] ?? 2 * 3600_000)).toISOString();
      return JSON.stringify([[{ event: 'labeled', label: { name: 'needs revision' }, created_at: at }, { event: 'commented', created_at: new Date().toISOString() }]]);
    }
    const m = /^repos\/o\/r\/issues\/(\d+)(\/dependencies\/blocked_by)?$/.exec(args[1] ?? '');
    if (args[0] === 'api' && m !== null) return m[2] !== undefined ? '[]' : (f.issues[Number(m[1])] ?? issue(''));
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });

const HEAD = 'chore/taskcell-gh-o-r-7-thing';

describe('dependencyHolds', () => {
  it('holds a PR whose task depends on an open issue, naming it, under a stable code', async () => {
    const hold = await dependencyHolds(R, { headRefName: HEAD }, fakeGh([], { issues: { 7: issue('Depends on #3'), 3: issue('') } }));
    expect(hold.reasons.join()).toMatch(/depends on o\/r#3/);
    expect(hold.code).toBe('dependency-unmerged');
  });

  it('does not hold when the dependency is closed as completed', async () => {
    const gh = fakeGh([], { issues: { 7: issue('Depends on #3'), 3: issue('', 'closed', { state_reason: 'completed' }) } });
    expect(await dependencyHolds(R, { headRefName: HEAD }, gh)).toEqual({ reasons: [] });
  });

  it('leaves a task without dependencies alone, and reads nothing for a branch with no task', async () => {
    expect(await dependencyHolds(R, { headRefName: HEAD }, fakeGh([], { issues: { 7: issue('plain') } }))).toEqual({ reasons: [] });
    const calls: string[][] = [];
    expect(await dependencyHolds(R, { headRefName: 'feature/x' }, fakeGh(calls, { issues: {} }))).toEqual({ reasons: [] });
    expect(calls).toEqual([]);
  });

  it('fails closed when the relations cannot be read, even with no Depends on line', async () => {
    const hold = await dependencyHolds(R, { headRefName: HEAD }, fakeGh([], { issues: { 7: issue('plain') }, fail: (a) => (a[1] ?? '').endsWith('blocked_by') }));
    expect(hold.code).toBe('dependency-check-failed');
    expect(hold.reasons).toHaveLength(1);
  });

  it('an out-of-scope read is a typed no-retry error with no HTTP status, and is not retried', async () => {
    const hold = await dependencyHolds(R, { headRefName: HEAD }, fakeGh([], { issues: { 7: issue('Depends on evil/other#3') } }));
    expect(hold.reasons.join()).not.toMatch(/HTTP \d{3}/);
    await expect(scopedGh(async () => '', R, {})(['api', 'repos/evil/other/issues/3'])).rejects.toBeInstanceOf(NoRetryError);
    let attempts = 0;
    const gh: GhRunner = async () => {
      attempts += 1;
      throw new NoRetryError('refused');
    };
    await checkDependencies(R, { id: 'o/r#7', title: '', description: 'Depends on #3', labels: [], children: [], comments: [], ref: '7' }, gh);
    expect(attempts).toBe(1);
  });

  it('never reads a repo named in the issue body unless the policy lists it', async () => {
    const calls: string[][] = [];
    const hold = await dependencyHolds(R, { headRefName: HEAD }, fakeGh(calls, { issues: { 7: issue('Depends on evil/other#3') } }));
    expect(hold.code).toBe('dependency-check-failed');
    expect(calls.some((a) => a.join(' ').includes('evil/other'))).toBe(false);
    const allowed: string[][] = [];
    await dependencyHolds(R, { headRefName: HEAD }, async (a) => (allowed.push(a), a[1]?.includes('blocked_by') === true ? '[]' : a[1]?.includes('evil') === true ? issue('', 'closed') : issue('Depends on evil/other#3')), { dependencyRepos: ['evil/other'] });
    expect(allowed.some((a) => a[1] === 'repos/evil/other/issues/3')).toBe(true);
  });
});

describe('rebaseDependents', () => {
  const MERGED = { headRefName: 'chore/taskcell-gh-o-r-3-dep', baseRefName: 'main' };
  const author = { login: 'app/taskcell' };
  const open = (number: number, issueNo: number, over: object = {}): object => ({ number, headRefName: `chore/taskcell-gh-o-r-${issueNo}-x`, isCrossRepository: false, author, ...over });
  const facts = (number: number, issueNo: number, over: Partial<PrFacts> = {}): PrFacts => ({
    number, url: '', state: 'OPEN', isDraft: false, headSha: `head${number}`, headRefName: `chore/taskcell-gh-o-r-${issueNo}-x`, baseRefName: 'main', apiBaseSha: 'b1',
    headRepo: R, title: 'feat: x', mergeStateStatus: 'CLEAN', author: 'app/taskcell', labels: [], reviews: [], ...over,
  });
  const diff = (number: number, over: Partial<DiffFacts> = {}): void => void diffs.byPr.set(number, { ...emptyDiffFacts(`head${number}`, 'b1', 'b1'), gitFactsFailed: false, mergeTreeHeadClean: true, ...over });
  const run = (calls: string[][], f: Fake, prs: Record<number, PrFacts | PrFacts[]>, policy: ApproverPolicy = POLICY): ReturnType<typeof rebaseDependents> => {
    const reads = new Map<number, number>();
    return rebaseDependents({
      repo: R, repoPath: '/nowhere', merged: MERGED, policy, gh: fakeGh(calls, f),
      readPr: async (n) => {
        const seq = [prs[n]!].flat();
        const i = reads.get(n) ?? 0;
        reads.set(n, i + 1);
        return seq[Math.min(i, seq.length - 1)]!;
      },
    });
  };
  const writes = (calls: string[][]): string[] => calls.filter((a) => a[0] === 'pr' && !['list', 'view'].includes(a[1]!)).map((a) => a.slice(1, 3).concat(a.slice(5, 7)).join(' ').replace(/ --body [\s\S]*$/, ' --body'));
  const issues = { 8: issue('Depends on #3'), 9: issue('Depends on o/r#3'), 10: issue('unrelated'), 11: issue('Depends on #3') };

  it('updates a behind dependent, revises a conflicting one once (comment with a marker, then the label), skips unrelated PRs', async () => {
    diff(20);
    diff(21, { mergeTreeHeadClean: false });
    diff(22);
    const calls: string[][] = [];
    const out = await run(calls, { issues, prs: [open(20, 8), open(21, 9), open(22, 10)] }, { 20: facts(20, 8, { mergeStateStatus: 'BEHIND' }), 21: facts(21, 9, { mergeStateStatus: 'DIRTY' }), 22: facts(22, 10) });
    expect(out.map((d) => [d.pr, d.action, d.headSha])).toEqual([[20, 'updated', 'head20'], [21, 'revise', 'head21']]);
    expect(writes(calls)).toEqual(['update-branch 20', 'comment 21 --body', 'edit 21 --add-label needs revision']);
    const body = calls.find((a) => a[1] === 'comment')![6]!;
    expect(body).toContain('<!-- taskcell-approver-act: head21:revise:dependent-conflict -->');
  });

  it('updates a stale dependent that GitHub reports CLEAN (no strict branch protection): the merge-base is not the base tip', async () => {
    diff(20, { mergeBase: 'b0' });
    const calls: string[][] = [];
    expect((await run(calls, { issues, prs: [open(20, 8)] }, { 20: facts(20, 8) })).map((d) => d.action)).toEqual(['updated']);
    expect(writes(calls)).toEqual(['update-branch 20']);
  });

  it('a failed update on a PR that turns out to conflict is sent to revise, any other failure is reported', async () => {
    diff(20, { mergeBase: 'b0' });
    diff(21, { mergeBase: 'b0' });
    const calls: string[][] = [];
    const out = await run(calls, { issues: { ...issues, 9: issue('Depends on #3') }, prs: [open(20, 8), open(21, 9)], fail: (a) => a[1] === 'update-branch' }, {
      20: [facts(20, 8, { mergeStateStatus: 'UNKNOWN' }), facts(20, 8, { mergeStateStatus: 'DIRTY' })],
      21: facts(21, 9, { mergeStateStatus: 'BEHIND' }),
    });
    expect(out.map((d) => [d.pr, d.action])).toEqual([[20, 'revise'], [21, 'failed']]);
    expect(writes(calls)).toEqual(['update-branch 20', 'comment 20 --body', 'edit 20 --add-label needs revision', 'update-branch 21']);
  });

  it('an existing needs revision label does not block a new head, and the same head is not sent twice', async () => {
    diff(21, { mergeTreeHeadClean: false });
    const labelled = facts(21, 9, { labels: ['needs revision'] });
    const fresh: string[][] = [];
    await run(fresh, { issues, prs: [open(21, 9)] }, { 21: labelled });
    expect(writes(fresh)).toEqual(['comment 21 --body', 'edit 21 --remove-label needs revision', 'edit 21 --add-label needs revision']);
    const again: string[][] = [];
    const marker = '<!-- taskcell-approver-act: head21:revise:dependent-conflict -->';
    expect((await run(again, { issues, prs: [open(21, 9)], comments: { 21: [marker] } }, { 21: labelled })).map((d) => d.action)).toEqual(['revise']);
    expect(writes(again)).toEqual([]);
    // comment posted earlier but the label never landed: only the label is added
    const retry: string[][] = [];
    await run(retry, { issues, prs: [open(21, 9)], comments: { 21: [marker] } }, { 21: facts(21, 9) });
    expect(writes(retry)).toEqual(['edit 21 --add-label needs revision']);
  });

  it('writes nothing to a fork PR or one by another author, and does not read their issues', async () => {
    const calls: string[][] = [];
    const out = await run(calls, { issues: { 99: issue('Depends on #3') }, prs: [open(30, 99, { isCrossRepository: true }), open(31, 99, { author: { login: 'outsider' } })] }, {});
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1); // the PR list only
  });

  it.each([
    ['the hold label', { labels: ['taskcell:hold'] }, {}],
    ['a draft', { isDraft: true }, {}],
    ['a revise round in flight', { labels: ['taskcell:revising'] }, {}],
    ['a revise round in flight (legacy label)', { labels: ['vanguard:revising'] }, {}],
    ['a head in another repo', { headRepo: 'fork/r' }, {}],
    ['another base branch', { baseRefName: 'release' }, {}],
    ['a requested change', { reviews: [{ author: 'human', body: '', submittedAt: '1', state: 'CHANGES_REQUESTED' }] }, {}],
    ['CI config in the diff', {}, { paths: ['.github/workflows/x.yml'] }],
    ['an unreadable diff', {}, { gitFactsFailed: true }],
  ] as [string, Partial<PrFacts>, Partial<DiffFacts>][])('skips a dependent with %s without writing to it', async (_name, over, diffOver) => {
    diff(20, { mergeTreeHeadClean: false, ...diffOver });
    const calls: string[][] = [];
    const out = await run(calls, { issues, prs: [open(20, 8)] }, { 20: facts(20, 8, { mergeStateStatus: 'DIRTY', ...over }) });
    expect(out.map((d) => d.action)).toEqual(['skipped']);
    expect(writes(calls)).toEqual([]);
  });

  it('a revising dependent is neither updated nor re-labelled, whichever spelling the fresh read shows', async () => {
    diff(21, { mergeTreeHeadClean: false });
    diff(22, { mergeBase: 'b0' });
    const calls: string[][] = [];
    const out = await run(calls, { issues, prs: [open(21, 9), open(22, 11)] }, {
      21: [facts(21, 9, { mergeStateStatus: 'DIRTY' }), facts(21, 9, { labels: ['vanguard:revising'] })],
      22: [facts(22, 11), facts(22, 11, { labels: ['Taskcell:Revising'] })],
    });
    expect(out.map((d) => [d.pr, d.action])).toEqual([[21, 'skipped'], [22, 'skipped']]);
    expect(writes(calls)).toEqual([]);
  });

  it('needs revision applied 5 min ago is a pending round: no update-branch, no re-label', async () => {
    diff(20, { mergeBase: 'b0' });
    diff(21, { mergeTreeHeadClean: false });
    const calls: string[][] = [];
    const out = await run(calls, { issues, prs: [open(20, 8), open(21, 9)], labeledAgo: { 20: 5 * 60_000, 21: 5 * 60_000 } }, {
      20: [facts(20, 8), facts(20, 8, { labels: ['needs revision'] })],
      21: facts(21, 9, { labels: ['needs revision'] }),
    });
    expect(out.map((d) => [d.pr, d.action])).toEqual([[20, 'skipped'], [21, 'skipped']]);
    expect(writes(calls)).toEqual([]);
  });

  it('needs revision applied 2 h ago is not a pending round: update-branch', async () => {
    diff(20, { mergeBase: 'b0' });
    const calls: string[][] = [];
    const out = await run(calls, { issues, prs: [open(20, 8)], labeledAgo: { 20: 2 * 3600_000 } }, { 20: [facts(20, 8), facts(20, 8, { labels: ['needs revision'] })] });
    expect(out.map((d) => [d.pr, d.action])).toEqual([[20, 'updated']]);
    expect(writes(calls)).toEqual(['update-branch 20']);
  });

  it('a revise marker from a user account named like the App does not dedupe; one the token wrote does', async () => {
    diff(21, { mergeTreeHeadClean: false });
    const marker = '<!-- taskcell-approver-act: head21:revise:dependent-conflict -->';
    const labelled = facts(21, 9, { labels: ['needs revision'] });
    const policy = { ...POLICY, approverLogins: ['my-app[bot]', 'app/my-app'] };
    const user: string[][] = [];
    await run(user, { issues, prs: [open(21, 9)], comments: { 21: [marker] }, commentAuthor: { login: 'my-app', association: 'NONE' } }, { 21: labelled }, policy);
    expect(writes(user)).toEqual(['comment 21 --body', 'edit 21 --remove-label needs revision', 'edit 21 --add-label needs revision']);
    const own: string[][] = [];
    await run(own, { issues, prs: [open(21, 9)], comments: { 21: [marker] }, commentAuthor: { login: 'my-app', association: 'NONE', viewerDidAuthor: true } }, { 21: labelled }, policy);
    expect(writes(own)).toEqual([]);
  });

  it('does nothing when the policy has act off or is disabled', async () => {
    for (const policy of [{ ...POLICY, act: false }, { ...POLICY, enabled: false }]) {
      const calls: string[][] = [];
      expect(await run(calls, { issues, prs: [open(20, 8)] }, { 20: facts(20, 8) }, policy)).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it(`acts on at most ${MAX_DEPENDENTS} dependents and says so`, async () => {
    const many = Array.from({ length: MAX_DEPENDENTS + 2 }, (_, i) => 100 + i);
    for (const n of many) diff(n, { mergeBase: 'b0' });
    const calls: string[][] = [];
    const out = await run(calls, { issues: Object.fromEntries(many.map((n) => [n, issue('Depends on #3')])), prs: many.map((n) => open(n, n)) }, Object.fromEntries(many.map((n) => [n, facts(n, n)])));
    expect(out.filter((d) => d.action === 'updated')).toHaveLength(MAX_DEPENDENTS);
    expect(out.at(-1)).toMatchObject({ pr: 0, action: 'skipped' });
  });
});

describe('gh allow-lists', () => {
  const shapes = [
    ['pr', 'edit', '5', '--repo', R, '--add-label', 'needs revision'],
    ['pr', 'edit', '5', '--repo', R, '--remove-label', 'needs revision'],
    ['pr', 'update-branch', '5', '--repo', R],
    ['pr', 'list', '--repo', R, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,isCrossRepository,author'],
    ['api', 'repos/o/r/issues/7'],
    ['api', 'repos/o/r/issues/7/dependencies/blocked_by', '--paginate'],
    ['api', 'repos/o/r/issues/7/timeline', '--paginate', '--slurp'],
  ];
  it('act mode allows exactly the merge-order shapes', () => {
    for (const args of shapes) expect(() => assertActSafeGhArgs(args)).not.toThrow();
    for (const args of [
      ['pr', 'edit', '5', '--repo', R, '--add-label', 'other'],
      ['pr', 'edit', '5', '--repo', R, '--remove-label', 'taskcell:hold'],
      ['pr', 'list', '--repo', R, '--state', 'open', '--limit', '100', '--json', 'body'],
      ['api', 'repos/o/r/issues/7', '-X', 'PATCH'],
      ['api', 'repos/o/r/issues/7', '-f', 'state=closed'],
      ['api', 'repos/o/r/issues/7/comments'],
      ['api', 'repos/o/../r/issues/7/x'],
      ['api', 'repos/../x/issues/1'],
      ['api', 'repos/o/../issues/1'],
      ['api', 'repos/o/r/issues/7/timeline', '--paginate', '--slurp', '-X', 'POST'],
      ['api', 'repos/o/r/issues/7/timeline', '-X', 'POST'],
      ['api', 'repos/o/../issues/7/timeline', '--paginate', '--slurp'],
    ]) expect(() => assertActSafeGhArgs(args)).toThrow();
  });
  it('shadow mode allows none of them', () => {
    for (const args of shapes) expect(() => assertShadowSafeGhArgs(args)).toThrow();
  });
});
