import { expect, test, vi } from 'vitest';
import { dispatchRpc, makeCtx, tmpGitRepo } from '../test-kit.js';

const file = vi.hoisted(() => ({ text: '' }));
const append = vi.hoisted(() => vi.fn(async () => ({ branch: 'vanguard-metrics', pushed: 1 })));
vi.mock('../../core/metrics-branch.js', async (orig) => ({ ...(await orig<typeof import('../../core/metrics-branch.js')>()), readBranchFile: async () => file.text }));
vi.mock('../../core/lessons.js', async (orig) => ({ ...(await orig<typeof import('../../core/lessons.js')>()), appendLessonRecords: append }));

const lesson = (id: string, paths: string[], timestamp: string): string =>
  JSON.stringify({ kind: 'lesson', id, rule: `rule ${id}`, why: 'because', evidence: `https://github.com/o/r/pull/${id}`, paths, repo: 'o/r', prNumber: 1, timestamp });

test('list_lessons returns live lessons newest first, without dismissed ones, and narrows by task text', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  file.text = [lesson('a', [], '2026-01-01T00:00:00Z'), lesson('b', ['src/core/**'], '2026-02-01T00:00:00Z'), lesson('c', [], '2026-03-01T00:00:00Z'), JSON.stringify({ kind: 'dismiss', id: 'c', timestamp: '2026-03-02T00:00:00Z' })].join('\n');
  const all = (await dispatchRpc(ctx, 'list_lessons', { repoPath: repo })) as { lessons: { id: string }[]; branchFound: boolean };
  expect(all.lessons.map((l) => l.id)).toEqual(['b', 'a']);
  expect(all.branchFound).toBe(true);
  expect(all.lessons[0]).not.toHaveProperty('kind');
  const some = (await dispatchRpc(ctx, 'list_lessons', { repoPath: repo, taskText: 'fix docs/cli.md' })) as { lessons: { id: string }[] };
  expect(some.lessons.map((l) => l.id)).toEqual(['a']);
});

test('list_lessons says so when there is no metrics branch', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  file.text = '';
  expect(await dispatchRpc(ctx, 'list_lessons', { repoPath: repo })).toEqual({ lessons: [], branchFound: false });
});

test('dismiss_lesson appends a dismissal for a live lesson', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  file.text = lesson('a', [], '2026-01-01T00:00:00Z');
  await dispatchRpc(ctx, 'dismiss_lesson', { repoPath: repo, id: 'a' });
  expect(append).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ kind: 'dismiss', id: 'a' })]);
  await expect(dispatchRpc(ctx, 'dismiss_lesson', { repoPath: repo, id: 'zzz' })).rejects.toThrow('No live lesson');
});

test('dismiss_lesson is refused without mutation rights', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
  append.mockClear();
  file.text = lesson('a', [], '2026-01-01T00:00:00Z');
  await expect(dispatchRpc(ctx, 'dismiss_lesson', { repoPath: repo, id: 'a' })).rejects.toThrow('disabled on a non-loopback bind');
  expect(append).not.toHaveBeenCalled();
});
