import { EventEmitter } from 'node:events';
import { CredentialStore } from './credentials.js';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SpawnRegistry } from './spawn.js';
import { dispatchRpc, classifyError, FLEET_DISABLED_MESSAGE, type RpcContext } from './rpc.js';
import * as clone from './clone.js';
import * as enableFactoryModule from './enable-factory.js';
import * as cliVersions from '../sandbox/cli-versions.js';
import { loadPaths, savePaths } from './projects.js';
import { saveTeams } from './teams.js';
import { ProjectAllowlist } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteRegistry } from './complete.js';
import { writeAppConfig } from './app-config.js';
import { BadRequestError, runSidecar, type SidecarDeps } from '../sidecar/sidecar.js';
import { TaskcellError } from '../core/errors.js';
import type { ChildProcess } from 'node:child_process';
import type { FactoryPlan } from './enable-factory.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  pid = 1;
  kill(): boolean {
    return true;
  }
}

function fakeDeps(overrides: Partial<SidecarDeps> = {}): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: () => ({
      providers: ['claude'],
      flows: [],
      stages: [],
      transports: ['github', 'linear'],
      defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
    }),
    createRun: unimplemented,
    createTask: async (p) => ({ id: 'created', url: 'https://example/created', ...{ _params: p } } as never),
    listFlows: async () => ({ flows: [] }),
    listProviders: async () => ({ providers: [] }),
    readFlow: unimplemented,
    writeFlow: async () => ({ source: '' }),
    deleteFlow: async () => ({}),
    listTasks: async () => ({ tasks: [], capped: false }),
    fetchSpec: async () => ({ spec: '' }),
    listRepoFiles: async () => ({ files: [], capped: false }),
    readRepoFile: async () => ({ path: '', content: '', truncated: false }),
    listRuns: unimplemented,
    readRun: unimplemented,
    ...overrides,
  };
}

const cleanups: string[] = [];

async function makeCtx(
  repoPath: string,
  opts: { depsOverrides?: Partial<SidecarDeps>; bind?: { isLoopback: boolean; allowAdd: boolean }; spawnComplete?: () => ChildProcess } = {},
): Promise<{ ctx: RpcContext; published: { name: string; payload: unknown }[]; deps: SidecarDeps }> {
  const configDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-cfg-'));
  const browseRoot = await mkdtemp(join(tmpdir(), 'vanguard-hub-browse-'));
  cleanups.push(configDir, browseRoot);
  const deps = fakeDeps(opts.depsOverrides);
  const published: { name: string; payload: unknown }[] = [];
  const publish = (name: string, payload: unknown): void => {
    published.push({ name, payload });
  };
  const ctx: RpcContext = {
    credentials: new CredentialStore(configDir, undefined, {}),
    allowlist: new ProjectAllowlist(async () => [], repoPath),
    watchRegistry: new WatchRegistry(),
    runSession: createRunSession(deps, publish),
    completeRegistry: new CompleteRegistry(opts.spawnComplete ?? (() => new FakeChild() as unknown as ChildProcess)),
    deps,
    configDir,
    browseRoot,
    bind: opts.bind ?? { isLoopback: true, allowAdd: false },
    publish,
  };
  return { ctx, published, deps };
}

async function tmpRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-repo-'));
  cleanups.push(repo);
  // realpath so assertions built on this path match the allowlist's realpath'd comparisons, even
  // on platforms (e.g. macOS) where the OS temp dir is itself a symlink.
  return realpath(repo);
}

/** A tmpRepo that is a real git repo, optionally with an `origin` the repo slug is detected from. */
async function tmpGitRepo(originUrl?: string): Promise<string> {
  const repo = await tmpRepo();
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  if (originUrl !== undefined) await execa('git', ['remote', 'add', 'origin', originUrl], { cwd: repo });
  return repo;
}

afterEach(() => {
  cleanups.length = 0;
});

describe('dispatchRpc teams', () => {
  test('list_teams / get_team return the default team and track project changes', async () => {
    const repo = await tmpGitRepo();
    const { ctx } = await makeCtx(repo);
    await savePaths(ctx.configDir, [repo]);
    const teams = (await dispatchRpc(ctx, 'list_teams', {})) as { id: string; repositories: string[] }[];
    expect(teams).toHaveLength(1);
    expect(teams[0]!.repositories).toEqual([repo]);
    await dispatchRpc(ctx, 'remove_project', { path: repo });
    expect(await dispatchRpc(ctx, 'get_team', { id: teams[0]!.id })).toMatchObject({ repositories: [] });
    expect(await dispatchRpc(ctx, 'get_team', { id: 'nope' })).toBeNull();
  });
});

