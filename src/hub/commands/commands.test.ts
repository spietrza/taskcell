import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readCommandModules } from '../command-codegen.js';
import { COMMAND_NAMES, HUB_AUDITED, HUB_COMMANDS } from './index.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';
import { UnknownCommandError } from '../command-kit.js';

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

  test('dispatch is a lookup: an inherited property name is an unknown command', async () => {
    const { ctx } = await makeCtx(await tmpRepo());
    await expect(dispatchRpc(ctx, 'constructor', {})).rejects.toBeInstanceOf(UnknownCommandError);
  });
});
