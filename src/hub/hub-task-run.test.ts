// The hub-board scheduler through the real server wiring: RPC in, `deps.createRun` out.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHubServer, type HubServer, type HubServerOptions } from './server.js';
import { localOnlyIdentity } from './auth.js';
import { add as addProject } from './projects.js';
import { saveTeams } from './teams.js';
import { HUB_TOKEN_HEADER } from '../hub-wire.js';
import { BadRequestError, type SidecarDeps } from '../sidecar/sidecar.js';
import type { AuditEntry, BoardTask, CreateRunParams, CreateRunResult, RunCredential } from '../wire.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON envelope in tests */
let dirs: string[] = [];
let hub: HubServer;
let baseUrl: string;
let repo: string;
let options: HubServerOptions;
/** Makes the fake pre-flight refuse, as a hub without a model credential does. */
let missingCredential = false;
/** Runs `deps.createRun` was asked for, each ended by the test. */
let runs: { params: CreateRunParams; credential: RunCredential | undefined; end: (r: CreateRunResult) => void; fail: (e: Error) => void }[] = [];

function deps(): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: unimplemented,
    createRun: (params, _onEvent, credential) => new Promise((end, fail) => runs.push({ params, credential, end, fail })),
    checkRun: async () => {
      if (missingCredential) throw new BadRequestError('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
    },
    createTask: unimplemented,
    listFlows: unimplemented,
    listProviders: unimplemented,
    readFlow: unimplemented,
    writeFlow: unimplemented,
    deleteFlow: unimplemented,
    listTasks: async () => ({ tasks: [], capped: false }),
    fetchSpec: unimplemented,
    listRepoFiles: unimplemented,
    readRepoFile: unimplemented,
    listRuns: unimplemented,
    readRun: unimplemented,
  };
}

async function listen(): Promise<void> {
  hub = createHubServer(options);
  await hub.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  runs = [];
  missingCredential = false;
  repo = await realpath(await mkdtemp(join(tmpdir(), 'vanguard-hubrun-repo-')));
  const configDir = await mkdtemp(join(tmpdir(), 'vanguard-hubrun-cfg-'));
  const uiDir = await mkdtemp(join(tmpdir(), 'vanguard-hubrun-ui-'));
  dirs = [repo, configDir, uiDir];
  await execa('git', ['init', '-q', repo]); // no origin at all
  await writeFile(join(configDir, 'local-worker.json'), JSON.stringify({ [repo]: { enabled: true } })); // auto-run on: a hub board is off until switched
  await writeFile(join(uiDir, 'index.html'), '<html><head></head></html>');
  await saveTeams(configDir, [{ id: 't', name: 'T', members: [{ login: '1', role: 'member' }], repositories: [repo] }]);
  options = {
    uiDir,
    configDir,
    browseRoot: repo,
    bind: { isLoopback: true, allowAdd: false },
    seedRepoPath: repo,
    deps: deps(),
    adminGithubLogins: ['Root'],
    identity: {
      ...localOnlyIdentity(),
      sessionUser: async (req) => {
        const raw = req.headers['x-test-user'];
        if (typeof raw !== 'string') return undefined;
        const [id, login] = raw.split(':');
        return { id: id!, email: `${id}@example.com`, name: id!, login: `github:${login}` };
      },
      userById: async (id) => ({ id, email: `${id}@example.com`, name: id }),
    },
  };
  await listen();
});