describe('dispatchRpc', () => {
  test('T-54 dispatches commands with their exact camelCase args to the right handler', async () => {
    const repo = await tmpRepo();
    let seenCapabilities = false;
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        capabilities: () => {
          seenCapabilities = true;
          return { providers: [], flows: [], stages: [], transports: [], defaults: { provider: 'claude', maxTurns: 1, maxCostUsd: 1, baseBranch: 'main' } };
        },
        listFlows: async (p) => {
          expect(p.repoPath).toBe(await ctx.allowlist.assertAllowed(repo));
          return { flows: [] };
        },
      },
    });
    await dispatchRpc(ctx, 'api_capabilities', {});
    expect(seenCapabilities).toBe(true);
    await dispatchRpc(ctx, 'api_list_flows', { repoPath: repo });
    const runs = await dispatchRpc(ctx, 'list_runs', { repoPath: repo });
    expect(runs).toEqual([]);
  });

  test('agent_cli_versions reports a disabled check without any lookup when the switch is off', async () => {
    vi.stubEnv('VANGUARD_CLI_VERSION_CHECK', 'off');
    try {
      const { ctx } = await makeCtx(await tmpRepo());
      expect(await dispatchRpc(ctx, 'agent_cli_versions', {})).toEqual({ enabled: false, clis: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('agent_cli_versions returns the version report for the hub config dir', async () => {
    const { ctx } = await makeCtx(await tmpRepo());
    const report = { enabled: true, clis: [{ name: 'claude' as const, installed: '1.0.0', changelog: 'https://c', outdated: false, updatable: false }] };
    const mock = vi.spyOn(cliVersions, 'checkCliVersions').mockResolvedValue(report);
    try {
      expect(await dispatchRpc(ctx, 'agent_cli_versions', {})).toEqual(report);
      expect(mock).toHaveBeenCalledWith({ cwd: ctx.configDir });
    } finally {
      mock.mockRestore();
    }
  });

  test('agent_cli_versions is refused on a non-loopback bind without the opt-in', async () => {
    const { ctx } = await makeCtx(await tmpRepo(), { bind: { isLoopback: false, allowAdd: false } });
    const mock = vi.spyOn(cliVersions, 'checkCliVersions');
    try {
      await expect(dispatchRpc(ctx, 'agent_cli_versions', {})).rejects.toThrow('disabled on a non-loopback bind');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });

  test('T-55 unknown command classifies as a 404-flavored bad-request', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await expect(dispatchRpc(ctx, 'totally_bogus', {})).rejects.toThrow(/unknown command/);
    try {
      await dispatchRpc(ctx, 'totally_bogus', {});
      expect.unreachable();
    } catch (e) {
      const classified = classifyError(e);
      expect(classified.kind).toBe('bad-request');
      expect(classified.notFound).toBe(true);
    }
  });

  test('T-56 BadRequestError classifies bad-request, other throws classify internal', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    try {
      await dispatchRpc(ctx, 'list_runs', { repoPath: '/not/allowed' });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('bad-request');
    }

    const { ctx: ctx2 } = await makeCtx(repo, {
      depsOverrides: {
        listFlows: async () => {
          throw new Error('fault');
        },
      },
    });
    try {
      await dispatchRpc(ctx2, 'api_list_flows', { repoPath: repo });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('internal');
    }
  });

  test('T-57 void commands return null, never undefined', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await writeAppConfig(repo, {});
    const result = await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'x' } });
    expect(result).toBeNull();
    const cancelResult = await dispatchRpc(ctx, 'api_cancel', { runId: 'run-unknown' });
    expect(cancelResult).toBeNull();
  });

  test('api_cancel requires a runId instead of falling back to the active run', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    for (const args of [{}, { runId: 123 }, { runId: null }, { runId: '  ' }]) {
      await expect(dispatchRpc(ctx, 'api_cancel', args)).rejects.toThrow(/runId is required/);
    }
  });

  test('api_queue returns the session queue', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    expect(await dispatchRpc(ctx, 'api_queue', {})).toEqual([]);
  });

  test('T-58 Fleet commands are refused unless the hub enabled fleet', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    for (const cmd of ['spawn_run', 'kill_run', 'list_spawns']) {
      await expect(dispatchRpc(ctx, cmd, {})).rejects.toThrow(FLEET_DISABLED_MESSAGE);
    }
  });

  test('Fleet commands spawn, list and report exit when fleet is enabled, and respect the allowlist', async () => {
    const repo = await tmpRepo();
    const { ctx, published } = await makeCtx(repo);
    ctx.spawnRegistry = new SpawnRegistry(ctx.publish);
    const pid = (await dispatchRpc(ctx, 'spawn_run', { cwd: repo, argv: [process.execPath, '-e', 'console.log("hi")'] })) as number;
    expect(typeof pid).toBe('number');
    await vi.waitFor(() => expect(published.some((e) => e.name === 'spawn:exit')).toBe(true));
    expect(published).toContainEqual({ name: 'spawn:output', payload: { pid, line: 'hi' } });
    expect(published).toContainEqual({ name: 'spawn:exit', payload: { pid, code: 0 } });
    expect(await dispatchRpc(ctx, 'list_spawns', {})).toEqual([]);
    await expect(dispatchRpc(ctx, 'spawn_run', { cwd: tmpdir(), argv: ['true'] })).rejects.toThrow();
    await expect(dispatchRpc(ctx, 'spawn_run', { cwd: repo, argv: [] })).rejects.toThrow(/argv/);
  });

  test('T-59 a repoPath outside the allowlist is refused for every path-taking command', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const outside = await mkdtemp(join(tmpdir(), 'vanguard-hub-outside-'));
    cleanups.push(outside);
    const cases: [string, Record<string, unknown>][] = [
      ['list_runs', { repoPath: outside }],
      ['list_active', { repoPath: outside }],
      ['read_app_config', { repoPath: outside }],
      ['list_drafts', { repoPath: outside }],
      ['list_remote_runs', { repoPath: outside }],
      ['list_tasks', { repoPath: outside }],
      ['api_list_flows', { repoPath: outside }],
      ['api_repo_ok', { repoPath: outside }],
      ['watch_project', { repoPath: outside }],
    ];
    for (const [cmd, args] of cases) {
      if (cmd === 'api_repo_ok') {
        await expect(dispatchRpc(ctx, cmd, args)).resolves.toBe(false);
        continue;
      }
      await expect(dispatchRpc(ctx, cmd, args)).rejects.toThrow(/not an allowed project/);
    }
  });

  test('T-60 api_create_task substitutes source/team/label from app.json and ignores client values', async () => {
    const repo = await tmpRepo();
    let captured: unknown;
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        createTask: async (p) => {
          captured = p;
          return { id: 'x', url: 'https://x' };
        },
      },
    });
    await writeAppConfig(repo, { source: 'linear', team: 'DEV', label: 'vanguard-ready' });
    await dispatchRpc(ctx, 'api_create_task', {
      repoPath: repo,
      title: 'hello',
      body: 'world',
      // A client-supplied source/team/label must be ignored entirely (not even read).
      source: 'github',
      team: 'ATTACKER',
      label: 'nope',
    });
    expect(captured).toMatchObject({ source: 'linear', team: 'DEV', labels: ['vanguard-ready'], title: 'hello', body: 'world' });
  });

  describe('target branch', () => {
    async function createWith(cfg: Record<string, string>, extra: Record<string, unknown>): Promise<{ captured: unknown; call: Promise<unknown> }> {
      const repo = await tmpRepo();
      const out: { captured: unknown } = { captured: undefined };
      const { ctx } = await makeCtx(repo, {
        depsOverrides: {
          createTask: async (p) => {
            out.captured = p;
            return { id: 'x', url: 'https://x' };
          },
        },
      });
      await writeAppConfig(repo, cfg);
      return Object.assign(out, { call: dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b', ...extra }) });
    }

    test('api_create_task carries baseBranch as a vanguard:base= label next to the trigger label', async () => {
      const r = await createWith({ label: 'ready', baseBranch: 'dev' }, { baseBranch: ' dev ' });
      await r.call;
      expect(r.captured).toMatchObject({ labels: ['ready', 'vanguard:base=dev'] });
    });

    test('api_create_task adds no base label when baseBranch is absent or blank', async () => {
      const a = await createWith({ label: 'ready' }, {});
      await a.call;
      expect(a.captured).toMatchObject({ labels: ['ready'] });
      const b = await createWith({}, { baseBranch: '  ' });
      await b.call;
      expect((b.captured as { labels?: string[] }).labels).toBeUndefined();
    });

    test.each([
      ['an unsafe name', { baseBranch: '--upload-pack=x' }, /Invalid base branch/],
      ['a name too long for a GitHub label', { baseBranch: 'x'.repeat(40) }, /cannot be carried as a label/],
      ['a name with a comma (GitLab label list)', { baseBranch: 'a,b' }, /cannot be carried as a label/],
    ])('api_create_task refuses %s before anything is created', async (_n, extra, message) => {
      const r = await createWith({}, extra);
      await expect(r.call).rejects.toThrow(message);
      expect(r.captured).toBeUndefined();
    });

    test('api_create_task refuses a target branch outside the committed allowlist', async () => {
      const r = await createWith({}, { baseBranch: 'uat' });
      await expect(r.call).rejects.toThrow(/is not allowed/);
      expect(r.captured).toBeUndefined();
    });

    test('api_create_task refuses a target branch on a Linear card', async () => {
      const r = await createWith({ source: 'linear', team: 'DEV' }, { baseBranch: 'dev' });
      await expect(r.call).rejects.toThrow(/Linear/);
      expect(r.captured).toBeUndefined();
    });

    test('write_app_config refuses an unsafe baseBranch and saves a safe one', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranch: 'a:b' } })).rejects.toThrow(/Invalid base branch/);
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranch: 'dev' } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ baseBranch: 'dev' });
    });

    test('write_app_config refuses an unsafe baseBranches entry', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranches: ['uat', '-x'] } })).rejects.toThrow(/Invalid base branch/);
      await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { baseBranches: ['uat'] } });
      expect(await dispatchRpc(ctx, 'read_app_config', { repoPath: repo })).toMatchObject({ baseBranches: ['uat'] });
    });

    test('list_branches offers only the allowlisted targets plus the configured default', async () => {
      const repo = await tmpRepo();
      const { ctx } = await makeCtx(repo);
      expect(await dispatchRpc(ctx, 'list_branches', { repoPath: repo })).toEqual({ branches: ['main'] });
      await writeAppConfig(repo, { baseBranch: 'dev', baseBranches: ['uat', 'main'] });
      expect(await dispatchRpc(ctx, 'list_branches', { repoPath: repo })).toEqual({ branches: ['dev', 'main', 'uat'], default: 'dev' });
    });
  });

  test('api_create_task requires a Linear team key when source is linear and none is configured', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await writeAppConfig(repo, { source: 'linear' });
    await expect(dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' })).rejects.toThrow(/Linear team/);
  });

  test('T-61 api_complete strips a client baseUrl, substitutes chatBaseUrl, and forces assetRoot', async () => {
    const repo = await tmpRepo();
    await writeAppConfig(repo, { chatBaseUrl: 'https://proxy.internal' });
    const fake = new FakeChild();
    let sent = '';
    fake.stdin.on('data', (c: Buffer) => {
      sent += c.toString('utf8');
    });
    const { ctx } = await makeCtx(repo, { spawnComplete: () => fake as unknown as ChildProcess });
    const promise = dispatchRpc(ctx, 'api_complete', {
      repoPath: repo,
      req: { messages: [], model: 'm', baseUrl: 'https://attacker.example', assetRoot: '/' },
    });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const payload = JSON.parse(sent.trim()) as Record<string, unknown>;
    expect(payload.baseUrl).toBe('https://proxy.internal');
    expect(payload.assetRoot).toBe(join(repo, '.taskcell', 'drafts'));
  });

  test('T-62 api_complete forwards only the CompleteParams allowlist fields', async () => {
    const repo = await tmpRepo();
    const fake = new FakeChild();
    let sent = '';
    fake.stdin.on('data', (c: Buffer) => {
      sent += c.toString('utf8');
    });
    const { ctx } = await makeCtx(repo, { spawnComplete: () => fake as unknown as ChildProcess });
    const promise = dispatchRpc(ctx, 'api_complete', {
      repoPath: repo,
      req: { messages: [{ role: 'user', content: 'hi' }], model: 'm', system: 's', attachments: ['a'], evilExtra: 'drop me' },
    });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const payload = JSON.parse(sent.trim()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('evilExtra');
    expect(payload.system).toBe('s');
    expect(payload.attachments).toEqual(['a']);
  });

  test('api_create_task rejects an invalid configured source as bad-request (#493)', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    // app.json can hold any string (no enum at that boundary) — a stale/hand-edited value must still
    // be caught by createTask's own validator, not silently forwarded to the transport.
    await writeAppConfig(repo, { source: 'not-a-real-tracker' });
    try {
      await dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('bad-request');
    }
  });

  test('BadRequestError, TaskcellError and a generic Error classify identically on the sidecar and hub paths', async () => {
    const repo = await tmpRepo();
    async function* lines(...ls: string[]): AsyncIterable<string> {
      for (const l of ls) yield l;
    }
    const cases = [new BadRequestError('bad request'), new TaskcellError('vanguard failure'), new Error('generic failure')];
    for (const err of cases) {
      const out: string[] = [];
      await runSidecar(
        lines(JSON.stringify({ id: 'x', method: 'listFlows', params: { repoPath: '/abs' } })),
        (l) => out.push(l),
        fakeDeps({
          listFlows: async () => {
            throw err;
          },
        }),
      );
      const sidecarKind = (JSON.parse(out[0]!) as { error: { kind: string } }).error.kind;

      const { ctx } = await makeCtx(repo, {
        depsOverrides: {
          listFlows: async () => {
            throw err;
          },
        },
      });
      let hubKind: string | undefined;
      try {
        await dispatchRpc(ctx, 'api_list_flows', { repoPath: repo });
        expect.unreachable();
      } catch (e) {
        hubKind = classifyError(e).kind;
      }
      expect(hubKind).toBe(sidecarKind);
    }
  });
});


