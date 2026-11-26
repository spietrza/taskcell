import { describe, it, expect } from 'vitest';
import { resumeRateLimited } from './resume-rate-limited.js';
import { ciLogTail } from './ci-watch.js';
import type { GhRunner } from '../tasks/github.js';

interface Pr { number: number; headRefName?: string; headRefOid?: string; isDraft?: boolean; isCrossRepository?: boolean; labels?: string[]; checks?: { name: string; bucket: string; link?: string }[] | 'none'; comments?: string[]; merge?: string[] }

const FAIL = [{ name: 'test', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/42/job/7' }];

function fake(prs: Pr[], login = 'alice'): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const [a, b] = args;
    const pr = prs.find((p) => String(p.number) === args[2]);
    if (a === 'api') return `${login}\n`;
    if (b === 'list' && args.includes('--label')) return '[]';
    if (a === 'pr' && b === 'list') {
      return JSON.stringify(prs.map((p) => ({ number: p.number, headRefName: p.headRefName ?? 'chore/taskcell-1-x', headRefOid: p.headRefOid ?? 'abcdef1234', isDraft: p.isDraft ?? false, isCrossRepository: p.isCrossRepository ?? false, labels: (p.labels ?? []).map((name) => ({ name })) })));
    }
    if (a === 'pr' && b === 'checks') {
      if (pr?.checks === 'none') throw new Error('no required checks reported on the branch');
      return JSON.stringify(pr?.checks ?? FAIL);
    }
    if (a === 'pr' && b === 'view' && !args.includes('comments')) {
      const state = pr?.merge && pr.merge.length > 1 ? pr.merge.shift() : (pr?.merge?.[0] ?? 'CLEAN');
      return JSON.stringify({ number: pr?.number, headRefOid: pr?.headRefOid ?? 'abcdef1234', baseRefName: 'main', mergeStateStatus: state });
    }
    if (a === 'pr' && b === 'view') return JSON.stringify({ comments: (pr?.comments ?? []).map((body) => ({ body, author: { login: 'alice' }, authorAssociation: 'OWNER' })) });
    if (a === 'run') return 'step failed\n<!-- x -->\n```evil```';
    if (a === 'pr' && (b === 'comment' || b === 'edit')) return '';
    if (a === 'label' || a === 'api') return '[]';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

const writes = (calls: string[][]): string[][] => calls.filter((c) => c[0] === 'pr' && (c[1] === 'comment' || c[1] === 'edit'));
const run = (prs: Pr[], extra: { dryRun?: boolean; ciWatch?: boolean; login?: string } = {}) => {
  const { gh, calls } = fake(prs, extra.login);
  const logs: string[] = [];
  return resumeRateLimited({ repoSlug: 'o/r', gh, log: (l) => logs.push(l), dryRun: extra.dryRun ?? false, sleep: async () => {}, ciWatch: extra.ciWatch ?? true }).then((report) => ({ report, calls, logs }));
};

describe('ci-watch conflicts', () => {
  const bodyOf = (calls: string[][]): string => { const w = writes(calls)[0]; return w?.[w.indexOf('--body') + 1] ?? ''; };
  it('DIRTY gets one conflict comment with a per-head marker and needs revision', async () => {
    const { calls, report } = await run([{ number: 5, merge: ['DIRTY'], checks: [{ name: 'a', bucket: 'pass' }] }]);
    const w = writes(calls);
    expect(w).toHaveLength(2);
    expect(bodyOf(calls)).toMatch(/^## Conflicts with main on abcdef1/);
    expect(bodyOf(calls)).toContain('<!-- taskcell-base-conflict: abcdef1234 -->');
    expect(w[1]).toEqual(['pr', 'edit', '5', '--repo', 'o/r', '--add-label', 'needs revision']);
    expect(report.conflicted).toHaveLength(1);
  });

  it.each(['CLEAN', 'BEHIND'])('%s is left alone', async (m) => {
    expect(writes((await run([{ number: 5, merge: [m], checks: [{ name: 'a', bucket: 'pass' }] }])).calls)).toEqual([]);
  });

  it('retries UNKNOWN, then acts; still UNKNOWN skips', async () => {
    expect(writes((await run([{ number: 5, merge: ['UNKNOWN', 'UNKNOWN', 'DIRTY'] }])).calls)).toHaveLength(2);
    const { calls, logs } = await run([{ number: 5, merge: ['UNKNOWN'] }]);
    expect(writes(calls)).toEqual([]);
    expect(logs.some((l) => l.includes('still UNKNOWN'))).toBe(true);
  });

  it('does not repeat on the same head and stops at two comments', async () => {
    expect(writes((await run([{ number: 5, merge: ['DIRTY'], comments: ['<!-- taskcell-base-conflict: abcdef1234 -->'] }])).calls)).toEqual([]);
    const two = ['<!-- taskcell-base-conflict: a -->', '<!-- taskcell-base-conflict: b -->'];
    const { calls, logs } = await run([{ number: 5, merge: ['DIRTY'], comments: two }]);
    expect(writes(calls)).toEqual([]);
    expect(logs.some((l) => l.includes('left to a human'))).toBe(true);
  });

  it('conflicting and red gets one round: the conflict first', async () => {
    const { calls, report } = await run([{ number: 5, merge: ['DIRTY'] }]);
    expect(writes(calls)).toHaveLength(2);
    expect(bodyOf(calls)).toMatch(/^## Conflicts with/);
    expect(report.ciFailed).toEqual([]);
  });

  it('dry-run reports conflicted and writes nothing', async () => {
    const dry = await run([{ number: 5, merge: ['DIRTY'] }], { dryRun: true });
    expect(writes(dry.calls)).toEqual([]);
    expect(dry.report.conflicted).toHaveLength(1);
    const off = await run([{ number: 5, merge: ['DIRTY'] }], { ciWatch: false });
    expect(writes(off.calls)).toEqual([]);
    expect(off.report.conflicted).toEqual([]);
  });
});

describe('ci-watch', () => {
  it('comments once and adds needs revision', async () => {
    const { calls, report } = await run([{ number: 5 }]);
    const w = writes(calls);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain('--body');
    const body = w[0]?.[w[0].indexOf('--body') + 1] ?? '';
    expect(body).toMatch(/^## CI failed on abcdef1/);
    expect(body).toContain('- test: https://github.com/o/r/actions/runs/42/job/7');
    expect(body).toContain('<!-- taskcell-ci-failed: abcdef1234 -->');
    expect(body).toContain('<\\!-- x -->');
    expect(w[1]).toEqual(['pr', 'edit', '5', '--repo', 'o/r', '--add-label', 'needs revision']);
    expect(report.ciFailed).toHaveLength(1);
  });

  it('a failure beside a cancelled check still comments, naming only the failure', async () => {
    const { calls } = await run([{ number: 5, checks: [...FAIL, { name: 'zz-cancelled', bucket: 'cancel' }] }]);
    const w = writes(calls);
    expect(w).toHaveLength(2);
    expect(w[0]?.[w[0].indexOf('--body') + 1]).not.toContain('zz-cancelled');
  });

  it('does not repeat on the same head, and stops at two comments', async () => {
    expect(writes((await run([{ number: 5, comments: ['<!-- taskcell-ci-failed: abcdef1234 -->'] }])).calls)).toEqual([]);
    const two = ['<!-- taskcell-ci-failed: a -->', '<!-- taskcell-ci-failed: b -->'];
    expect(writes((await run([{ number: 5, comments: two }])).calls)).toEqual([]);
    expect(writes((await run([{ number: 5, comments: [two[0] ?? ''] }])).calls)).toHaveLength(2);
  });

  const quiet: [string, Pr][] = [
    ['pending checks', { number: 1, checks: [...FAIL, { name: 'b', bucket: 'pending' }] }],
    ['passing checks', { number: 1, checks: [{ name: 'a', bucket: 'pass' }] }],
    ['cancelled checks', { number: 1, checks: [{ name: 'a', bucket: 'cancel' }] }],
    ['skipped and cancelled checks', { number: 1, checks: [{ name: 'a', bucket: 'skipping' }, { name: 'b', bucket: 'cancel' }] }],
    ['no required checks', { number: 1, checks: 'none' }],
    ['a draft', { number: 1, isDraft: true }],
    ['a fork PR', { number: 1, isCrossRepository: true }],
    ['a non-factory branch', { number: 1, headRefName: 'feat/1' }],
    ...['needs revision', 'taskcell:revising', 'vanguard:reviewing', 'vanguard:running', 'Taskcell:Reviewing', 'Needs Revision', 'TASKCELL:RATE-LIMITED', 'taskcell:rate-limited'].map((l): [string, Pr] => [`label ${l}`, { number: 1, labels: [l] }]),
  ];
  it.each(quiet)('leaves %s alone', async (_n, pr) => {
    expect(writes((await run([pr])).calls)).toEqual([]);
  });

  it('skips the step with a bot token', async () => {
    const { calls, logs } = await run([{ number: 5 }], { login: 'github-actions[bot]' });
    expect(writes(calls)).toEqual([]);
    expect(calls.some((c) => c.includes('headRefOid') || c.some((a) => a.includes('headRefOid')))).toBe(false);
    expect(logs.filter((l) => l.includes('needs a user token'))).toHaveLength(1);
  });

  it('dry-run writes nothing and reports; --no-ci-watch skips', async () => {
    const dry = await run([{ number: 5 }], { dryRun: true });
    expect(writes(dry.calls)).toEqual([]);
    expect(dry.report.ciFailed).toHaveLength(1);
    const off = await run([{ number: 5 }], { ciWatch: false });
    expect(off.calls.some((c) => c[0] === 'api')).toBe(false);
    expect(off.report.ciFailed).toEqual([]);
  });

  it('escapes comment openers and fences, and caps lines and characters', () => {
    const out = ciLogTail('<!-- a -->\n```\n' + 'x\n'.repeat(200));
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('```');
    expect(out.split('\n').length).toBeLessThanOrEqual(80);
    expect(ciLogTail('y'.repeat(20000)).length).toBe(8000);
  });

  it('drops a partial first line after slicing the tail', () => {
    const out = ciLogTail('```\n' + ('a'.repeat(149) + '\n').repeat(100));
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.split('\n').filter(Boolean).every((l) => l === 'a'.repeat(149))).toBe(true);
  });
});
