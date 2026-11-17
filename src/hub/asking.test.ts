import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { answerCard, askingCards } from './asking.js';
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
  const gh = async (args: string[]): Promise<string> => { calls.push(args); return ''; };
  await answerCard({ configDir: cfg, repoPath: repo, id: 'gh-27', body: 'use the default', owner, repoSlug: 'o/r', gh });
  expect(calls[0]).toEqual(['issue', 'comment', '27', '--repo', 'o/r', '--body', 'use the default']);
  expect(calls.at(-1)).toEqual(['issue', 'edit', '27', '--repo', 'o/r', '--add-label', 'ready for agent']);
});

test('a hub card an old store marked done on a run that asked still waits; an accepted one does not', async () => {
  await appConfig({ taskSource: 'hub' });
  for (const title of ['A', 'B']) await createHubTask(cfg, repo, { title, body: '', owner });
  await editHubTask(cfg, repo, 'hub-1', (x) => { x.status = 'done'; });
  await editHubTask(cfg, repo, 'hub-2', (x) => { x.status = 'done'; x.accepted = true; });
  await record('hub-1', asked);
  await record('hub-2', asked);
  expect((await askingCards(cfg, repo)).map((i) => i.id)).toEqual(['hub-1']);
});
