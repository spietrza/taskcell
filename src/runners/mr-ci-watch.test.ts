import { describe, it, expect } from 'vitest';
import { watchMrCiFailures } from './mr-ci-watch.js';
import { ciFailedMarker, conflictMarker } from './pr-feedback.js';
import type { GlabRunner } from '../tasks/gitlab.js';

interface Mr { iid: number; source_branch?: string; sha?: string; draft?: boolean; labels?: string[]; has_conflicts?: boolean; detailed_merge_status?: string; source_project_id?: number; target_project_id?: number }
interface Setup { mrs: Mr[]; pipeline?: string; notes?: { body: string; user?: string }[] }

function fake({ mrs, pipeline = 'failed', notes = [] }: Setup): { glab: GlabRunner; calls: string[][] } {
  const calls: string[][] = [];
  const glab: GlabRunner = async (args) => {
    calls.push(args);
    const path = args[1] ?? '';
    if (args[0] === 'api' && path === 'user') return JSON.stringify({ username: 'bot-user' });
    if (path.includes('/notes?')) return JSON.stringify(notes.map((n) => ({ body: n.body, system: false, author: { username: n.user ?? 'bot-user' } })));
    if (path.includes('/merge_requests?')) return JSON.stringify(mrs.map((m) => ({ source_branch: 'chore/taskcell-1-x', sha: 'abcdef1234', source_project_id: 1, target_project_id: 1, target_branch: 'main', ...m })));
    if (path.includes('/pipelines?')) return JSON.stringify([{ id: 9, status: pipeline }]);
    if (path.includes('/jobs?')) return JSON.stringify([{ id: 7, name: 'test', web_url: 'https://gl/j/7' }, { id: 8, name: 'lint', allow_failure: true }]);
    if (path.endsWith('/trace')) return 'step failed\n<!-- x -->\n```evil```';
    if (args[0] === 'mr' || args[0] === 'label') return '';
    throw new Error(`unexpected glab ${args.join(' ')}`);
  };
  return { glab, calls };
}

const run = async (setup: Setup, dryRun = false) => {
  const { glab, calls } = fake(setup);
  const report = { ciFailed: [] as string[], conflicted: [] as string[], escalated: [] as string[], failed: [] as string[] };
  await watchMrCiFailures({ project: 'g/p', dryRun, glab, log: () => {}, report });
  return { calls, report, notes: calls.filter((c) => c[0] === 'mr' && c[1] === 'note'), labels: calls.filter((c) => c[0] === 'mr' && c[1] === 'update') };
};
const noteBody = (c?: string[]): string => c?.[c.indexOf('-m') + 1] ?? '';

describe('mr ci-watch', () => {
  it('a failed pipeline gets one comment with failed jobs, an escaped log tail, a per-head marker and needs revision', async () => {
    const { notes, labels, report } = await run({ mrs: [{ iid: 3 }] });
    expect(notes).toHaveLength(1);
    const body = noteBody(notes[0]);
    expect(body).toMatch(/^## CI failed on abcdef1/);
    expect(body).toContain('- test: https://gl/j/7');
    expect(body).not.toContain('lint');
    expect(body).toContain('<\\!-- x -->');
    expect(body).toContain(ciFailedMarker('abcdef1234'));
    expect(labels.at(-1)).toEqual(['mr', 'update', '3', '--repo', 'g/p', '--label', 'needs revision']);
    expect(report.ciFailed).toHaveLength(1);
  });

  it('a conflicting MR gets a conflict comment and needs revision, not a CI comment', async () => {
    const { notes, labels, report } = await run({ mrs: [{ iid: 3, has_conflicts: true }] });
    expect(noteBody(notes[0])).toMatch(/^## Conflicts with main on abcdef1/);
    expect(noteBody(notes[0])).toContain(conflictMarker('abcdef1234'));
    expect(notes).toHaveLength(1);
    expect(labels).toHaveLength(1);
    expect(report.conflicted).toHaveLength(1);
  });

  it('detailed_merge_status conflict counts as a conflict', async () => {
    expect((await run({ mrs: [{ iid: 3, detailed_merge_status: 'conflict' }] })).report.conflicted).toHaveLength(1);
  });

  it('a clean MR with a green or running pipeline is left alone', async () => {
    for (const pipeline of ['success', 'running']) expect((await run({ mrs: [{ iid: 3 }], pipeline })).calls.filter((c) => c[0] === 'mr')).toEqual([]);
  });

  it('comments once per head but re-adds the label', async () => {
    const { notes, labels } = await run({ mrs: [{ iid: 3 }], notes: [{ body: ciFailedMarker('abcdef1234') }] });
    expect(notes).toHaveLength(0);
    expect(labels).toHaveLength(1);
  });

  it('a marker planted by another author neither dedupes nor counts toward the cap', async () => {
    const planted = { body: ciFailedMarker('abcdef1234'), user: 'mallory' };
    const { notes } = await run({ mrs: [{ iid: 3 }], notes: [planted, planted, planted] });
    expect(notes).toHaveLength(1);
    expect(noteBody(notes[0])).toMatch(/^## CI failed/);
  });

  it('at two CI comments it escalates once to needs-human-review, never needs revision', async () => {
    const two = [{ body: ciFailedMarker('1111111') }, { body: ciFailedMarker('2222222') }];
    const first = await run({ mrs: [{ iid: 3 }], notes: two });
    expect(noteBody(first.notes[0])).toContain('<!-- taskcell-ci-watch-cap: ci -->');
    expect(first.labels.at(-1)).toContain('taskcell::review');
    expect(first.report.escalated).toHaveLength(1);
    const again = await run({ mrs: [{ iid: 3 }], notes: [...two, { body: noteBody(first.notes[0]) }] });
    expect(again.notes).toHaveLength(0);
  });

  it('skips drafts, skip labels, forks and non-factory branches', async () => {
    const mrs = [{ iid: 1, draft: true }, { iid: 2, labels: ['needs revision'] }, { iid: 3, labels: ['taskcell::revising'] }, { iid: 4, labels: ['taskcell::rate-limited'] }, { iid: 5, target_project_id: 2 }, { iid: 6, source_branch: 'feature/x' }];
    expect((await run({ mrs })).calls.filter((c) => c[0] === 'mr')).toEqual([]);
  });

  it('--dry-run reports and writes nothing', async () => {
    const { calls, report } = await run({ mrs: [{ iid: 3 }, { iid: 4, has_conflicts: true }] }, true);
    expect(calls.filter((c) => c[0] === 'mr' || c[0] === 'label')).toEqual([]);
    expect(report.ciFailed[0]).toMatch(/dry-run/);
    expect(report.conflicted[0]).toMatch(/dry-run/);
  });
});
