import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AuditLog, safeUrl } from './audit.js';
import { dispatchRpc as dispatch, ForbiddenError, type RpcContext } from './rpc.js';
import { ProjectAllowlist } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteRegistry } from './complete.js';
import { CredentialStore } from './credentials.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';
import type { Caller } from './teams.js';

const OWNER: Caller = { user: { id: 'local-owner', email: 'owner@hub.invalid', name: 'Owner' }, owner: true };
const dispatchRpc = (ctx: RpcContext, cmd: string, args: unknown, caller: Caller = OWNER): Promise<unknown> => dispatch(ctx, cmd, args, caller);

const CANARY = 'CANARY-credential-value-123';

async function setup(actor?: { login: string; admin: boolean }, createRun?: SidecarDeps['createRun']) {
  const configDir = await mkdtemp(join(tmpdir(), 'vg-audit-'));
  const repo = await mkdtemp(join(tmpdir(), 'vg-audit-repo-'));
  const deps = { createRun: createRun ?? (async () => ({})) } as unknown as SidecarDeps;
  const audit = new AuditLog(configDir);
  const ctx: RpcContext = {
    credentials: new CredentialStore(configDir, undefined, {}),
    allowlist: new ProjectAllowlist(async () => [], repo),
    watchRegistry: new WatchRegistry(),
    runSession: createRunSession(deps, () => undefined),
    completeRegistry: new CompleteRegistry(),
    deps,
    configDir,
    browseRoot: configDir,
    bind: { isLoopback: true, allowAdd: false },
    publish: () => undefined,
    audit,
    ...(actor !== undefined ? { actor } : {}),
  };
  return { ctx, audit, configDir, repo };
}

