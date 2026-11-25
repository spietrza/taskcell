import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AuditLog, ROUTINE_AUDIT_WINDOW_MS, ROUTINE_SEEN_MAX, SETTINGS_VALUE_KEYS, safeUrl } from './audit.js';
import { localAdapter, verifyAudit } from '../core/audit.js';
import { dispatchRpc as dispatch, ForbiddenError, type RpcContext } from './rpc.js';
import { ProjectAllowlist } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteRegistry } from './complete.js';
import { createCredentialService } from './credentials.js';
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
    allowlist: new ProjectAllowlist(async () => [], repo),
    watchRegistry: new WatchRegistry(),
    runSession: createRunSession(deps, () => undefined),
    completeRegistry: new CompleteRegistry(),
    deps,
    configDir,
    browseRoot: configDir,
    bind: { isLoopback: true, allowAdd: false },
    publish: () => undefined,
    userCredentials: createCredentialService(configDir),
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
    await expect(dispatchRpc(ctx, 'retry_paused_task', { repoPath: repo, number: 1 })).rejects.toThrow();
    await expect(dispatchRpc(ctx, 'api_create_run', { params: { repoPath: '/not/allowed', issueRef: CANARY } })).rejects.toThrow();
    const out = await lines(configDir);
    expect(out).toHaveLength(8);
    const parsed = out.map((l) => JSON.parse(l) as { login: string; action: string; outcome: string });
    expect(parsed.map((p) => p.action)).toEqual(['project-add', 'clone', 'project-remove', 'settings-change', 'run-cancel', 'task-start', 'task-retry', 'run-start']);
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
    await vi.waitFor(async () => expect(await lines(configDir)).toHaveLength(2), { timeout: 4000 });
    release();
    await Promise.all([a, b]);
    const out = (await lines(configDir)).map((l) => JSON.parse(l) as { action: string; login: string });
    expect(out.map((o) => o.action)).toEqual(['run-start', 'run-queue']);
    expect(seen[0]).toBe('bob');
  });

  test('routine watch and sign-in lines are written once per window; refusals and writes every time', async () => {
    const { ctx, configDir, repo, audit } = await setup({ login: 'alice', admin: true });
    for (let i = 0; i < 3; i++) await dispatchRpc(ctx, 'watch_project', { repoPath: repo });
    for (let i = 0; i < 2; i++) await expect(dispatchRpc(ctx, 'watch_project', { repoPath: '/not/allowed' })).rejects.toThrow();
    for (let i = 0; i < 2; i++) await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: `l${i}` } });
    const t0 = Date.now();
    await audit.record({ login: 'token', action: 'sign-in', outcome: 'ok' }, t0);
    await audit.record({ login: 'token', action: 'sign-in', outcome: 'ok' }, t0 + 2_000);
    await audit.record({ login: 'token', action: 'sign-in', outcome: 'refused' }, t0 + 4_000);
    await audit.record({ login: 'token', action: 'sign-in', outcome: 'ok' }, t0 + ROUTINE_AUDIT_WINDOW_MS + 1);
    const parsed = (await lines(configDir)).map((l) => JSON.parse(l) as { action: string; outcome: string });
    expect(parsed.map((p) => `${p.action}:${p.outcome}`)).toEqual([
      'project-watch:ok', 'project-watch:refused', 'project-watch:refused', 'settings-change:ok', 'settings-change:ok', 'sign-in:ok', 'sign-in:refused', 'sign-in:ok',
    ]);
  });

  test('a routine line whose write failed is not remembered: the next one is written', async () => {
    const { configDir, audit } = await setup();
    const file = join(configDir, 'audit.jsonl');
    await mkdir(file); // a directory where the log goes: the append fails
    await expect(audit.record({ login: 'a', action: 'sign-in', outcome: 'ok' })).rejects.toThrow();
    await rm(file, { recursive: true });
    await audit.record({ login: 'a', action: 'sign-in', outcome: 'ok' });
    expect(await lines(configDir)).toHaveLength(1);
  });

  test('routine keys use the cleaned target and stay bounded: expired keys go, and the cap holds', async () => {
    const { configDir, audit } = await setup();
    const seen = (audit as unknown as { routineSeen: Map<string, number> }).routineSeen;
    const t0 = Date.now();
    await audit.record({ login: 'a', action: 'project-watch', target: `https://u:${CANARY}@h.example/r?k=${CANARY}`, outcome: 'ok' }, t0);
    expect([...seen.keys()].join()).not.toContain(CANARY);
    await audit.record({ login: 'a', action: 'project-watch', target: 'https://h.example/r', outcome: 'ok' }, t0 + 1);
    expect(await lines(configDir)).toHaveLength(1); // the same cleaned target
    await audit.record({ login: 'b', action: 'project-watch', target: '/r', outcome: 'ok' }, t0 + ROUTINE_AUDIT_WINDOW_MS + 1);
    expect(seen.size).toBe(1); // the expired key was evicted
    for (let i = 0; i < ROUTINE_SEEN_MAX + 5; i++) await audit.record({ login: 'c', action: 'project-watch', target: `/r${i}`, outcome: 'ok' }, t0 + ROUTINE_AUDIT_WINDOW_MS + 2);
    expect(seen.size).toBe(ROUTINE_SEEN_MAX);
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

  test('read_settings_history: a member gets the repo slice (app.json keys, flow files) without actor or chain fields', async () => {
    const { ctx, audit, repo } = await setup({ login: 'carol', admin: false });
    await audit.record({ login: 'a', action: 'settings-change', target: repo, outcome: 'ok', detail: ['budgetUsd', 'verifyCmd'] });
    await audit.record({ login: 'b', action: 'settings-change', target: `${repo}:x.hcl`, outcome: 'ok' });
    await audit.record({ login: 'c', action: 'settings-change', target: `${repo}:my-skill`, outcome: 'ok' }); // skills / lessons
    await audit.record({ login: 'c', action: 'settings-change', target: repo, outcome: 'ok' }); // local_worker_set: bare target
    await audit.record({ login: 'd', action: 'settings-change', target: `${repo}2`, outcome: 'ok', detail: ['color'] }); // another repo
    await audit.record({ login: 'e', action: 'clone', target: repo, outcome: 'ok', detail: ['x'] });
    const rows = (await dispatchRpc(ctx, 'read_settings_history', { repoPath: repo })) as Record<string, unknown>[];
    expect(rows.map((r) => r.login)).toEqual(['b', 'a']);
    expect(rows[1]).toMatchObject({ detail: ['budgetUsd', 'verifyCmd'], outcome: 'ok', target: repo });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['detail', 'login', 'outcome', 'target', 'time']);
  });

  test('read_settings_history: another repo whose path extends this one with a colon does not leak its flow lines', async () => {
    const { audit } = await setup();
    await audit.record({ login: 'a', action: 'settings-change', target: '/x:y:z.hcl', outcome: 'ok' }); // repo `/x:y`, file `z.hcl`
    await audit.record({ login: 'a', action: 'settings-change', target: '/x:y/flow.hcl', outcome: 'ok' });
    await audit.record({ login: 'b', action: 'settings-change', target: '/x:flow.hcl', outcome: 'ok' });
    expect((await audit.readSettingsHistory(['/x'])).map((r) => r.login)).toEqual(['b']);
    expect(await audit.readSettingsHistory(['/x:y'])).toHaveLength(1);
  });

  test('read_settings_history caps the limit and is empty without a log', async () => {
    const { ctx, audit, repo } = await setup();
    for (let i = 0; i < 5; i++) await audit.record({ login: 'a', action: 'settings-change', target: repo, outcome: 'ok', detail: ['color'] });
    expect(await dispatchRpc(ctx, 'read_settings_history', { repoPath: repo, limit: 2 })).toHaveLength(2);
    const { audit: _omit, ...bare } = ctx;
    expect(await dispatchRpc(bare as RpcContext, 'read_settings_history', { repoPath: repo })).toEqual([]);
  });

  test('rotates at the size cap, keeps the chain, and prunes rotated files by age', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-audit-rot-'));
    const audit = new AuditLog(dir, { maxBytes: 100 });
    for (let i = 0; i < 40; i++) await audit.record({ login: 'a', action: 'clone', target: `t${i}`, outcome: 'ok' });
    const files = (await readdir(dir)).filter((f) => f.startsWith('audit.jsonl')).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain('audit.jsonl');
    expect((await verifyAudit(localAdapter({ file: join(dir, 'audit.jsonl') }))).ok).toBe(true);
    expect((await audit.read({ limit: 1 }))[0]!.target).toBe('t39');
  });

  test('a run refused at start-time logs one refusal and no run-start ok', async () => {
    const { ctx, configDir, repo } = await setup({ login: 'bob', admin: true });
    ctx.runSession = createRunSession(ctx.deps, () => undefined, async () => {
      throw new Error('unbound');
    });
    await expect(dispatchRpc(ctx, 'api_create_run', { params: { repoPath: repo, issueRef: '1' } })).rejects.toThrow('unbound');
    await vi.waitFor(async () => expect(await lines(configDir)).toHaveLength(1)); // the refusal line is written fire-and-forget
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

  test('credential and policy writes are settings changes naming no value and do not mutate process.env', async () => {
    const { ctx, configDir } = await setup();
    const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await dispatchRpc(ctx, 'save_instance_credential', { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: CANARY });
    await dispatchRpc(ctx, 'set_credential_policy', { policy: 'user-only' });
    await expect(dispatchRpc(ctx, 'save_instance_credential', { name: CANARY, value: CANARY })).rejects.toThrow();
    await expect(dispatchRpc(ctx, 'set_credential_policy', { policy: CANARY })).rejects.toThrow();
    const raw = await readFile(join(configDir, 'audit.jsonl'), 'utf8');
    const entries = raw.trim().split('\n').map((line) => JSON.parse(line) as { action: string; target: string });
    expect(entries).toEqual([
      expect.objectContaining({ action: 'settings-change', target: 'credential:CLAUDE_CODE_OAUTH_TOKEN' }),
      expect.objectContaining({ action: 'settings-change', target: 'credential-policy:user-only' }),
      expect.objectContaining({ action: 'settings-change', target: 'credential' }),
      expect.objectContaining({ action: 'settings-change', target: 'credential-policy' }),
    ]);
    expect(raw).not.toContain(CANARY);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(original);
  });

  test('settings-change detail lists only keys that changed', async () => {
    const { ctx, configDir, repo } = await setup();
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'a', source: 'github' } });
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'b', source: 'github' } });
    const out = (await lines(configDir)).map((l) => JSON.parse(l) as { detail: string[] });
    expect(out[1]!.detail).toEqual(['label']);
  });

  test('settings-change keeps old → new values for allowlisted keys only, and the history returns them', async () => {
    const { ctx, configDir, repo } = await setup();
    const secretish = { verifyCmd: `TOKEN=${CANARY} pnpm test`, runCommand: `x ${CANARY}`, chatBaseUrl: `https://u:${CANARY}@h.example`, customProviders: [{ name: 'p', baseUrl: `https://h.example/?key=${CANARY}`, keyEnv: 'P_KEY' }] };
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'a', budgetUsd: 5 } });
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'b', budgetUsd: 7, baseBranches: ['dev', 'rc'], ...secretish } });
    const raw = (await lines(configDir)).join('\n');
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain('P_KEY');
    const last = JSON.parse((await lines(configDir)).at(-1)!) as { detail: string[]; changes: unknown };
    expect(last.detail).toEqual(['baseBranches', 'budgetUsd', 'chatBaseUrl', 'customProviders', 'label', 'runCommand', 'verifyCmd']);
    expect(last.changes).toEqual([
      { key: 'baseBranches', to: 'dev, rc' },
      { key: 'budgetUsd', from: '5', to: '7' },
      { key: 'label', from: 'a', to: 'b' },
    ]);
    const [row] = (await dispatchRpc(ctx, 'read_settings_history', { repoPath: repo })) as { changes?: unknown }[];
    expect(row!.changes).toEqual(last.changes);
  });

  test('the audit log drops a value change for a key off the allowlist, whoever passes it', async () => {
    const { audit, repo } = await setup();
    await audit.record({ login: 'a', action: 'settings-change', target: repo, outcome: 'ok', detail: ['verifyCmd', 'color'], changes: [{ key: 'verifyCmd', to: CANARY }, { key: 'color', from: '#000000', to: `#fff\n${'x'.repeat(200)}` }] });
    await audit.record({ login: 'a', action: 'clone', target: repo, outcome: 'ok', changes: [{ key: 'color', to: '#111111' }] });
    const [clone, save] = await audit.read();
    expect(clone).not.toHaveProperty('changes');
    expect(JSON.stringify(save)).not.toContain(CANARY);
    expect(save!.changes).toEqual([{ key: 'color', from: '#000000', to: `#fff ${'x'.repeat(75)}…` }]);
  });

  test('SETTINGS_VALUE_KEYS is the reviewed allowlist: no command, URL or provider key', () => {
    expect([...SETTINGS_VALUE_KEYS].sort()).toEqual(['baseBranch', 'baseBranches', 'budgetUsd', 'chatModel', 'color', 'concurrency', 'fallbackChain', 'flow', 'label', 'provider', 'reviewProvider', 'runLocation', 'source', 'taskSource', 'team', 'usageCapPct']);
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

describe('audit log fail-closed', () => {
  test('an unwritable log rejects the record and the action is reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-audit-bad-'));
    await writeFile(join(dir, 'blocker'), 'x');
    const audit = new AuditLog(join(dir, 'blocker'));
    await expect(audit.record({ login: 'a', action: 'clone', target: 't', outcome: 'ok' })).rejects.toThrow(/write failed/);
  });
});

describe('audit log failure paths', () => {
  test('an applied action whose audit line cannot be written is reported, not silently dropped', async () => {
    const { ctx, configDir, repo } = await setup({ login: 'alice', admin: true });
    await writeFile(join(configDir, 'blocker'), 'x');
    ctx.audit = new AuditLog(join(configDir, 'blocker'));
    await expect(dispatchRpc(ctx, 'remove_project', { path: repo })).rejects.toThrow(/was applied but its audit line could not be written/);
  });

  test('a refused run start is subjected to the repo, not a run id', async () => {
    const { ctx, configDir } = await setup({ login: 'alice', admin: true });
    await expect(dispatchRpc(ctx, 'api_create_run', { params: { repoPath: '/not/allowed', issueRef: '1' } })).rejects.toThrow();
    const last = JSON.parse((await lines(configDir)).at(-1)!) as { subject?: Record<string, string>; actor: { kind: string; name: string } };
    expect(last.subject).toEqual({ repo: '/not/allowed' });
    expect(last.actor).toMatchObject({ kind: 'user', name: 'alice' });
  });
});
