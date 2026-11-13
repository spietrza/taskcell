import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHubServer, type HubServer } from './server.js';
import { localOnlyIdentity } from './auth.js';
import { saveTeams } from './teams.js';
import { HUB_TOKEN_HEADER } from '../hub-wire.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';
import type { RunCredential } from '../wire.js';

const SECRET_A = 'sk-ant-alice-secret';
const SECRET_B = 'sk-ant-bob-secret';
const SECRET_INSTANCE = 'sk-ant-instance-secret';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON envelope in tests */
let dirs: string[] = [];
let hub: HubServer;
let baseUrl: string;
let configDir: string;
const createRun = vi.fn(async (_p: unknown, _e: unknown, _c?: RunCredential) => ({}));

function deps(): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: unimplemented,
    createRun: createRun as unknown as SidecarDeps['createRun'],
    createTask: unimplemented,
    listFlows: unimplemented,
    listProviders: unimplemented,
    readFlow: unimplemented,
    writeFlow: unimplemented,
    deleteFlow: unimplemented,
    listTasks: unimplemented,
    fetchSpec: unimplemented,
    listRepoFiles: unimplemented,
    readRepoFile: unimplemented,
    listRuns: unimplemented,
    readRun: unimplemented,
  };
}

beforeEach(async () => {
  createRun.mockClear();
  const repo = await mkdtemp(join(tmpdir(), 'vanguard-cred-repo-'));
  configDir = await mkdtemp(join(tmpdir(), 'vanguard-cred-cfg-'));
  const uiDir = await mkdtemp(join(tmpdir(), 'vanguard-cred-ui-'));
  dirs = [repo, configDir, uiDir];
  await execa('git', ['init', '-q', repo]);
  await writeFile(join(uiDir, 'index.html'), '<html><head></head></html>');
  // Session users only reach repositories of their teams: alice and bob are members of the repo's.
  await saveTeams(configDir, [{ id: 'cred', name: 'Cred', members: [{ login: '1', role: 'member' }, { login: '2', role: 'member' }], repositories: [repo] }]);
  hub = createHubServer({
    uiDir,
    configDir,
    browseRoot: repo,
    bind: { isLoopback: true, allowAdd: false },
    seedRepoPath: repo,
    deps: deps(),
    adminGithubLogins: ['Root'],
    identity: {
      ...localOnlyIdentity(),
      // Stands in for the Better Auth session: `id:login` signs in as GitHub `login`, `id:gitlab:login`
      // as a GitLab user. Token requests (no header) are the owner.
      sessionUser: async (req) => {
        const raw = req.headers['x-test-user'];
        if (typeof raw !== 'string') return undefined;
        const [id, ...rest] = raw.split(':');
        const login = rest.length > 1 ? rest.join(':') : `github:${rest[0]}`;
        return { id: id!, email: `${id}@example.com`, name: id!, login };
      },
    },
  });
  await hub.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
  repoPath = repo;
});