afterEach(async () => {
  await hub.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const alice = '1:alice';
const root = '99:root';

async function rpc(as: string | undefined, cmd: string, args: unknown = {}): Promise<{ status: number; body: { error: { message: string }; result: any } }> {
  const res = await fetch(`${baseUrl}/rpc/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, ...(as === undefined ? { [HUB_TOKEN_HEADER]: hub.token } : { 'x-test-user': as }) },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}

const useHubBoard = (): Promise<unknown> => rpc(alice, 'write_app_config', { repoPath: repo, config: { taskSource: 'hub' } });
const create = (title: string, body = ''): Promise<{ status: number; body: any }> => rpc(alice, 'hub_task_create', { repoPath: repo, title, body });
const board = async (): Promise<Record<string, BoardTask>> => Object.fromEntries(((await rpc(alice, 'list_tasks', { repoPath: repo })).body.result.tasks as BoardTask[]).map((t) => [t.id, t]));
const audit = async (): Promise<AuditEntry[]> => (await rpc(undefined, 'read_audit')).body.result as AuditEntry[];

test('a hub task runs from its stored title and body, as its creator, audited; its dependent waits and starts after it', async () => {
  await useHubBoard();
  await create('Add a health endpoint', 'GET /healthz answers 200');
  await create('Document it');
  expect((await rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-2', blockedBy: ['hub-1'] })).status).toBe(200);
  expect((await board())['hub-2']).toMatchObject({ schedule: { state: 'blocked', label: 'blocked by hub-1' } });

  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  // The stored task is the run's whole source: no tracker, and a repository with no origin.
  expect(runs[0]!.params).toMatchObject({ issueRef: 'hub-1', repoPath: repo, transport: 'hub', hubTask: { id: 'hub-1', title: 'Add a health endpoint', body: 'GET /healthz answers 200' }, startedBy: '1@example.com' });
  expect(runs[0]!.credential?.source).toBe('instance');
  expect(await audit()).toContainEqual(expect.objectContaining({ login: '1@example.com', action: 'run-start', outcome: 'ok' }));
  expect((await board())['hub-1']).toMatchObject({ column: 'running', schedule: { state: 'running' } });
  expect((await rpc(alice, 'fetch_spec', { repoPath: repo, taskId: 'hub-1' })).body.result).toEqual({ spec: '# Add a health endpoint\n\nGET /healthz answers 200' });

  await hub.sweepHubTasks(); // hub-2 is still blocked
  expect(runs).toHaveLength(1);
  runs[0]!.end({ branch: 'chore/vanguard-hub-1-abc' });
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ column: 'done', schedule: { state: 'done', result: 'branch chore/vanguard-hub-1-abc' } }));
  await hub.sweepHubTasks();
  expect(runs[1]?.params).toMatchObject({ issueRef: 'hub-2', hubTask: { title: 'Document it' } });
});

test('a failed run shows its reason, keeps its dependent blocked, and can be retried', async () => {
  await useHubBoard();
  await create('A');
  await create('B');
  await rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-2', blockedBy: ['hub-1'] });
  await hub.sweepHubTasks();
  runs[0]!.fail(new Error('Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY'));
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ column: 'verify-failed', schedule: { state: 'failed', reason: 'Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY' } }));
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  expect((await board())['hub-2']).toMatchObject({ schedule: { state: 'blocked' } });
  expect((await rpc(alice, 'hub_task_retry', { repoPath: repo, id: 'hub-2' })).status).toBe(400); // not failed
  expect((await rpc(alice, 'hub_task_retry', { repoPath: repo, id: 'hub-1' })).status).toBe(200);
  await hub.sweepHubTasks();
  expect(runs[1]?.params.issueRef).toBe('hub-1');
});

test('a start refused for a missing model credential stays todo, never failed, is audited once, and runs once the credential is there', async () => {
  missingCredential = true;
  await useHubBoard();
  await create('A');
  await hub.sweepHubTasks();
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0);
  expect((await board())['hub-1']).toMatchObject({ column: 'queued', schedule: { state: 'refused', label: expect.stringMatching(/^not started: Set CLAUDE_CODE_OAUTH_TOKEN/) } });
  expect((await audit()).filter((e) => e.action === 'run-start' && e.outcome === 'refused')).toHaveLength(1);
  expect((await audit()).filter((e) => e.action === 'run-start' && e.outcome === 'ok')).toHaveLength(0);
  missingCredential = false;
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
});

test('user-only: a task whose owner has no credential is refused visibly, stays todo, and runs once they save one', async () => {
  await useHubBoard();
  await rpc(root, 'set_credential_policy', { policy: 'user-only' });
  await create('A');
  await hub.sweepHubTasks();
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0);
  const card = (await board())['hub-1']!;
  expect(card).toMatchObject({ column: 'queued', schedule: { state: 'refused' } });
  expect(card.schedule?.reason).toMatch(/add one in Settings/);
  // One refusal line for the two ticks, under the owner's login.
  expect((await audit()).filter((e) => e.action === 'run-start' && e.outcome === 'refused' && e.login === '1@example.com')).toHaveLength(1);

  await rpc(alice, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-alice-secret' });
  await hub.sweepHubTasks();
  expect(runs[0]?.credential).toEqual({ source: 'user', env: { ANTHROPIC_API_KEY: 'sk-ant-alice-secret' } });
});

test('a busy run session queues one task (shown as queued, not running) and leaves the rest todo, never failed', async () => {
  await useHubBoard();
  for (const t of ['A', 'B', 'C']) await create(t);
  void rpc(alice, 'api_create_run', { params: { issueRef: '#1', repoPath: repo } }).catch(() => undefined); // someone's own run holds the one slot
  await vi.waitFor(() => expect(runs).toHaveLength(1));

  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  let cards = await board();
  expect(cards['hub-1']).toMatchObject({ column: 'queued', schedule: { state: 'queued', label: 'queued behind another run (position 1)' } });
  expect(cards['hub-2']).toMatchObject({ column: 'queued', schedule: { state: 'refused', reason: expect.stringContaining('already has a queued run') } });
  expect(cards['hub-3']).toMatchObject({ column: 'queued', schedule: { state: 'waits-slot' } });
  expect(await audit()).toContainEqual(expect.objectContaining({ action: 'run-queue', outcome: 'ok', login: '1@example.com' }));

  runs[0]!.end({});
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1]!.params.issueRef).toBe('hub-1');
  cards = await board();
  expect(cards['hub-1']).toMatchObject({ column: 'running', schedule: { state: 'running' } });
  await hub.sweepHubTasks(); // hub-2 now takes the project's one queue place
  expect((await board())['hub-2']).toMatchObject({ schedule: { state: 'queued' } });
});

test('repository content alone never starts a run, and other task sources see no hub-board activity', async () => {
  // A checkout that commits the hub board setting and a task file: the hub has no task for it.
  await mkdir(join(repo, '.taskcell'), { recursive: true });
  await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify({ taskSource: 'hub' }));
  await writeFile(join(repo, '.taskcell', 'hub-tasks.json'), JSON.stringify([{ id: 'hub-1', title: 'from the repo', body: 'x', status: 'todo', blockedBy: [] }]));
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0);
  expect((await rpc(alice, 'list_tasks', { repoPath: repo })).body.result).toMatchObject({ tasks: [], hubBoard: true });
  await addProject(options.configDir, repo);
  expect((await rpc(alice, 'list_tasks_all', { teamId: 't' })).body.result).toEqual({ tasks: [], capped: false, failures: [], hubBoards: [repo] });

  // Tasks the hub holds are not started once the project's source is no longer the hub board.
  await create('A');
  await rpc(alice, 'write_app_config', { repoPath: repo, config: { taskSource: 'github' } });
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0);
  for (const [cmd, args] of [['hub_task_create', { title: 'B' }], ['hub_task_schedule', { id: 'hub-1', blockedBy: [] }], ['hub_task_retry', { id: 'hub-1' }]] as const) {
    const res = await rpc(alice, cmd, { repoPath: repo, ...args });
    expect(res.status, cmd).toBe(400);
    expect(res.body.error.message).toMatch(/task source is not Hub board/);
  }
  expect((await rpc(alice, 'list_tasks', { repoPath: repo })).body.result).toEqual({ tasks: [], capped: false }); // the tracker's board, as before
});

test('a client cannot start a hub run itself: the transport is the scheduler\'s only', async () => {
  const res = await rpc(alice, 'api_create_run', { params: { issueRef: 'hub-1', repoPath: repo, transport: 'hub', hubTask: { id: 'hub-1', title: 't', body: 'b' } } });
  expect(res.status).toBe(400);
  expect(res.body.error.message).toMatch(/unknown transport "hub"/);
  expect(runs).toHaveLength(0);
});

test('input is capped and ids are checked', async () => {
  await useHubBoard();
  expect((await create('x'.repeat(301))).status).toBe(400);
  expect((await create('A', 'x'.repeat(64 * 1024 + 1))).status).toBe(400);
  await create('A');
  const schedule = (patch: object): Promise<{ status: number }> => rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-1', ...patch });
  expect((await schedule({ blockedBy: ['../x'] })).status).toBe(400);
  expect((await schedule({ blockedBy: Array.from({ length: 51 }, (_, i) => `hub-${i + 2}`) })).status).toBe(400);
  expect((await rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-1; rm', blockedBy: [] })).status).toBe(400);
  expect((await schedule({ blockedBy: ['hub-2'] })).status).toBe(200);
});

test('a restart leaves no task running: one whose run died with the hub is failed, not re-run until retried', async () => {
  await useHubBoard();
  await create('A');
  await hub.sweepHubTasks();
  expect((await board())['hub-1']).toMatchObject({ column: 'running' });
  await hub.close();
  await listen();
  expect((await board())['hub-1']).toMatchObject({ column: 'verify-failed', schedule: { state: 'failed', reason: expect.stringContaining('hub process') } });
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  expect((await rpc(alice, 'hub_task_retry', { repoPath: repo, id: 'hub-1' })).status).toBe(200);
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(2);
});

test('a task created with dependencies and a start date is held by them from its first sweep', async () => {
  await useHubBoard();
  await create('A');
  const made = await rpc(alice, 'hub_task_create', { repoPath: repo, title: 'B', blockedBy: ['hub-1'], startDate: '2999-01-01' });
  expect(made.status).toBe(200);
  expect((await rpc(alice, 'hub_task_create', { repoPath: repo, title: 'C', startDate: 'soon' })).status).toBe(400);
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1); // only A
  expect((await board())['hub-2']).toMatchObject({ blockedBy: ['hub-1'], startDate: '2999-01-01', schedule: { state: 'blocked' } });
  expect((await rpc(alice, 'hub_task_create', { repoPath: repo, title: 'D', startDate: '' })).status).toBe(400);
});

test('a run whose verify failed is failed, not done: its dependent does not start', async () => {
  await useHubBoard();
  await create('A');
  await create('B');
  await rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-2', blockedBy: ['hub-1'] });
  await hub.sweepHubTasks();
  runs[0]!.end({ branch: 'chore/vanguard-hub-1-abc', verificationFailed: true });
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ column: 'verify-failed', schedule: { state: 'failed', reason: expect.stringContaining('verify failed') } }));
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  expect((await board())['hub-2']).toMatchObject({ schedule: { state: 'blocked' } });
});

test('the owner is re-resolved when a task starts: a user the identity no longer knows does not run', async () => {
  await hub.close();
  options = { ...options, identity: { ...options.identity!, userById: async () => undefined } };
  await listen();
  await useHubBoard();
  await create('A');
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0);
  expect((await board())['hub-1']).toMatchObject({ schedule: { state: 'refused', reason: expect.stringContaining('no longer has an account') } });
});

test('a hub task carries hand-picked skills, shown on its card, and its run loads exactly those', async () => {
  await useHubBoard();
  await mkdir(join(repo, '.github/vanguard-skills/db'), { recursive: true });
  await writeFile(join(repo, '.github/vanguard-skills/db/SKILL.md'), '---\nname: db\n---\n');
  await create('Migrate', 'Skills: other');
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: ['nope'] })).status).toBe(400);
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: ['db'] })).body.result).toEqual({ skills: ['db'] });
  expect((await board())['hub-1']).toMatchObject({ skills: ['db'] });

  await hub.sweepHubTasks();
  expect(runs[0]!.params).toMatchObject({ issueRef: 'hub-1', skills: ['db'] });
  // A started task's list is fixed.
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: [] })).status).toBe(400);
});

test('a hub task\'s skills: refused on a non-hub project, for an unknown task and once started; clearing them overrides the body line', async () => {
  await rpc(alice, 'write_app_config', { repoPath: repo, config: { taskSource: 'github' } });
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: [] })).body.error.message).toContain('not Hub board');
  await useHubBoard();
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-9', skills: [] })).body.error.message).toContain('no hub task hub-9');
  await create('Body line', 'Skills: db');
  expect((await board())['hub-1']).toMatchObject({ skills: ['db'] }); // what its run would load
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: [] })).status).toBe(200);
  expect((await board())['hub-1']).not.toHaveProperty('skills');
  await hub.sweepHubTasks();
  expect(runs[0]!.params).toMatchObject({ skills: [] }); // the run ignores the body line too
  runs[0]!.end({ branch: 'b' });
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ column: 'done' }));
  expect((await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: [] })).body.error.message).toContain('before it starts');
});

test('clearing a hub task\'s skills removes them from its card and sends none to its run', async () => {
  await useHubBoard();
  await mkdir(join(repo, '.github/vanguard-skills/db'), { recursive: true });
  await writeFile(join(repo, '.github/vanguard-skills/db/SKILL.md'), '---\nname: db\n---\n');
  await create('Migrate');
  await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: ['db'] });
  await rpc(alice, 'set_task_skills', { repoPath: repo, taskId: 'hub-1', skills: [] });
  expect((await board())['hub-1']).not.toHaveProperty('skills');
  await hub.sweepHubTasks();
  expect(runs[0]!.params).toMatchObject({ skills: [] });
});

test('a verify-failed result can be accepted without a second run; its dependent then starts, and a retry clears the old result', async () => {
  await useHubBoard();
  await create('A');
  await create('B');
  await rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-2', blockedBy: ['hub-1'] });
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  runs[0]!.end({ prUrl: 'https://github.com/o/r/pull/1', verificationFailed: true });
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ schedule: { state: 'failed', result: 'https://github.com/o/r/pull/1', reason: expect.stringContaining('Accept the result') } }));
  expect((await rpc(alice, 'hub_task_accept', { repoPath: repo, id: 'hub-2' })).status).toBe(400); // not failed
  expect((await rpc(alice, 'hub_task_accept', { repoPath: repo, id: 'hub-1' })).status).toBe(200);
  expect((await board())['hub-1']).toMatchObject({ column: 'done', schedule: { state: 'done', result: 'https://github.com/o/r/pull/1' } });
  await hub.sweepHubTasks();
  expect(runs.map((r) => r.params.issueRef)).toEqual(['hub-1', 'hub-2']); // no second run of hub-1

  // A retry clears the stored result.
  runs[1]!.end({ branch: 'b', verificationFailed: true });
  await vi.waitFor(async () => expect((await board())['hub-2']).toMatchObject({ schedule: { state: 'failed', result: 'branch b' } }));
  await rpc(alice, 'hub_task_retry', { repoPath: repo, id: 'hub-2' });
  const stored = (await board())['hub-2'];
  expect(stored?.schedule?.result).toBeUndefined();
});

test('a failed task without a delivered result cannot be accepted', async () => {
  await useHubBoard();
  await create('A');
  await hub.sweepHubTasks();
  runs[0]!.end({});
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ schedule: { state: 'failed' } }));
  expect((await rpc(alice, 'hub_task_accept', { repoPath: repo, id: 'hub-1' })).status).toBe(400);
});

test('a board at the cap can delete or archive tasks, and creation works again', async () => {
  await useHubBoard();
  await create('A');
  await create('B');
  await rpc(alice, 'hub_task_schedule', { repoPath: repo, id: 'hub-2', blockedBy: ['hub-1'] });
  expect((await rpc(alice, 'hub_task_delete', { repoPath: repo, id: 'hub-1' })).status).toBe(400); // hub-2 waits on it
  expect((await rpc(alice, 'hub_task_archive', { repoPath: repo, id: 'hub-1' })).status).toBe(400); // not done
  await hub.sweepHubTasks();
  expect((await rpc(alice, 'hub_task_delete', { repoPath: repo, id: 'hub-1' })).status).toBe(400); // running
  runs[0]!.end({ branch: 'b' });
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ schedule: { state: 'done' } }));
  expect((await rpc(alice, 'hub_task_archive', { repoPath: repo, id: 'hub-1' })).status).toBe(200);
  expect(Object.keys(await board())).toEqual(['hub-2']);
  expect((await rpc(alice, 'hub_task_delete', { repoPath: repo, id: 'hub-2' })).status).toBe(200);
  expect(Object.keys(await board())).toEqual([]);
});

test('the audit and startedBy use the account as it is now, and the refusal line names the task', async () => {
  await useHubBoard();
  await create('A');
  await hub.close();
  options = { ...options, identity: { ...options.identity!, userById: async (id) => ({ id, email: 'new@example.com', name: 'New' }) } };
  await listen();
  await hub.sweepHubTasks();
  expect(runs[0]!.params.startedBy).toBe('new@example.com');
  expect(await audit()).toContainEqual(expect.objectContaining({ login: 'new@example.com', action: 'run-start', target: expect.stringContaining('hub-1') }));
});

test('a refused start is audited against the task as well as the repository', async () => {
  await hub.close();
  options = { ...options, identity: { ...options.identity!, userById: async () => undefined } };
  await listen();
  await useHubBoard();
  await create('A');
  await hub.sweepHubTasks();
  expect(await audit()).toContainEqual(expect.objectContaining({ action: 'run-start', outcome: 'refused', target: `${repo} hub-1` }));
});

test('auto-run off: a new card waits and says so; Start run starts that one task only, as its owner', async () => {
  await writeFile(join(options.configDir, 'local-worker.json'), JSON.stringify({ [repo]: { enabled: false } }));
  await useHubBoard();
  await create('A');
  await create('B');
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0);
  expect((await board())['hub-1']).toMatchObject({ state: 'auto-run is off — start it by hand' });
  expect((await rpc(alice, 'hub_task_start', { repoPath: repo, id: 'hub-9' })).status).toBe(400);
  expect((await rpc(alice, 'hub_task_start', { repoPath: repo, id: 'hub-2' })).status).toBe(200);
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.params).toMatchObject({ issueRef: 'hub-2', startedBy: '1@example.com' });
  expect((await board())['hub-1']).toMatchObject({ state: 'auto-run is off — start it by hand' });
  expect((await rpc(alice, 'hub_task_start', { repoPath: repo, id: 'hub-2' })).status).toBe(400); // already running
});

test('a card started or retried with a flow runs that flow; an unknown flow is refused before the card changes, naming the valid ones', async () => {
  await writeFile(join(options.configDir, 'local-worker.json'), JSON.stringify({ [repo]: { enabled: false } }));
  await useHubBoard();
  await create('A');
  await create('B');
  const refused = await rpc(alice, 'hub_task_start', { repoPath: repo, id: 'hub-1', flow: 'nope' });
  expect(refused.status).toBe(400);
  expect(refused.body.error.message).toMatch(/unknown flow "nope".*default, plan/);
  await hub.sweepHubTasks();
  expect(runs).toHaveLength(0); // the card was not marked for a start
  expect((await rpc(alice, 'hub_task_start', { repoPath: repo, id: 'hub-1', flow: 'plan' })).status).toBe(200);
  await hub.sweepHubTasks();
  expect(runs.map((r) => [r.params.issueRef, r.params.flow])).toEqual([['hub-1', 'plan']]);
  expect(await audit()).toContainEqual(expect.objectContaining({ action: 'task-schedule', target: `${repo}:hub-1`, detail: ['flow.plan'] }));
  runs[0]!.fail(new Error('boom'));
  await vi.waitFor(async () => expect((await board())['hub-1']).toMatchObject({ schedule: { state: 'failed' } }));
  expect((await rpc(alice, 'hub_task_start', { repoPath: repo, id: 'hub-2' })).status).toBe(200);
  await hub.sweepHubTasks();
  expect(runs[1]!.params).toMatchObject({ issueRef: 'hub-2' });
  expect(runs[1]!.params.flow).toBeUndefined();
  runs[1]!.fail(new Error('boom'));
  await vi.waitFor(async () => expect((await board())['hub-2']).toMatchObject({ schedule: { state: 'failed' } }));
  expect((await rpc(alice, 'hub_task_retry', { repoPath: repo, id: 'hub-1', flow: 'nope' })).status).toBe(400);
  expect((await board())['hub-1']).toMatchObject({ schedule: { state: 'failed' } });
  expect((await rpc(alice, 'hub_task_retry', { repoPath: repo, id: 'hub-1', flow: 'flow-b' })).status).toBe(200);
  await writeFile(join(options.configDir, 'local-worker.json'), JSON.stringify({ [repo]: { enabled: true } })); // a retried card waits for auto-run
  await hub.sweepHubTasks();
  expect(runs[2]!.params).toMatchObject({ issueRef: 'hub-1', flow: 'flow-b' });
});