test('clone_project registers the clone, returns its summary and publishes progress', async () => {
  const { ctx, published } = await makeCtx(await tmpRepo());
  const target = join(ctx.browseRoot, 'repo');
  await mkdir(join(target, '.git'), { recursive: true });
  const mock = vi.spyOn(clone, 'cloneProject').mockImplementation(async (_root, _params, deps) => {
    deps?.onProgress?.('receiving objects');
    return target;
  });
  try {
    ctx.cloneHosts = ['internal.example'];
    const result = await dispatchRpc(ctx, 'clone_project', { url: 'https://internal.example/org/repo.git', parentDir: ctx.browseRoot });
    expect(result).toMatchObject({ path: target, name: 'repo' });
    expect(await loadPaths(ctx.configDir)).toEqual([target]);
    expect(published).toContainEqual({ name: 'vanguard:clone-progress', payload: { line: 'receiving objects' } });
    expect(mock).toHaveBeenCalledWith(ctx.browseRoot, expect.anything(), expect.objectContaining({ allowedHosts: ctx.cloneHosts }));
  } finally {
    mock.mockRestore();
  }
});

test('clone_project enforces mutation permissions before cloning', async () => {
  const { ctx } = await makeCtx(await tmpRepo(), { bind: { isLoopback: false, allowAdd: false } });
  const mock = vi.spyOn(clone, 'cloneProject');
  try {
    await expect(dispatchRpc(ctx, 'clone_project', { url: 'https://github.com/org/repo.git', parentDir: ctx.browseRoot }))
      .rejects.toThrow('disabled on a non-loopback bind');
    expect(mock).not.toHaveBeenCalled();
    expect(await loadPaths(ctx.configDir)).toEqual([]);
  } finally {
    mock.mockRestore();
  }
});

