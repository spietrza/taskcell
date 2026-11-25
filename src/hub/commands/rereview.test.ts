import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import type { GhRunner } from '../../tasks/github.js';
import { AuditLog } from '../audit.js';
import { cleanups, dispatchRpc, makeCtx, tmpGitRepo, tmpRepo } from '../test-kit.js';

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

interface Pr { state?: string; labels?: string[]; headRefName?: string; isCrossRepository?: boolean; repoLabels?: string[] }

function fakeGh(pr: Pr = {}): { gh: GhRunner; edits: string[][] } {
  const edits: string[][] = [];
  const gh: GhRunner = async (args) => {
    if (args[0] === 'label' && args[1] === 'list') return JSON.stringify((pr.repoLabels ?? ['ready for taskcell review']).map((name) => ({ name })));
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ state: pr.state ?? 'OPEN', labels: (pr.labels ?? ['taskcell:reviewed', 'ready for taskcell review']).map((name) => ({ name })), headRefName: pr.headRefName ?? 'chore/taskcell-42-x', isCrossRepository: pr.isCrossRepository ?? false });
    }
    if (args[0] === 'pr' && args[1] === 'edit') edits.push(args);
    return '';
  };
  return { gh, edits };
}

const ID = 'allowed/repo#7';

async function setup(pr?: Pr, opts: { bind?: { isLoopback: boolean; allowAdd: boolean } } = {}) {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { gh, edits } = fakeGh(pr);
  const { ctx } = await makeCtx(repo, { gh, ...opts });
  ctx.audit = new AuditLog(ctx.configDir);
  return { repo, ctx, edits };
}

test('removes reviewed and the trigger, then re-adds the trigger in the spelling the repo has', async () => {
  const { repo, ctx, edits } = await setup({ labels: ['taskcell:reviewed', 'ready for vanguard review'], repoLabels: ['ready for vanguard review'] });
  await dispatchRpc(ctx, 'rereview_pr', { repoPath: repo, id: ID });
  expect(edits).toEqual([
    ['pr', 'edit', '7', '--repo', 'allowed/repo', '--remove-label', 'taskcell:reviewed', '--remove-label', 'ready for vanguard review'],
    ['pr', 'edit', '7', '--repo', 'allowed/repo', '--add-label', 'ready for vanguard review'],
  ]);
  expect(await ctx.audit!.read()).toEqual([expect.objectContaining({ action: 'pr-rereview', actor: { kind: 'token', name: 'token' }, login: 'token', target: expect.stringContaining(ID), outcome: 'ok' })]);
});

test.each([
  ['a non-factory branch', { headRefName: 'feature/x' }, 'not on a factory branch'],
  ['a fork PR', { isCrossRepository: true }, 'from a fork'],
  ['a closed PR', { state: 'CLOSED' }, 'not open'],
  ['a PR being reviewed', { labels: ['taskcell:reviewing'] }, 'is being reviewed, revised or run'],
  ['a running PR', { labels: ['taskcell:running'] }, 'is being reviewed, revised or run'],
  ['a legacy-running PR', { labels: ['vanguard:running'] }, 'is being reviewed, revised or run'],
  ['a mixed-case running PR', { labels: ['VANGUARD:Running'] }, 'is being reviewed, revised or run'],
  ['a PR being revised', { labels: ['taskcell:revising'] }, 'is being reviewed, revised or run'],
  ['a legacy-reviewing PR', { labels: ['vanguard:reviewing'] }, 'is being reviewed, revised or run'],
  ['a legacy-revising PR', { labels: ['vanguard:revising'] }, 'is being reviewed, revised or run'],
  ['a mixed-case reviewing PR', { labels: ['Taskcell:Reviewing'] }, 'is being reviewed, revised or run'],
])('refuses %s without a label change', async (_n, pr: Pr, reason: string) => {
  const { repo, ctx, edits } = await setup(pr);
  await expect(dispatchRpc(ctx, 'rereview_pr', { repoPath: repo, id: ID })).rejects.toThrow(reason);
  expect(edits).toEqual([]);
});

test('refuses a non-GitHub project', async () => {
  const repo = await tmpRepo();
  const { gh, edits } = fakeGh();
  const { ctx } = await makeCtx(repo, { gh });
  await expect(dispatchRpc(ctx, 'rereview_pr', { repoPath: repo, id: ID })).rejects.toThrow('no GitHub remote');
  expect(edits).toEqual([]);
});

test('refuses a repo outside the allowlist', async () => {
  const { ctx, edits } = await setup();
  const other = await tmpGitRepo('https://github.com/other/repo.git');
  await expect(dispatchRpc(ctx, 'rereview_pr', { repoPath: other, id: 'other/repo#7' })).rejects.toThrow();
  expect(edits).toEqual([]);
});

test('refuses when the hub does not accept remote writes', async () => {
  const { repo, ctx, edits } = await setup(undefined, { bind: { isLoopback: false, allowAdd: false } });
  await expect(dispatchRpc(ctx, 'rereview_pr', { repoPath: repo, id: ID })).rejects.toThrow('disabled on a non-loopback bind');
  expect(edits).toEqual([]);
});
