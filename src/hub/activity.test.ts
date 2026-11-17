import { describe, expect, test } from 'vitest';
import { activityFeed } from './activity.js';
import { AuditLog } from './audit.js';
import { savePaths } from './projects.js';
import { saveTeams, type Caller } from './teams.js';
import { ProjectAllowlist } from './allowlist.js';
import { dispatchRpc, makeCtx, tmpGitRepo } from './test-kit.js';
import type { AuditEntry, RepoStamp, RunSummary } from '../wire.js';

const repos = new Map([['/r/a', 'a'], ['/r/b', 'b']]);
const run = (repoPath: string, taskId: string, timestamp: string, extra: Partial<RunSummary> = {}): RunSummary & RepoStamp => ({
  taskId, timestamp, stages: ['implementer'], totalCostUsd: 0, anyFailed: false, repoPath, repoName: repoPath.slice(3), ...extra,
});
const line = (time: string, action: AuditEntry['action'], target: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({ time, login: 'ann', action, target, outcome: 'ok', ...extra });

describe('activityFeed', () => {
  test('merges run outcomes and hub actions newest first, with settings as key names only', () => {
    const feed = activityFeed(
      [run('/r/a', '#7', '2026-11-17T10:00:00.000Z', { startedBy: 'ann' }), run('/r/b', '#8', '2026-11-17T12:00:00.000Z', { anyFailed: true })],
      [
        line('2026-11-17T13:00:00.000Z', 'needs-merge', '/r/a:o/a#12'),
        line('2026-11-17T11:00:00.000Z', 'settings-change', '/r/a', { detail: ['budgetUsd'], changes: [{ key: 'budgetUsd', from: '5', to: '7' }] }),
        line('2026-11-17T09:00:00.000Z', 'task-create', '/r/b'),
        line('2026-11-17T08:00:00.000Z', 'run-start', '/r/a'),
      ],
      repos,
    );
    expect(feed.map((e) => [e.kind, e.repoName, e.subject ?? e.keys?.join() ?? ''])).toEqual([
      ['pr-merged', 'a', '#12'],
      ['run-failed', 'b', '#8'],
      ['settings-changed', 'a', 'budgetUsd'],
      ['run-finished', 'a', '#7'],
      ['card-created', 'b', ''],
      ['run-started', 'a', ''],
    ]);
    expect(JSON.stringify(feed)).not.toContain('"from"');
  });

  test('leaves out other repositories, failed actions, unnamed lines and a provider-limit stop as a failure', () => {
    const feed = activityFeed(
      [run('/r/c', '#1', '2026-11-17T10:00:00.000Z'), run('/r/a', '#2', '2026-11-17T10:00:00.000Z', { anyFailed: true, stoppedBy: 'provider-limit' })],
      [
        line('2026-11-17T11:00:00.000Z', 'settings-change', '/r/a2', { detail: ['color'] }), // another repo sharing the prefix
        line('2026-11-17T11:00:00.000Z', 'task-create', '/r/a', { outcome: 'refused' }),
        line('2026-11-17T11:00:00.000Z', 'settings-change', '/r/a'), // local worker switch: no keys
        line('2026-11-17T11:00:00.000Z', 'settings-change', '/r/a:skill'), // skills / lessons
        line('2026-11-17T11:00:00.000Z', 'clone', '/r/a'),
      ],
      repos,
    );
    expect(feed).toEqual([expect.objectContaining({ kind: 'run-finished', subject: '#2' })]);
  });

  test('caps the feed at the limit', () => {
    const runs = Array.from({ length: 40 }, (_, i) => run('/r/a', `#${i}`, new Date(Date.UTC(2026, 10, 1, i)).toISOString()));
    const feed = activityFeed(runs, [], repos);
    expect(feed).toHaveLength(30);
    expect(feed[0]!.subject).toBe('#39');
    expect(activityFeed(runs, [], repos, 3)).toHaveLength(3);
  });
});

test('list_activity returns only the selected team\'s repositories', async () => {
  const a = await tmpGitRepo();
  const b = await tmpGitRepo();
  const { ctx } = await makeCtx(a);
  ctx.allowlist = new ProjectAllowlist(async () => [a, b]);
  ctx.audit = new AuditLog(ctx.configDir);
  await savePaths(ctx.configDir, [a, b]);
  await saveTeams(ctx.configDir, [
    { id: 'one', name: 'One', members: [{ login: 'ann', role: 'member' }], repositories: [a] },
    { id: 'two', name: 'Two', members: [{ login: 'bob', role: 'admin' }], repositories: [b] },
  ]);
  await ctx.audit.record({ login: 'x', action: 'task-create', target: a, outcome: 'ok' });
  await ctx.audit.record({ login: 'x', action: 'task-create', target: b, outcome: 'ok' });
  const ann: Caller = { user: { id: 'ann', email: 'ann@x.test', name: 'ann' }, owner: false };
  const feed = (await dispatchRpc(ctx, 'list_activity', {}, ann)) as { repoPath: string }[];
  expect(feed.map((e) => e.repoPath)).toEqual([a]);
  await expect(dispatchRpc(ctx, 'list_activity', { teamId: 'two' }, ann)).rejects.toThrow(/not a member/);
});