test('reply_needs_you takes the repo from the allowlisted path, never from the id', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  // An id naming an unregistered repo is refused: it must never become the `--repo` a reply
  // comments on and relabels.
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'other/repo#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('other/repo#1 is not an item of allowed/repo');
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'other/repo#1', kind: 'nope', body: 'hi' }))
    .rejects.toThrow("kind must be 'issue' or 'pr'");
});

test('reply_needs_you enforces mutation permissions before touching GitHub', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'allowed/repo#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('disabled on a non-loopback bind');
});

test('merge_needs_you is refused when mutations are not allowed', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
  await expect(dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'allowed/repo#1' }))
    .rejects.toThrow('disabled on a non-loopback bind');
});

test('merge_needs_you refuses an id naming another repo', async () => {
  const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
  const { ctx } = await makeCtx(repo);
  await expect(dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'other/repo#1' }))
    .rejects.toThrow('other/repo#1 is not an item of allowed/repo');
});

test('list_needs_you is empty on a project with no GitHub remote', async () => {
  const repo = await tmpRepo();
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const { ctx } = await makeCtx(repo);
  expect(await dispatchRpc(ctx, 'list_needs_you', { repoPath: repo })).toEqual({ items: [] });
  await expect(dispatchRpc(ctx, 'reply_needs_you', { repoPath: repo, id: 'o/r#1', kind: 'issue', body: 'hi' }))
    .rejects.toThrow('no GitHub remote');
  await expect(dispatchRpc(ctx, 'merge_needs_you', { repoPath: repo, id: 'o/r#1' })).rejects.toThrow('no GitHub remote');
});

