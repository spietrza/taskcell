import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { answerCard, askingCards, cachedNeedsYou, forgetBoardWaiting } from './asking.js';
import { createHubTask, editHubTask, listHubTasks, type HubTaskOwner } from './hub-tasks.js';
import { OWNER } from './test-kit.js';

const owner: HubTaskOwner = { actor: { login: 'token', admin: true }, caller: OWNER };
let cfg: string;
let repo: string;
beforeEach(async () => {
  cfg = await mkdtemp(join(tmpdir(), 'asking-cfg-'));
  repo = await mkdtemp(join(tmpdir(), 'asking-repo-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(cfg, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

const appConfig = (c: Record<string, unknown>): Promise<void> => mkdir(join(repo, '.taskcell'), { recursive: true }).then(() => writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify(c)));
async function record(taskId: string, extra: Record<string, unknown>): Promise<void> {
  await mkdir(join(repo, '.taskcell', 'runs', taskId), { recursive: true });
  await writeFile(
    join(repo, '.taskcell', 'runs', taskId, '2026-11-17T15-53-58-120Z-implementer.json'),
    JSON.stringify({ taskId, timestamp: '2026-11-17T15:53:58.120Z', stage: 'implementer', turns: 1, durationMs: 1, worktreePath: '', worktreePreserved: false, ...extra }),
  );
}
const asked = { completed: false, exitReason: 'incomplete', finalText: 'To finish, I still need: which config file?' };

test('a hub card whose run stopped to ask waits as a Question until it is answered; the answer goes into its body', async () => {
  await appConfig({ taskSource: 'hub' });
  const t = await createHubTask(cfg, repo, { title: 'Validate the config', body: 'AC', owner });
  await editHubTask(cfg, repo, t.id, (x) => { x.status = 'failed'; x.reason = 'asked'; x.result = 'branch b'; });
  await record(t.id, asked);
  expect(await askingCards(cfg, repo)).toEqual([
    expect.objectContaining({ id: 'hub-1', kind: 'card', number: 1, title: 'Validate the config', ask: 'question', lastComment: { author: 'agent', body: asked.finalText } }),
  ]);
  await answerCard({ configDir: cfg, repoPath: repo, id: 'hub-1', body: 'config.json at the root', owner });
  const [task] = await listHubTasks(cfg, repo);
  expect(task).toMatchObject({ status: 'todo', body: 'AC\n\n## Answer\nconfig.json at the root' });
  expect(task!.reason).toBeUndefined();
  expect(await askingCards(cfg, repo)).toEqual([]);
  await expect(answerCard({ configDir: cfg, repoPath: repo, id: 'hub-1', body: 'again', owner })).rejects.toThrow(/not waiting/);
});

test('a run that finished, or a GitHub card whose run opened a PR, does not wait', async () => {
  await appConfig({ taskSource: 'github' });
  await record('gh-27', asked);
  await record('gh-28', { ...asked, prUrl: 'https://github.com/o/r/pull/3' });
  await record('gh-29', { completed: true, exitReason: 'completed', finalText: 'done' });
  expect((await askingCards(cfg, repo)).map((i) => [i.id, i.number, i.title])).toEqual([['gh-27', 27, 'Issue #27']]);
});

test('answering a GitHub card comments on the issue and puts the trigger label back', async () => {
  await appConfig({ taskSource: 'github' });
  await record('gh-27', asked);
  const calls: string[][] = [];
  const labels: string[] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: labels.map((name) => ({ name })) });
    if (args[1] === 'edit') labels.push(args.at(-1)!);
    return '';
  };
  await answerCard({ configDir: cfg, repoPath: repo, id: 'gh-27', body: 'use the default', owner, repoSlug: 'o/r', gh });
  expect(calls.filter((c) => c[1] !== 'view')[0]).toEqual(['issue', 'comment', '27', '--repo', 'o/r', '--body', 'use the default']);
  expect(calls.at(-1)).toEqual(['issue', 'edit', '27', '--repo', 'o/r', '--add-label', 'ready for agent']);
  // Answered: the trigger label is back, so the card leaves the list and a second answer is refused.
  expect(await askingCards(cfg, repo, { repoSlug: 'o/r', gh })).toEqual([]);
  await expect(answerCard({ configDir: cfg, repoPath: repo, id: 'gh-27', body: 'again', owner, repoSlug: 'o/r', gh })).rejects.toThrow(/not waiting/);
});

test('a GitHub card on a closed issue is neither listed nor answerable; one gh cannot read stays listed but is not answered', async () => {
  await appConfig({ taskSource: 'github' });
  await record('gh-27', asked);
  const closed = async (): Promise<string> => JSON.stringify({ state: 'CLOSED', labels: [] });
  expect(await askingCards(cfg, repo, { repoSlug: 'o/r', gh: closed })).toEqual([]);
  await expect(answerCard({ configDir: cfg, repoPath: repo, id: 'gh-27', body: 'x', owner, repoSlug: 'o/r', gh: closed })).rejects.toThrow(/not waiting/);
  const down = async (): Promise<string> => { throw new Error('offline'); };
  expect((await askingCards(cfg, repo, { repoSlug: 'o/r', gh: down })).map((i) => i.id)).toEqual(['gh-27']);
  await expect(answerCard({ configDir: cfg, repoPath: repo, id: 'gh-27', body: 'x', owner, repoSlug: 'o/r', gh: down })).rejects.toThrow(/not waiting/);
});

