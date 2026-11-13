// Shared fixtures for the hub RPC tests (rpc.test.ts and src/hub/commands/*.test.ts).
import { dispatchRpc as dispatch, type RpcContext } from './rpc.js';
import type { Caller } from './teams.js';
import { EventEmitter } from 'node:events';

import { CredentialStore } from './credentials.js';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import { afterEach } from 'vitest';

import { ProjectAllowlist } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteRegistry } from './complete.js';
import { type SidecarDeps } from '../sidecar/sidecar.js';
import type { ChildProcess } from 'node:child_process';

export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  pid = 1;
  kill(): boolean {
    return true;
  }
}

export function fakeDeps(overrides: Partial<SidecarDeps> = {}): SidecarDeps {
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

export const OWNER: Caller = { user: { id: 'local-owner', email: 'owner@hub.invalid', name: 'Owner' }, owner: true };
export const dispatchRpc = (ctx: RpcContext, cmd: string, args: unknown, caller: Caller = OWNER): Promise<unknown> => dispatch(ctx, cmd, args, caller);

export const cleanups: string[] = [];

export async function makeCtx(
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

export async function tmpRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-repo-'));
  cleanups.push(repo);
  // realpath so assertions built on this path match the allowlist's realpath'd comparisons, even
  // on platforms (e.g. macOS) where the OS temp dir is itself a symlink.
  return realpath(repo);
}

/** A tmpRepo that is a real git repo, optionally with an `origin` the repo slug is detected from. */
export async function tmpGitRepo(originUrl?: string): Promise<string> {
  const repo = await tmpRepo();
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  if (originUrl !== undefined) await execa('git', ['remote', 'add', 'origin', originUrl], { cwd: repo });
  return repo;
}

afterEach(() => {
  cleanups.length = 0;
});