describe('enable_factory RPCs', () => {
  const validPlan = {
    provider: 'github',
    repoSlug: 'acme/widgets',
    defaultBranch: 'main',
    login: 'octocat',
    packageManager: 'pnpm',
    scripts: { typecheck: true, lint: true, test: true, build: true },
  };

  function spyProvider(): { seen: FactoryPlan[]; mock: ReturnType<typeof vi.spyOn> } {
    const seen: FactoryPlan[] = [];
    const mock = vi.spyOn(enableFactoryModule, 'enableFactory').mockImplementation(() => ({
      plan: async () => ({ ...validPlan, ...enableFactoryModule.factoryPlanTargets() }) as FactoryPlan,
      apply: async (plan) => {
        seen.push(plan);
        return { branch: 'vanguard/enable-factory', prUrl: 'https://example/pr/1', labelsCreated: [] };
      },
      secretCommand: (plan) => {
        seen.push(plan);
        return enableFactoryModule.githubSecretCommand(plan);
      },
      verify: async (plan) => {
        seen.push(plan);
        return { dispatched: true };
      },
    }));
    return { seen, mock };
  }

  test.each([
    ['login', "octocat'\n    evil: true"],
    ['login', '-octocat'],
    ['login', 'a'.repeat(40)],
    ['repoSlug', 'acme/widgets; rm -rf ~'],
    ['repoSlug', 'acme'],
    ['defaultBranch', '--upload-pack=evil'],
    ['packageManager', 'bun'],
    ['scripts', { typecheck: 'yes' }],
  ] as [string, unknown][])('rejects a plan whose %s is not a valid shape (%s)', async (field, value) => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_secret', { repoPath: repo, plan: { ...validPlan, [field]: value } }))
        .rejects.toThrow(BadRequestError);
      expect(seen).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test('discards client-supplied callerFiles and labels', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_apply', {
        repoPath: repo,
        plan: { ...validPlan, callerFiles: ['../../etc/passwd', '.'], labels: ['evil'] },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.callerFiles).toEqual(enableFactoryModule.factoryPlanTargets().callerFiles);
      expect(seen[0]?.labels).toEqual(enableFactoryModule.factoryPlanTargets().labels);
    } finally {
      mock.mockRestore();
    }
  });

  test('accepts an Enterprise Managed User login (underscore)', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_secret', { repoPath: repo, plan: { ...validPlan, login: 'octo_corp' } });
      expect(seen[0]?.login).toBe('octo_corp');
    } finally {
      mock.mockRestore();
    }
  });

  test.each([
    ['login', 'mallory'],
    ['repoSlug', 'acme/other'],
    ['defaultBranch', 'develop'],
  ])('apply refuses a client plan whose %s differs from the server-side plan', async (field, value) => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: { ...validPlan, [field]: value } }))
        .rejects.toThrow('the plan no longer matches');
      expect(seen).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test('apply uses the server-side plan, not the client echo', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: { ...validPlan, packageManager: 'npm' } });
      expect(seen[0]?.packageManager).toBe('pnpm');
    } finally {
      mock.mockRestore();
    }
  });

  test('requires the plan provider to be github', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const { seen, mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, 'enable_factory_apply', { repoPath: repo, plan: { ...validPlan, provider: 'gitlab' } }))
        .rejects.toThrow('plan.provider must be github');
      expect(seen).toEqual([]);
    } finally {
      mock.mockRestore();
    }
  });

  test.each(['enable_factory_apply', 'enable_factory_verify'])('%s enforces mutation permissions', async (cmd) => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
    const { mock } = spyProvider();
    try {
      await expect(dispatchRpc(ctx, cmd, { repoPath: repo, plan: validPlan })).rejects.toThrow('disabled on a non-loopback bind');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });
});

