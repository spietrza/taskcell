import { describe, expect, it } from 'vitest';
import { BOT_ACTOR, sealAll, type AuditFile } from './audit.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIssueHistory, fetchGithubHostEvents, githubTimelineEvents, issueOfTaskId, prRunOf, readIssueHistory, type HistoryRun } from './history.js';
import { beginRun } from './run-store.js';
import type { RunResult } from './types.js';

const seal = (payloads: Record<string, unknown>[], ctx: Parameters<typeof sealAll>[1]): AuditFile => ({
  name: '/x/s.jsonl',
  text: sealAll(payloads, ctx, undefined).map((r) => JSON.stringify(r)).join('\n') + '\n',
});
const ev = (ts: string, data: Record<string, unknown>, runId: string): Record<string, unknown> => ({ id: 1, ts, event: 'api:event', data: { runId, event: data } });

const run = (_n: number, ts: string, prUrl: string): HistoryRun => ({
  taskId: 'gh-o-r-7', timestamp: ts, prUrl, anyFailed: false,
  stages: [{ name: 'reviewer', verdict: 'pass', timestamp: ts }],
});

function fixture() {
  const events1 = seal([ev('2026-01-01T10:00:00Z', { type: 'run-start', taskId: 'gh-o-r-7', flow: 'f', provider: 'p' }, 'run-1'), ev('2026-01-01T10:05:00Z', { type: 'run-end', prUrl: 'https://github.com/o/r/pull/9' }, 'run-1')], { actor: { kind: 'user', name: 'ann' }, subject: { repo: '/p', runId: 'run-1' } });
  const events2 = seal([ev('2026-01-02T10:00:00Z', { type: 'run-start', taskId: 'gh-o-r-7', flow: 'f', provider: 'p' }, 'run-2')], { actor: BOT_ACTOR, subject: { repo: '/p', runId: 'run-2' } });
  const decisions = seal([{ timestamp: '2026-01-03T09:00:00Z', verdict: 'APPROVE', mode: 'shadow', rulesFired: ['small'] }], { actor: BOT_ACTOR, subject: { repo: 'o/r', pr: 9 } });
  const input = {
    repo: 'o/r', issue: 7, repoAliases: ['/p'],
    units: [
      { stream: 'run-events', name: 'gh-o-r-7/a', files: [events1] },
      { stream: 'run-events', name: 'gh-o-r-7/b', files: [events2] },
      { stream: 'decisions', name: 'decisions', files: [decisions] },
    ],
    runs: [run(1, '2026-01-01T10:06:00Z', 'https://github.com/o/r/pull/9'), run(2, '2026-01-02T10:06:00Z', 'https://github.com/o/r/pull/9')],
    host: githubTimelineEvents([
      { event: 'labeled', id: 1, created_at: '2026-01-01T09:00:00Z', actor: { login: 'bob' }, label: { name: 'ready for agent' } },
      { event: 'merged', id: 2, created_at: '2026-01-03T10:00:00Z', actor: { login: 'bob' } },
    ], 'pr#9', 'o/r'),
  };
  return { input, events1 };
}

describe('buildIssueHistory', () => {
  it('orders two runs, a revise round, the approver decision and the merge oldest first', () => {
    const h = buildIssueHistory(fixture().input);
    expect(h.prs).toEqual([9]);
    expect(h.entries.map((e) => e.kind)).toEqual([
      'label', 'run-start', 'run-end', 'review', 'run-start', 'revision', 'review', 'approver', 'merge',
    ]);
    expect(h.entries[0]).toMatchObject({ actor: { kind: 'user', name: 'bob' }, chain: 'none', source: { stream: 'github' } });
    expect(h.entries[1]).toMatchObject({ actor: { kind: 'user', name: 'ann' }, chain: 'verified', source: { stream: 'run-events', ref: 's.jsonl:1' } });
    expect(h.entries.find((e) => e.kind === 'approver')?.what).toContain('APPROVE');
    expect(h.chains.every((c) => c.ok)).toBe(true);
  });

  it('flags a tampered stream', () => {
    const { input, events1 } = fixture();
    input.units[0] = { stream: 'run-events', name: 'gh-o-r-7/a', files: [{ ...events1, text: events1.text.replace('run-1', 'run-X') }] };
    const h = buildIssueHistory(input);
    expect(h.chains[0]).toMatchObject({ ok: false });
    expect(h.chains[0]!.problems[0]!.reason).toMatch(/hash mismatch/);
    expect(h.entries.filter((e) => e.source.stream === 'run-events' && e.time < '2026-01-02').every((e) => e.chain === 'failed')).toBe(true);
  });
});