const lines = async (dir: string): Promise<string[]> => (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n');

describe('audit log', () => {
  test('one line per audited action, refused and failed included, with no credential values', async () => {
    const { ctx, configDir, repo } = await setup({ login: 'alice', admin: true });
    const url = `https://user:${CANARY}@host.example/org/repo.git?x=${CANARY}`;
    await expect(dispatchRpc(ctx, 'add_project', { path: repo })).rejects.toThrow(); // refused: mutations off
    await expect(dispatchRpc(ctx, 'clone_project', { url, parentDir: configDir })).rejects.toThrow();
    await dispatchRpc(ctx, 'remove_project', { path: repo });
    await expect(dispatchRpc(ctx, 'write_app_config', { repoPath: '/not/allowed', config: { token: CANARY, label: 'x' } })).rejects.toThrow();
    await dispatchRpc(ctx, 'api_cancel', { runId: 'run-9' });
    await expect(dispatchRpc(ctx, 'start_task', { repoPath: repo, label: 'l', number: 1, token: CANARY })).rejects.toThrow();
    await expect(dispatchRpc(ctx, 'api_create_run', { params: { repoPath: '/not/allowed', issueRef: CANARY } })).rejects.toThrow();
    const out = await lines(configDir);
    expect(out).toHaveLength(7);
    const parsed = out.map((l) => JSON.parse(l) as { login: string; action: string; outcome: string });
    expect(parsed.map((p) => p.action)).toEqual(['project-add', 'clone', 'project-remove', 'settings-change', 'run-cancel', 'task-start', 'run-start']);
    expect(parsed.every((p) => p.login === 'alice')).toBe(true);
    expect(parsed[0]!.outcome).toBe('refused');
    expect(parsed[2]!.outcome).toBe('ok');
    expect(out.join('\n')).not.toContain(CANARY);
  });

  test('a started run logs run-start once, stamps startedBy, a second logs run-queue', async () => {
    const seen: (string | undefined)[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { ctx, configDir, repo } = await setup({ login: 'bob', admin: true }, async (p) => {
      seen.push(p.startedBy);
      await gate;
      return {};
    });
    const second = await mkdtemp(join(tmpdir(), 'vg-audit-repo2-'));
    ctx.allowlist = new ProjectAllowlist(async () => [second], repo);
    const a = dispatchRpc(ctx, 'api_create_run', { params: { repoPath: repo, issueRef: '1', startedBy: 'mallory' } });
    const b = dispatchRpc(ctx, 'api_create_run', { params: { repoPath: second, issueRef: '2' } });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([a, b]);
    const out = (await lines(configDir)).map((l) => JSON.parse(l) as { action: string; login: string });
    expect(out.map((o) => o.action)).toEqual(['run-start', 'run-queue']);
    expect(seen[0]).toBe('bob');
  });

  test('read_audit is admin-only and filters by login, newest first', async () => {
    const { ctx, audit } = await setup({ login: 'carol', admin: false });
    await audit.record({ login: 'a', action: 'clone', outcome: 'ok' });
    await audit.record({ login: 'b', action: 'project-add', outcome: 'ok' });
    await audit.record({ login: 'a', action: 'project-remove', outcome: 'ok' });
    await expect(dispatchRpc(ctx, 'read_audit', {})).rejects.toBeInstanceOf(ForbiddenError);
    const admin = { ...ctx, actor: { login: 'token', admin: true } };
    const all = (await dispatchRpc(admin, 'read_audit', {})) as { action: string }[];
    expect(all.map((e) => e.action)).toEqual(['project-remove', 'project-add', 'clone']);
    const only = (await dispatchRpc(admin, 'read_audit', { login: 'b' })) as { login: string }[];
    expect(only.map((e) => e.login)).toEqual(['b']);
  });

  test('rotates at the size cap and keeps at most 5 files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-audit-rot-'));
    const audit = new AuditLog(dir, { maxBytes: 100 });
    for (let i = 0; i < 40; i++) await audit.record({ login: 'a', action: 'clone', target: `t${i}`, outcome: 'ok' });
    const files = (await readdir(dir)).filter((f) => f.startsWith('audit.jsonl')).sort();
    expect(files).toEqual(['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2', 'audit.jsonl.3', 'audit.jsonl.4']);
    expect((await audit.read({ limit: 1 }))[0]!.target).toBe('t39');
  });

  test('a run refused at start-time logs one refusal and no run-start ok', async () => {
    const { ctx, configDir, repo } = await setup({ login: 'bob', admin: true });
    ctx.runSession = createRunSession(ctx.deps, () => undefined, async () => {
      throw new Error('unbound');
    });
    await expect(dispatchRpc(ctx, 'api_create_run', { params: { repoPath: repo, issueRef: '1' } })).rejects.toThrow('unbound');
    await ctx.audit!.read(); // drains the write queue
    const out = (await lines(configDir)).map((l) => JSON.parse(l) as { action: string; outcome: string });
    expect(out).toEqual([expect.objectContaining({ action: 'run-start', outcome: 'refused' })]);
  });

  test('cancelling an unknown run is refused, and targets are bounded and stripped of URL secrets', async () => {
    const { ctx, configDir } = await setup();
    await dispatchRpc(ctx, 'api_cancel', { runId: 'x'.repeat(100_000) });
    await expect(dispatchRpc(ctx, 'remove_project', { path: `https://u:${CANARY}@h.example/p?q=1` })).resolves.toBeDefined();
    const out = (await lines(configDir)).map((l) => JSON.parse(l) as { target: string; outcome: string });
    expect(out[0]).toMatchObject({ outcome: 'refused' });
    expect(out[0]!.target.length).toBeLessThan(300);
    expect(out[1]!.target).toBe('https://h.example/p');
  });

  test('a credential write is a settings-change naming the provider, never the value', async () => {
    const { ctx, configDir } = await setup();
    ctx.bind = { isLoopback: true, allowAdd: true };
    await dispatchRpc(ctx, 'set_credential', { provider: 'claude', value: CANARY }).catch(() => undefined);
    const raw = await readFile(join(configDir, 'audit.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim())).toMatchObject({ action: 'settings-change', target: 'credential:claude' });
    expect(raw).not.toContain(CANARY);
  });

  test('settings-change detail lists only keys that changed', async () => {
    const { ctx, configDir, repo } = await setup();
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'a', source: 'github' } });
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'b', source: 'github' } });
    const out = (await lines(configDir)).map((l) => JSON.parse(l) as { detail: string[] });
    expect(out[1]!.detail).toEqual(['label']);
  });

  test('creates a missing config dir and writes the file owner-only', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'vg-audit-new-')), 'nested');
    await new AuditLog(dir).record({ login: 'a', action: 'clone', outcome: 'ok' });
    expect(((await stat(join(dir, 'audit.jsonl'))).mode & 0o777).toString(8)).toBe('600');
  });

  test('safeUrl drops userinfo, query and fragment', () => {
    expect(safeUrl('git@host.example:org/repo.git')).toBe('host.example:org/repo.git');
    expect(safeUrl(`https://u:${CANARY}@h.example/o/r.git?x=1#f`)).toBe('https://h.example/o/r.git');
    expect(safeUrl('not a url')).toBe('[unparseable url]');
  });

  test('torn lines are skipped on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-audit-torn-'));
    await writeFile(join(dir, 'audit.jsonl'), '{"bad\n');
    expect(await new AuditLog(dir).read()).toEqual([]);
  });
});
