import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readCommandModules } from '../command-codegen.js';
import { COMMAND_NAMES, HUB_AUDITED, HUB_COMMANDS, HUB_POLICY } from './index.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';
import { UnknownCommandError } from '../command-kit.js';
import { ForbiddenError } from '../credentials.js';

const dir = __dirname;
const modules = readCommandModules(dir);

describe('hub command modules', () => {
  test('every feature module is in the generated index (run pnpm gen:wire)', async () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts'));
    expect(modules.map((m) => `${m.file}.ts`)).toEqual(files.sort());
    for (const m of modules) {
      const mod = (await import(join(dir, `${m.file}.ts`))) as { commands: { handlers: object } };
      expect(Object.keys(mod.commands.handlers).sort(), m.file).toEqual([...m.names].sort());
    }
  });

  test('every module command is listed in COMMAND_NAMES and dispatched, with no duplicates', () => {
    const declared = modules.flatMap((m) => m.names).sort();
    expect(new Set(declared).size).toBe(declared.length);
    expect([...COMMAND_NAMES].sort()).toEqual(declared);
    expect(Object.keys(HUB_COMMANDS).sort()).toEqual(declared);
  });

  test('audit specs name only dispatched commands', () => {
    for (const name of Object.keys(HUB_AUDITED)) expect(COMMAND_NAMES).toContain(name);
  });

  test('every command declares a policy, and a write has a gate and an audit spec (or says why not)', () => {
    expect(Object.keys(HUB_POLICY).sort()).toEqual([...COMMAND_NAMES].sort());
    for (const [name, p] of Object.entries(HUB_POLICY)) {
      if (!p.write) {
        expect(p.unaudited, `${name}: a read has nothing to leave unaudited`).toBeUndefined();
        continue;
      }
      const gated = p.repo !== undefined || p.owner !== undefined || p.remote !== undefined || p.gatedBy !== undefined;
      expect(gated, `${name} writes with no gate (repo, owner, remote or gatedBy)`).toBe(true);
      const audited = Object.hasOwn(HUB_AUDITED, name);
      expect(audited || p.unaudited !== undefined, `${name} writes with no audit spec (or unaudited reason)`).toBe(true);
      expect(audited && p.unaudited !== undefined, `${name} is audited, so it needs no unaudited reason`).toBe(false);
    }
  });

  test('a repository argument is a string key, and an audit spec names a write', () => {
    for (const [name, p] of Object.entries(HUB_POLICY)) {
      if (p.repo !== undefined) expect(p.repo, name).toMatch(/^[a-zA-Z]+$/);
      if (Object.hasOwn(HUB_AUDITED, name)) expect(p.write, `${name} is audited but declared read-only`).toBe(true);
    }
  });

  test('every remote write is refused at dispatch on a non-loopback bind, before its handler runs', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
    const remote = Object.entries(HUB_POLICY).filter(([, p]) => p.remote === true && p.remoteWhen === undefined).map(([name]) => name);
    expect(remote).toEqual(expect.arrayContaining(['api_create_task', 'api_create_tasks', 'start_task', 'write_app_config', 'update_skill_pr']));
    for (const name of remote) await expect(dispatchRpc(ctx, name, { repoPath: repo }), name).rejects.toThrow(/non-loopback bind/);
  });

  test('owner-only commands answer 403 to a member, before the handler runs', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const member = { user: { id: 'u2', email: 'u2@x.test', name: 'Member' }, owner: false };
    const owned = Object.entries(HUB_POLICY).filter(([, p]) => p.owner !== undefined).map(([name]) => name);
    expect(owned).toEqual(expect.arrayContaining(['add_skill_pr', 'setup_status', 'add_project']));
    for (const name of owned) await expect(dispatchRpc(ctx, name, { repoPath: repo }, member), name).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('dispatch is a lookup: an inherited property name is an unknown command', async () => {
    const { ctx } = await makeCtx(await tmpRepo());
    await expect(dispatchRpc(ctx, 'constructor', {})).rejects.toBeInstanceOf(UnknownCommandError);
  });
});