afterEach(async () => {
  await hub.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

let repoPath: string;

const alice = '1:alice';
const bob = '2:bob';
const root = '99:root';
/** The hub token: the owner user (no GitHub login, so never an admin). */
const OWNER = undefined;
/** No token and no session. */
const ANON = 'anon';

async function rpc(as: string | undefined, cmd: string, args: unknown = {}): Promise<{ status: number; body: { error: { message: string }; result: any } }> {
  const res = await fetch(`${baseUrl}/rpc/${cmd}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      ...(as === undefined ? { [HUB_TOKEN_HEADER]: hub.token } : as === ANON ? {} : { 'x-test-user': as }),
    },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}

const run = (as: string | undefined) => rpc(as, 'api_create_run', { params: { issueRef: '#1', repoPath } });
const setPolicy = (policy: string) => rpc(root, 'set_credential_policy', { policy });

describe('admin gating', () => {
  const adminCalls: [string, unknown][] = [
    ['get_credential_policy', {}],
    ['set_credential_policy', { policy: 'user-only' }],
    ['instance_credentials_status', {}],
    ['save_instance_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_INSTANCE }],
    ['delete_instance_credential', { name: 'ANTHROPIC_API_KEY' }],
  ];

  test.each(adminCalls)('%s is 403 for a non-admin, a GitLab namesake and the token owner; 401 signed out', async (cmd, args) => {
    expect((await rpc(alice, cmd, args)).status).toBe(403);
    expect((await rpc('98:gitlab:root', cmd, args)).status).toBe(403);
    expect((await rpc(OWNER, cmd, args)).status).toBe(403);
    expect((await rpc(ANON, cmd, args)).status).toBe(401);
    expect((await rpc(root, cmd, args)).status).toBe(200);
  });

  test('admin match is by login, case-insensitively', async () => {
    expect((await rpc('5:ROOT', 'get_credential_policy')).status).toBe(200);
  });

  test('the switch defaults to off', async () => {
    expect((await rpc(root, 'get_credential_policy')).body.result).toEqual({ policy: 'off' });
  });
});

describe('run credential choice', () => {
  test('off: the run uses the instance credential and a user save is refused', async () => {
    expect((await rpc(alice, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_A })).status).toBe(400);
    expect((await run(alice)).status).toBe(200);
    expect(createRun.mock.calls[0]![2]!.source).toBe('instance');
  });

  test('user only: a user with no saved credential is refused before claiming, with a message to add one', async () => {
    await setPolicy('user-only');
    const res = await run(alice);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/add one in Settings/);
    expect(createRun).not.toHaveBeenCalled();
    expect((await rpc(alice, 'api_active_run')).body.result).toBeNull();
    expect((await rpc(alice, 'api_queue')).body.result).toEqual([]);
  });

  test('user only: runs with the saved credential, recorded as `user`', async () => {
    await setPolicy('user-only');
    await rpc(alice, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_A });
    expect((await run(alice)).status).toBe(200);
    const cred = createRun.mock.calls[0]![2]!;
    expect(cred.source).toBe('user');
    expect(cred.env).toEqual({ ANTHROPIC_API_KEY: SECRET_A });
  });

  test('user first: falls back to the instance credential', async () => {
    await setPolicy('user-first');
    await rpc(root, 'save_instance_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_INSTANCE });
    expect((await run(alice)).status).toBe(200);
    const cred = createRun.mock.calls[0]![2]!;
    expect(cred.source).toBe('instance');
    expect(cred.env).toEqual({ ANTHROPIC_API_KEY: SECRET_INSTANCE });
  });

  test('the run record notes the kind (run-accepted event), never the value', async () => {
    await setPolicy('user-only');
    await rpc(alice, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_A });
    await run(alice);
    const backlog = (await rpc(OWNER, 'api_run_backlog', { runId: 'run-0' })).body.result as { event: { type: string; credentialSource?: string } }[];
    expect(backlog[0]!.event).toMatchObject({ type: 'run-accepted', credentialSource: 'user' });
    expect(JSON.stringify(backlog)).not.toContain(SECRET_A);
  });
});

describe('user isolation', () => {
  beforeEach(async () => {
    await setPolicy('user-only');
    await rpc(alice, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_A });
  });

  test('status never returns a value, only names, and only the caller\'s own', async () => {
    const a = await rpc(alice, 'user_credentials_status');
    expect(a.body.result).toEqual({ enabled: true, admin: false, names: ['ANTHROPIC_API_KEY'] });
    expect(JSON.stringify(a.body)).not.toContain(SECRET_A);
    expect((await rpc(bob, 'user_credentials_status')).body.result.names).toEqual([]);
  });

  test('a user id in the args is ignored: no RPC can name another user', async () => {
    const res = await rpc(bob, 'user_credentials_status', { userId: '1', user: alice });
    expect(res.body.result.names).toEqual([]);
  });

  test('bob cannot overwrite alice (his save lands in his own scope)', async () => {
    await rpc(bob, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: SECRET_B, userId: '1' });
    await run(alice);
    expect(createRun.mock.calls[0]![2]!.env.ANTHROPIC_API_KEY).toBe(SECRET_A);
    await run(bob);
    expect(createRun.mock.calls[1]![2]!.env.ANTHROPIC_API_KEY).toBe(SECRET_B);
  });

  test('bob cannot delete alice\'s credential', async () => {
    await rpc(bob, 'delete_user_credential', { name: 'ANTHROPIC_API_KEY', userId: '1' });
    expect((await rpc(alice, 'user_credentials_status')).body.result.names).toEqual(['ANTHROPIC_API_KEY']);
  });

  test('bob cannot use alice\'s credential to run', async () => {
    expect((await run(bob)).status).toBe(400);
    expect(createRun).not.toHaveBeenCalled();
  });

  test('nobody signed in cannot save, delete or run', async () => {
    expect((await rpc(ANON, 'save_user_credential', { name: 'ANTHROPIC_API_KEY', value: 'x' })).status).toBe(401);
    expect((await rpc(ANON, 'delete_user_credential', { name: 'ANTHROPIC_API_KEY' })).status).toBe(401);
    expect((await run(ANON)).status).toBe(401);
    expect(createRun).not.toHaveBeenCalled();
  });

  test('values are encrypted at rest', async () => {
    const onDisk = await readFile(join(configDir, 'credentials.enc.json'), 'utf8');
    expect(onDisk).not.toContain(SECRET_A);
  });

  test('only known provider variables are storable', async () => {
    expect((await rpc(alice, 'save_user_credential', { name: 'PATH', value: '/evil' })).status).toBe(400);
  });
});
