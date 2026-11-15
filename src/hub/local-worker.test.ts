import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { writeAppConfig } from './app-config.js';
import { boardServed, localWorkerMemory, localWorkerState, readLocalWorker, recordBoardPickup, setLocalWorker, sweepLocalWorkers, type LocalWorkerContext } from './local-worker.js';
import { cleanups, tmpGitRepo } from './test-kit.js';
import type { RunSession } from './run-session.js';
import type { CreateRunResult } from '../sidecar/sidecar.js';
import { BadRequestError } from '../sidecar/sidecar.js';

let cfg: string;
beforeEach(async () => { cfg = await mkdtemp(join(tmpdir(), 'localworker-')); });
afterEach(async () => { await rm(cfg, { recursive: true, force: true }); for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true }); });

const ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'x' };
const deps = (gh: (a: string[]) => Promise<string> = async () => '[]', env: NodeJS.ProcessEnv = ENV) => ({ gh, env });

async function githubRepo(extra: Record<string, unknown> = {}): Promise<string> {
  const repo = await tmpGitRepo('git@github.com:acme/widgets.git');
  await writeAppConfig(repo, { taskSource: 'github', ...extra });
  return repo;
}

/** A session that takes every run and settles it by hand. */
function fakeSession(): { session: RunSession; refs: string[]; end: (i: number) => void } {
  const refs: string[] = [];
  const settle: Array<(r: CreateRunResult) => void> = [];
  const session = {
    createRun: (p: { issueRef: string }, hooks?: { onStarted?: (id: string) => void }) => {
      refs.push(p.issueRef);
      hooks?.onStarted?.(`run-${refs.length}`);
      return new Promise<CreateRunResult>((ok) => settle.push(ok));
    },
  } as unknown as RunSession;
  return { session, refs, end: (i) => settle[i]!({}) };
}

const issues = (...n: number[]): string => JSON.stringify(n.map((number) => ({ number, labels: [{ name: 'ready for agent' }] })));
const ctxOf = (repo: string, session: RunSession, gh: (a: string[]) => Promise<string>, memory = localWorkerMemory()): LocalWorkerContext => ({
  configDir: cfg,
  runSession: session,
  allowlist: { assertAllowed: async (p: string) => p } as never,
  memory,
  deps: deps(gh),
});

test('off by default; the switch persists across a restart and off always works', async () => {
  const repo = await githubRepo();
  expect((await localWorkerState(cfg, repo, undefined, deps())).enabled).toBe(false);
  expect((await setLocalWorker(cfg, repo, true, undefined, deps())).enabled).toBe(true);
  expect((await readLocalWorker(cfg, repo)).enabled).toBe(true); // a fresh read = a restarted hub
  expect((await setLocalWorker(cfg, repo, false, undefined, deps())).enabled).toBe(false);
});

test('refusals: no task source, an unservable source, no credential, no GitHub origin', async () => {
  const none = await tmpGitRepo('git@github.com:acme/widgets.git');
  await expect(setLocalWorker(cfg, none, true, undefined, deps())).rejects.toThrow(/no task source/);
  const gl = await tmpGitRepo('git@github.com:acme/widgets.git');
  await writeAppConfig(gl, { taskSource: 'linear' });
  await expect(setLocalWorker(cfg, gl, true, undefined, deps())).rejects.toThrow(/GitHub Issues or the hub board/);
  const repo = await githubRepo();
  await expect(setLocalWorker(cfg, repo, true, undefined, deps(undefined, {}))).rejects.toThrow(BadRequestError);
  await expect(setLocalWorker(cfg, repo, true, undefined, deps(undefined, {}))).rejects.toThrow(/no provider credential/);
  const elsewhere = await tmpGitRepo('git@example.com:acme/widgets.git');
  await writeAppConfig(elsewhere, { taskSource: 'github' });
  await expect(setLocalWorker(cfg, elsewhere, true, undefined, deps())).rejects.toThrow(/not a github.com/);
  expect((await readLocalWorker(cfg, repo)).enabled).toBe(false); // refusals store nothing
});