describe('chain marks', () => {
  it('does not call an unchained legacy line verified', () => {
    const { input } = fixture();
    const legacy = JSON.stringify({ timestamp: '2026-01-03T08:00:00Z', verdict: 'ESCALATE', mode: 'shadow', subject: { repo: 'o/r', pr: 9 } });
    const d = input.units[2]!.files[0]!;
    input.units[2] = { ...input.units[2]!, files: [{ ...d, text: `${legacy}\n${d.text}` }] };
    const h = buildIssueHistory(input);
    const approvers = h.entries.filter((e) => e.kind === 'approver');
    expect(approvers.map((e) => e.chain)).toEqual(['none', 'verified']);
    expect(h.chains[2]).toMatchObject({ ok: true, legacy: 1 });
  });
  it('shows a token starter as the token and one record per hub run end', () => {
    const { input } = fixture();
    input.runs[1] = { ...input.runs[1]!, startedBy: 'token' };
    const h = buildIssueHistory(input);
    expect(h.entries.filter((e) => e.source.stream === 'run-record' && e.kind === 'run-end')).toHaveLength(0);
    expect(h.entries.find((e) => e.kind === 'revision')?.actor).toEqual({ kind: 'token', name: 'token' });
    expect(h.entries.find((e) => e.source.stream === 'run-record' && e.kind === 'review')).toBeDefined();
  });
});