test('add_project is confined to the browse root, like browse_dirs', async () => {
  const outsideRepo = await tmpRepo();
  await mkdir(join(outsideRepo, '.git'));
  const { ctx } = await makeCtx(outsideRepo);
  await expect(dispatchRpc(ctx, 'add_project', { path: outsideRepo })).rejects.toThrow('path escapes the browse root');
  expect(await loadPaths(ctx.configDir)).toEqual([]);

  const inside = join(await realpath(ctx.browseRoot), 'repo');
  await mkdir(join(inside, '.git'), { recursive: true });
  // An unresolved spelling (`..`, a symlinked temp dir) is stored as its realpath.
  await dispatchRpc(ctx, 'add_project', { path: `${ctx.browseRoot}/repo/../repo` });
  expect(await loadPaths(ctx.configDir)).toEqual([inside]);
});

describe('all-repositories lists', () => {
  async function twoRepoCtx(listTasks: SidecarDeps['listTasks']): Promise<{ ctx: RpcContext; a: string; b: string }> {
    const a = await tmpRepo();
    const b = await tmpRepo();
    const { ctx } = await makeCtx(a, { depsOverrides: { listTasks } });
    await savePaths(ctx.configDir, [a, b]);
    ctx.allowlist = new ProjectAllowlist(() => loadPaths(ctx.configDir), a);
    return { ctx, a, b };
  }
  const task = (id: string): { id: string; title: string; column: 'queued'; state: string } => ({ id, title: id, column: 'queued', state: 'queued' });
  const noTasks: SidecarDeps['listTasks'] = async () => ({ tasks: [], capped: false });

  test('list_tasks_all stamps every card with its repository', async () => {
    const { ctx, a, b } = await twoRepoCtx(async (p) => ({ tasks: [task(p.repoPath.includes('x') ? 'x' : 't')], capped: false }));
    const out = (await dispatchRpc(ctx, 'list_tasks_all', {})) as { tasks: { repoPath: string; repoName: string }[]; failures: unknown[] };
    expect(out.failures).toEqual([]);
    expect(out.tasks.map((t) => t.repoPath).sort()).toEqual([a, b].sort());
    expect(out.tasks.every((t) => t.repoName.length > 0)).toBe(true);
  });

  test('list_tasks_all returns the other repositories and names the failing one', async () => {
    const { ctx, a, b } = await twoRepoCtx(async (p) => {
      if (p.repoPath === b) throw new Error('tracker down');
      return { tasks: [task('ok')], capped: true };
    });
    const out = (await dispatchRpc(ctx, 'list_tasks_all', {})) as { tasks: { repoPath: string }[]; capped: boolean; failures: { repoPath: string; error: string }[] };
    expect(out.tasks.map((t) => t.repoPath)).toEqual([a]);
    expect(out.capped).toBe(true);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ repoPath: b, error: 'tracker down' });
  });

  const writeRun = async (repo: string, taskId: string, timestamp: string): Promise<void> => {
    const dir = join(repo, '.taskcell', 'runs', taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${timestamp.replace(/[:.]/g, '-')}-implement.json`),
      JSON.stringify({ taskId, completed: true, exitReason: 'completed', turns: 1, worktreePath: '/tmp/wt', worktreePreserved: false, finalText: 'ok', costUsd: 0.1, timestamp, stage: 'implement' }),
    );
  };

  test('list_runs_all stamps each run with its repository', async () => {
    const a = await tmpRepo();
    const { ctx } = await makeCtx(a);
    await savePaths(ctx.configDir, [a]);
    ctx.allowlist = new ProjectAllowlist(() => loadPaths(ctx.configDir), a);
    await writeRun(a, 'task-1', '2026-07-06T19:12:02.123Z');
    const out = (await dispatchRpc(ctx, 'list_runs_all', {})) as { runs: { taskId: string; repoPath: string; repoName: string }[] };
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({ taskId: 'task-1', repoPath: a });
    expect(out.runs[0]?.repoName.length).toBeGreaterThan(0);
  });

  test('list_runs_all lists every repository newest-first', async () => {
    const { ctx, a, b } = await twoRepoCtx(noTasks);
    await writeRun(a, 'old-a', '2026-07-01T10:00:00.000Z');
    await writeRun(b, 'mid-b', '2026-07-02T10:00:00.000Z');
    await writeRun(a, 'new-a', '2026-07-03T10:00:00.000Z');
    const out = (await dispatchRpc(ctx, 'list_runs_all', {})) as { runs: { taskId: string; repoPath: string }[] };
    expect(out.runs.map((r) => [r.taskId, r.repoPath])).toEqual([
      ['new-a', a],
      ['mid-b', b],
      ['old-a', a],
    ]);
  });

  test('list_runs_all isolates a repository outside the allowlist', async () => {
    const a = await tmpRepo();
    const { ctx } = await makeCtx(a);
    await savePaths(ctx.configDir, [a, '/not/allowed/anywhere']);
    const out = (await dispatchRpc(ctx, 'list_runs_all', {})) as { runs: unknown[]; failures: { repoPath: string }[] };
    expect(out.runs).toEqual([]);
    expect(out.failures.map((f) => f.repoPath)).toEqual(['/not/allowed/anywhere']);
  });

  test('list_needs_you_all is empty for repositories without a GitHub remote', async () => {
    const { ctx } = await twoRepoCtx(noTasks);
    expect(await dispatchRpc(ctx, 'list_needs_you_all', {})).toEqual({ items: [], failures: [] });
  });
});

describe('start_task', () => {
  const call = (ctx: RpcContext, repo: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    dispatchRpc(ctx, 'start_task', { repoPath: repo, number: 1, label: 'ready for agent', ...extra });

  test('refuses on a non-loopback bind without mutations allowed', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
    await expect(call(ctx, repo)).rejects.toThrow('disabled on a non-loopback bind');
  });

  test.each(['gitlab', 'linear'])('says %s is not supported yet', async (source) => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    await writeAppConfig(repo, { source });
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo)).rejects.toThrow(`start_task: ${source} is not supported yet`);
  });

  test('refuses a project with no GitHub remote', async () => {
    const repo = await tmpRepo();
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo)).rejects.toThrow('no GitHub remote');
  });

  test('requires a numeric issue number', async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo, { number: '1' })).rejects.toThrow('number is required and must be a number');
  });

  test("offers the project's configured trigger label alongside the defaults", async () => {
    const repo = await tmpGitRepo('https://github.com/allowed/repo.git');
    await writeAppConfig(repo, { label: 'go' });
    const { ctx } = await makeCtx(repo);
    await expect(call(ctx, repo, { label: 'bug' })).rejects.toThrow('"bug" is not a trigger label of this project (ready for agent, ready for spec, go)');
  });
});

describe('dispatchRpc team edits', () => {
  const owner = { user: { id: 'o', email: 'owner@hub.invalid', name: 'Owner' }, owner: true };
  const bob = { user: { id: 'b', email: 'bob@x.io', name: 'Bob', providerLogin: 'github:bob' }, owner: false };
  const ann = { user: { id: 'a', email: 'ann@x.io', name: 'Ann', providerLogin: 'github:ann' }, owner: false };
  // Same display name, e-mail local part and id shape as the admin, but a different provider login.
  const impostor = { user: { id: 'x', email: 'ann@evil.io', name: 'ann', providerLogin: 'github:mallory' }, owner: false };

  test('only an admin edits; a member and a stranger are refused; the last admin stays', async () => {
    const repo = await tmpGitRepo();
    const { ctx } = await makeCtx(repo);
    await savePaths(ctx.configDir, [repo]);
    await saveTeams(ctx.configDir, [
      { id: 't', name: 'T', members: [{ login: 'ann', role: 'admin' }, { login: 'bob', role: 'member' }], repositories: [] },
    ]);
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, bob)).toBe('member');
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, ann)).toBe('admin');
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, owner)).toBe('admin');
    await expect(dispatchRpc(ctx, 'team_add_member', { teamId: 't', login: 'cy', role: 'member' }, bob)).rejects.toThrow(/only a team admin/);
    // A display name or e-mail equal to the admin's login grants nothing.
    expect(await dispatchRpc(ctx, 'team_role', { id: 't' }, impostor)).toBeNull();
    await expect(dispatchRpc(ctx, 'team_add_member', { teamId: 't', login: 'mallory', role: 'admin' }, impostor)).rejects.toThrow(/only a team admin/);
    await expect(dispatchRpc(ctx, 'team_add_repository', { teamId: 't', path: '/nope' }, impostor)).rejects.toThrow(/only a team admin/);
    const t = (await dispatchRpc(ctx, 'team_add_member', { teamId: 't', login: 'cy', role: 'member' }, ann)) as { members: unknown[] };
    expect(t.members).toHaveLength(3);
    await expect(dispatchRpc(ctx, 'team_remove_member', { teamId: 't', login: 'ann' }, ann)).rejects.toThrow(/last admin/);
    await expect(dispatchRpc(ctx, 'team_set_role', { teamId: 't', login: 'ann', role: 'member' }, ann)).rejects.toThrow(/last admin/);
    const r = (await dispatchRpc(ctx, 'team_add_repository', { teamId: 't', path: repo }, ann)) as { repositories: string[] };
    expect(r.repositories).toEqual([repo]);
    await expect(dispatchRpc(ctx, 'team_add_repository', { teamId: 't', path: '/nope' }, ann)).rejects.toThrow(/not a hub project/);
    expect(((await dispatchRpc(ctx, 'team_remove_repository', { teamId: 't', path: repo }, ann)) as { repositories: string[] }).repositories).toEqual([]);
  });

  test('a non-owner sees only their teams and their teams\' repositories; the owner sees all', async () => {
    const a = await tmpGitRepo();
    const b = await tmpGitRepo();
    const { ctx } = await makeCtx(a);
    await savePaths(ctx.configDir, [a, b]);
    await saveTeams(ctx.configDir, [
      { id: 'one', name: 'One', members: [{ login: 'ann', role: 'admin' }], repositories: [a] },
      { id: 'two', name: 'Two', members: [{ login: 'bob', role: 'admin' }], repositories: [b] },
    ]);
    const ids = async (c: typeof ann | typeof owner): Promise<string[]> =>
      ((await dispatchRpc(ctx, 'list_teams', {}, c)) as { id: string }[]).map((t) => t.id);
    expect(await ids(ann)).toEqual(['one']);
    expect(await ids(owner)).toEqual(['one', 'two']);
    expect(await dispatchRpc(ctx, 'get_team', { id: 'two' }, ann)).toBeNull();
    const runs = (await dispatchRpc(ctx, 'list_runs_all', {}, ann)) as { failures: { repoPath: string }[]; runs: unknown[] };
    expect(runs.failures.every((f) => f.repoPath === a)).toBe(true);
    const tasks = (await dispatchRpc(ctx, 'list_tasks_all', {}, ann)) as { failures: { repoPath: string }[] };
    expect(tasks.failures.every((f) => f.repoPath === a)).toBe(true);
  });
});