test('a hub-board project can be switched on without a remote', async () => {
  const repo = await tmpGitRepo();
  await writeAppConfig(repo, { taskSource: 'hub' });
  expect(await setLocalWorker(cfg, repo, true, undefined, deps())).toMatchObject({ enabled: true, source: 'hub' });
});

test('a tick picks up labelled issues once, records the pick-up, and skips started or parked issues', async () => {
  const repo = await githubRepo({ concurrency: 2 });
  await setLocalWorker(cfg, repo, true, undefined, deps());
  const { session, refs } = fakeSession();
  const list = JSON.stringify([
    { number: 3, labels: [{ name: 'ready for agent' }, { name: 'taskcell:running' }] },
    { number: 2, labels: [{ name: 'ready for agent' }] },
  ]);
  const gh = vi.fn(async (_a: string[]) => list);
  const ctx = ctxOf(repo, session, gh);
  await sweepLocalWorkers(ctx);
  await sweepLocalWorkers(ctx);
  expect(refs).toEqual(['2']);
  expect(gh.mock.calls[0]![0]).toEqual(expect.arrayContaining(['--repo', 'acme/widgets', '--label', 'ready for agent']));
  expect(await readLocalWorker(cfg, repo)).toMatchObject({ lastPickup: '#2', enabled: true });
});

test('the parallel-run limit caps pick-ups per project; a finished run frees a slot', async () => {
  const repo = await githubRepo({ concurrency: 1 });
  await setLocalWorker(cfg, repo, true, undefined, deps());
  const { session, refs, end } = fakeSession();
  const ctx = ctxOf(repo, session, async () => issues(1, 2, 3));
  await sweepLocalWorkers(ctx);
  await sweepLocalWorkers(ctx);
  expect(refs).toEqual(['1']);
  end(0);
  await new Promise((r) => setTimeout(r, 0));
  await sweepLocalWorkers(ctx);
  expect(refs).toEqual(['1', '2']);
});

test('off stops new pick-ups; projects whose switch is off are never read', async () => {
  const repo = await githubRepo();
  const { session, refs } = fakeSession();
  const gh = vi.fn(async () => issues(1));
  await sweepLocalWorkers(ctxOf(repo, session, gh));
  expect(gh).not.toHaveBeenCalled();
  await setLocalWorker(cfg, repo, true, undefined, deps());
  await setLocalWorker(cfg, repo, false, undefined, deps());
  await sweepLocalWorkers(ctxOf(repo, session, gh));
  expect(refs).toEqual([]);
});

test('a failing read is recorded as the last error and cleared by the next pick-up', async () => {
  const repo = await githubRepo();
  await setLocalWorker(cfg, repo, true, undefined, deps());
  const { session } = fakeSession();
  const memory = localWorkerMemory();
  await sweepLocalWorkers(ctxOf(repo, session, async () => { throw new Error('gh is not signed in'); }, memory));
  expect((await readLocalWorker(cfg, repo)).lastError).toMatch(/not signed in/);
  await sweepLocalWorkers(ctxOf(repo, session, async () => issues(5), memory));
  expect(await readLocalWorker(cfg, repo)).toMatchObject({ lastPickup: '#5' });
  expect((await readLocalWorker(cfg, repo)).lastError).toBeUndefined();
});

test('hub boards: served unless explicitly off; pick-ups are shown only while on', async () => {
  const repo = await tmpGitRepo();
  await writeAppConfig(repo, { taskSource: 'hub' });
  expect(await boardServed(cfg, repo)).toBe(true);
  await recordBoardPickup(cfg, repo, ['hub-1']);
  expect((await readLocalWorker(cfg, repo)).lastPickup).toBeUndefined();
  await setLocalWorker(cfg, repo, true, undefined, deps());
  await recordBoardPickup(cfg, repo, ['hub-1']);
  expect((await readLocalWorker(cfg, repo)).lastPickup).toBe('hub-1');
  await setLocalWorker(cfg, repo, false, undefined, deps());
  expect(await boardServed(cfg, repo)).toBe(false);
});