test('a hub card waits only while it is failed: a done card (accepted or not) never does', async () => {
  await appConfig({ taskSource: 'hub' });
  for (const title of ['A', 'B']) await createHubTask(cfg, repo, { title, body: '', owner });
  await editHubTask(cfg, repo, 'hub-1', (x) => { x.status = 'done'; });
  await editHubTask(cfg, repo, 'hub-2', (x) => { x.status = 'done'; x.accepted = true; });
  await record('hub-1', asked);
  await record('hub-2', asked);
  expect(await askingCards(cfg, repo)).toEqual([]);
});

/** A repository with a GitHub origin and a gh stub: one needs-info issue (`updatedAt` read live), its comments counted. */
async function githubRepo(): Promise<{ gh: (args: string[]) => Promise<string>; state: { updatedAt: string | undefined; lists: number; commentReads: number } }> {
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
  const state = { updatedAt: '2026-11-20T10:00:00Z' as string | undefined, lists: 0, commentReads: 0 };
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === 'api') return 'bot\n';
    if (args[0] === 'issue' && args[1] === 'list') {
      state.lists += 1;
      const issue = { number: 7, title: 'Vague', url: 'https://github.com/o/r/issues/7', labels: [{ name: 'needs info' }], ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}) };
      return JSON.stringify([issue]);
    }
    if (args[0] === 'pr' && args[1] === 'list') return '[]';
    if (args[1] === 'view' && args.at(-1) === 'state,labels') return JSON.stringify({ state: 'OPEN', labels: [] });
    if (args[1] === 'view') {
      state.commentReads += 1;
      return JSON.stringify({ comments: [{ author: { login: 'bot' }, body: `question at ${state.updatedAt}` }] });
    }
    return '';
  };
  return { gh, state };
}

test('a short read after a drop hands its comments to the next read; a changed updatedAt fetches them again', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { gh, state } = await githubRepo();
  forgetBoardWaiting(repo);
  await cachedNeedsYou(cfg, repo, gh);
  const first = await cachedNeedsYou(cfg, repo, gh, { remaining: 5 });
  expect(first.items[0]?.lastComment?.body).toBe('question at 2026-11-20T10:00:00Z');
  expect(state.commentReads).toBe(1);
  // The short read expired: the new read carries the comment over instead of fetching it again.
  vi.setSystemTime(Date.now() + 4_000);
  const second = await cachedNeedsYou(cfg, repo, gh, { remaining: 5 });
  expect(state.lists).toBe(2);
  expect(second.items[0]?.lastComment?.body).toBe('question at 2026-11-20T10:00:00Z');
  expect(state.commentReads).toBe(1);
  // The item moved on (a new updatedAt) after a drop: the short read's comment is not carried, it is read again.
  forgetBoardWaiting(repo);
  await cachedNeedsYou(cfg, repo, gh);
  await cachedNeedsYou(cfg, repo, gh, { remaining: 5 });
  expect(state.commentReads).toBe(2);
  vi.setSystemTime(Date.now() + 4_000);
  state.updatedAt = '2026-11-20T11:00:00Z';
  const third = await cachedNeedsYou(cfg, repo, gh, { remaining: 5 });
  expect(third.items[0]?.lastComment?.body).toBe('question at 2026-11-20T11:00:00Z');
  expect(state.commentReads).toBe(3);
});

test('an item without updatedAt keeps no comment between reads', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { gh, state } = await githubRepo();
  state.updatedAt = undefined;
  forgetBoardWaiting(repo);
  await cachedNeedsYou(cfg, repo, gh);
  await cachedNeedsYou(cfg, repo, gh, { remaining: 5 });
  vi.setSystemTime(Date.now() + 4_000);
  await cachedNeedsYou(cfg, repo, gh, { remaining: 5 });
  expect(state.commentReads).toBe(2);
});

test('a drop nobody read after for ten minutes is forgotten: the next read is a normal one', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { gh, state } = await githubRepo();
  forgetBoardWaiting(repo);
  vi.setSystemTime(Date.now() + 11 * 60_000);
  await cachedNeedsYou(cfg, repo, gh);
  vi.setSystemTime(Date.now() + 4_000);
  await cachedNeedsYou(cfg, repo, gh);
  expect(state.lists).toBe(1);
  // A fresh drop makes the next read a short one: it is read again after 3 s.
  forgetBoardWaiting(repo);
  await cachedNeedsYou(cfg, repo, gh);
  vi.setSystemTime(Date.now() + 4_000);
  await cachedNeedsYou(cfg, repo, gh);
  expect(state.lists).toBe(3);
});

test('withCards=false lists GitHub items only, not the run records asking', async () => {
  const { gh } = await githubRepo();
  await appConfig({ taskSource: 'github' });
  await record('gh-27', asked);
  forgetBoardWaiting(repo);
  expect((await cachedNeedsYou(cfg, repo, gh)).items.map((i) => i.id)).toEqual(['o/r#7', 'gh-27']);
  expect((await cachedNeedsYou(cfg, repo, gh, undefined, false)).items.map((i) => i.id)).toEqual(['o/r#7']);
});