describe('task ids', () => {
  // The runners' own expressions: src/runners/spec.ts (task.id is `owner/repo#N`, src/tasks/github.ts),
  // src/cli/review-pr.ts and src/runners/revise-pr.ts.
  const specId = (taskId: string): string => `spec-${taskId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  const reviewId = (repoSlug: string, n: number): string => `pr-review-${repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${n}`;
  const reviseId = (repoSlug: string, n: number): string => `revise-pr-${repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${n}`;

  it('maps run, spec, review and revise runs', () => {
    expect(issueOfTaskId('gh-o-r-904', 'o/r')).toBe(904);
    expect(issueOfTaskId(specId('O/r.js#904'), 'O/r.js')).toBe(904);
    expect(issueOfTaskId(specId('x/y#904'), 'o/r')).toBeUndefined();
    expect(issueOfTaskId('linear-abc-1', 'o/r')).toBeUndefined();
    expect(issueOfTaskId(reviewId('o/r', 9), 'o/r')).toBeUndefined();
    expect(issueOfTaskId(reviseId('o/r', 9), 'o/r')).toBeUndefined();
    expect(prRunOf(reviewId('o/r', 9), 'o/r')).toBe(9);
    expect(prRunOf(reviseId('o/r', 9), 'o/r')).toBe(9);
    expect(prRunOf(reviewId('x/y', 9), 'o/r')).toBeUndefined();
    expect(prRunOf(reviseId('x/y', 9), 'o/r')).toBeUndefined();
  });
  it('labels a spec run and a revise run', () => {
    const { input } = fixture();
    input.runs.push({ taskId: specId('o/r#7'), timestamp: '2026-01-01T09:30:00Z', anyFailed: false, stages: [] });
    input.runs.push({ taskId: reviseId('o/r', 9), timestamp: '2026-01-02T12:00:00Z', anyFailed: false, stages: [] });
    const h = buildIssueHistory(input);
    expect(h.entries.some((e) => e.kind === 'spec' && e.source.ref.startsWith('spec-o-r-7/'))).toBe(true);
    expect(h.entries.some((e) => e.kind === 'revision' && e.source.ref.startsWith('revise-pr-o-r-9/'))).toBe(true);
  });
  it('reads the spec, review and revise runs the runners record for the issue and its PR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-runs-'));
    const result = (taskId: string): RunResult => ({ taskId, completed: true, exitReason: 'completed', turns: 1, worktreePath: '/missing', worktreePreserved: false, finalText: '' });
    const write = (taskId: string, ts: string, name: string, prUrl?: string): Promise<void> =>
      beginRun(dir, taskId, ts).writeStages([{ name, result: result(taskId) }], prUrl !== undefined ? { prUrl } : {});
    await write(specId('o/r#7'), '2026-01-01T09:00:00.000Z', 'spec');
    await write('gh-o-r-7', '2026-01-01T10:00:00.000Z', 'implementer', 'https://github.com/o/r/pull/9');
    await write(reviewId('o/r', 9), '2026-01-01T11:00:00.000Z', 'pr-review');
    await write(reviseId('o/r', 9), '2026-01-02T10:00:00.000Z', 'implementer');
    await write(reviseId('o/r', 10), '2026-01-02T11:00:00.000Z', 'implementer');
    await write(specId('o/r#8'), '2026-01-02T12:00:00.000Z', 'spec');
    const h = await readIssueHistory({ repoPath: dir, repo: 'o/r', issue: 7, localRepo: 'o/r', offline: true });
    const refs = h.entries.filter((e) => e.source.stream === 'run-record').map((e) => `${e.kind} ${e.source.ref.split('/')[0]}`);
    expect(refs).toEqual(['spec spec-o-r-7', 'run-end gh-o-r-7', 'run-end pr-review-o-r-9', 'revision revise-pr-o-r-9']);
    expect(h.unavailable).toEqual([]);
  });
});

describe('Git host events', () => {
  const xref = (html: string, n: number) => ({ event: 'cross-referenced', id: n, created_at: '2026-01-02T00:00:00Z', source: { issue: { number: n, html_url: html, pull_request: {} } } });
  it('ignores a pull request of another repo and a passing "tech spec" mention', async () => {
    const calls: string[] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args.at(-1)!);
      if (args.at(-1)!.endsWith('/issues/7/timeline'))
        return JSON.stringify([[xref('https://github.com/other/repo/pull/99', 99), xref('https://github.com/o/r/pull/9', 9),
          { event: 'commented', id: 5, created_at: '2026-01-01T00:00:00Z', actor: { login: 'bob' }, body: 'please write a tech spec' },
          { event: 'commented', id: 6, created_at: '2026-01-01T00:01:00Z', actor: { login: 'github-actions[bot]' }, body: '## Taskcell Tech Spec\n...' }]]);
      return '[[]]';
    };
    const { events } = await fetchGithubHostEvents('o/r', 7, [], gh);
    expect(calls).toEqual(['repos/o/r/issues/7/timeline', 'repos/o/r/issues/9/timeline']);
    expect(events.filter((e) => e.kind === 'spec')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'comment' && e.what.startsWith('commented'))).toHaveLength(1);
  });
  it('reports an unreadable host as unavailable', async () => {
    const r = await fetchGithubHostEvents('o/r', 7, [], async () => { throw new Error('x'); });
    expect(r.unavailable).toEqual(['github']);
  });
});

describe('readIssueHistory', () => {
  it('does not mix another repo\'s issue with this checkout\'s local records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const h = await readIssueHistory({ repoPath: dir, repo: 'o/r', issue: 5, localRepo: 'x/y', offline: true });
    expect(h.entries).toEqual([]);
    expect(h.unavailable[0]).toMatch(/this checkout is x\/y/);
  });
});
