import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { WIRE_PROVIDER_NAMES, fallbackChainErrors, FALLBACK_CHAIN_MAX } from './wire.js';
import { HUB_POLICY, type Commands } from './hub/commands/index.js';
import { commandIndexSource, desktopCommandsSource, readCommandModules } from './hub/command-codegen.js';
import type { AppConfig, BoardChip, BoardTask, CompleteCallArgs, Finding, Project, ReviewVerdict, RunRecord } from './wire.js';
import { PROVIDER_NAMES } from './agents/registry.js';
import { isCoreMethod, type SidecarDeps } from './sidecar/sidecar.js';

/** Read a source file these contracts pin, by path relative to src/. */
function readSource(relPath: string): string {
  return readFileSync(join(__dirname, relPath), 'utf8');
}

// Mirrors scripts/gen-desktop-wire.ts (which cannot be imported from src/ — rootDir). The
// duplication is self-checking: if either side changes header or paths, the byte compare fails.
function assertByteIdenticalCopy(file: string, tail = ''): void {
  const header = `// GENERATED from src/${file} — do not edit; run pnpm gen:wire\n`;
  const core = join(__dirname, file);
  const desktop = join(__dirname, '..', 'packages', 'hub-client', 'src', file);
  expect(readFileSync(desktop, 'utf8')).toBe(header + readFileSync(core, 'utf8') + tail);
}

const commandModules = (): ReturnType<typeof readCommandModules> => readCommandModules(join(__dirname, 'hub', 'commands'));

function assertZeroImports(file: string): void {
  const source = readSource(file);
  expect(source).not.toMatch(/^\s*import\b/m);
  expect(source).not.toMatch(/\bfrom\s+['"]/);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\brequire\s*\(/);
}

describe('wire contract (S7)', () => {
  it('models nullable Rust options and opaque config without widening completion permissions', () => {
    expectTypeOf<null>().toExtend<Project['lastRun']>();
    expectTypeOf<null>().toExtend<Project['color']>();
    expectTypeOf<null>().toExtend<AppConfig['source']>();
    expectTypeOf<null>().toExtend<AppConfig['concurrency']>();
    expectTypeOf<AppConfig['customProviders']>().toEqualTypeOf<unknown>();
    expectTypeOf<keyof CompleteCallArgs>().toEqualTypeOf<'system' | 'messages' | 'model' | 'attachments'>();
  });

  it('hub-client copy is byte-identical to header + core source (codegen drift guard — run pnpm gen:wire)', () => {
    assertByteIdenticalCopy('wire.ts', desktopCommandsSource(commandModules(), HUB_POLICY));
  });

  it('the hub command index is the generated one (run pnpm gen:wire)', () => {
    expect(readSource('hub/commands/index.ts')).toBe(commandIndexSource(commandModules()));
  });

  it('BoardTask.waiting is an optional boolean, present in both core and the regenerated hub-client copy (T11)', () => {
    expectTypeOf<BoardTask['waiting']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<{ id: string; title: string; column: 'queued'; state: string }>().toExtend<BoardTask>();
    const desktop = readSource('../packages/hub-client/src/wire.ts');
    expect(desktop).toMatch(/^\s*waiting\?: boolean;$/m);
  });

  it('RunRecord.verdict/findings and BoardTask.stage/chips are optional, present in the regenerated hub-client copy (T23)', () => {
    expectTypeOf<RunRecord['verdict']>().toEqualTypeOf<ReviewVerdict | undefined>();
    expectTypeOf<RunRecord['findings']>().toEqualTypeOf<Finding[] | undefined>();
    expectTypeOf<BoardTask['stage']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<BoardTask['chips']>().toEqualTypeOf<BoardChip[] | undefined>();
    expectTypeOf<{ id: string; title: string; column: 'queued'; state: string }>().toExtend<BoardTask>();
    const desktop = readFileSync(join(__dirname, '..', 'packages', 'hub-client', 'src', 'wire.ts'), 'utf8');
    expect(desktop).toMatch(/^\s*stage\?: string;$/m);
    expect(desktop).toMatch(/^\s*chips\?: BoardChip\[\];$/m);
    expect(desktop).toMatch(/^\s*verdict\?: ReviewVerdict;$/m);
  });

  it('wire.ts imports nothing — static, dynamic, or require (webview-safe by construction)', () => {
    assertZeroImports('wire.ts');
  });

  it('WIRE_PROVIDER_NAMES mirrors the registry, including order (the one underivable wire value)', () => {
    expect([...WIRE_PROVIDER_NAMES]).toEqual(PROVIDER_NAMES);
  });
});

// T9: the run-record read path has ONE producer — src/core/run-store.ts — and wire.ts is the contract
// for it: the hub's list_runs/read_run return exactly the core method shapes.
describe('run-record read path (T9)', () => {
  it('the hub forwards both commands to core methods typed by the wire shapes', () => {
    for (const method of ['listRuns', 'readRun'] as const) expect(isCoreMethod(method)).toBe(true);
    expectTypeOf<Awaited<ReturnType<SidecarDeps['listRuns']>>>().toEqualTypeOf<Commands['list_runs']['result']>();
    expectTypeOf<Awaited<ReturnType<SidecarDeps['readRun']>>>().toEqualTypeOf<Commands['read_run']['result']>();
  });
});

describe('hub wire contract', () => {
  it('hub-client copy is byte-identical to header + core source (codegen drift guard — run pnpm gen:wire)', () => {
    assertByteIdenticalCopy('hub-wire.ts');
  });

  it('hub-wire.ts imports nothing — static, dynamic, or require (browser-safe by construction)', () => {
    assertZeroImports('hub-wire.ts');
  });
});

describe('needs-you caption contract', () => {
  it('hub-client copy is byte-identical to header + core source (codegen drift guard — run pnpm gen:wire)', () => {
    assertByteIdenticalCopy('needs-you-caption.ts');
  });

  it('needs-you-caption.ts imports nothing (shared with the browser and React Native)', () => {
    assertZeroImports('needs-you-caption.ts');
  });
});

describe('stations and run labels (the card view\'s shared vocabulary)', () => {
  it.each(['stations.ts', 'run-labels.ts'])('hub-client copy of %s is byte-identical to header + core source (run pnpm gen:wire)', (file) => {
    assertByteIdenticalCopy(file);
  });
});

describe('fallbackChainErrors (shared by write_app_config and the Settings form)', () => {
  const opts = { primary: 'claude', providers: ['claude', 'codex', 'cursor', 'meridian'] };
  it('a valid chain passes; absent means none', () => {
    expect(fallbackChainErrors([{ provider: 'codex', model: 'gpt-6-sol' }, { provider: 'claude', model: 'sonnet' }], opts)).toEqual({ rows: [undefined, undefined] });
    expect(fallbackChainErrors(undefined, opts)).toEqual({ rows: [] });
  });
  it('flags an unknown provider, a bad model, a duplicate, the Engine itself and meridian per row', () => {
    const { rows } = fallbackChainErrors([{ provider: 'nope' }, { provider: 'codex', model: 'a,b' }, { provider: 'cursor' }, { provider: 'cursor' }, { provider: 'claude' }, { provider: 'meridian' }], opts);
    expect(rows[0]).toMatch(/Unknown provider/);
    expect(rows[1]).toMatch(/Invalid model/);
    expect(rows[2]).toBeUndefined();
    expect(rows[3]).toMatch(/Already/);
    expect(rows[4]).toMatch(/Engine itself/);
    expect(rows[5]).toMatch(/meridian/);
  });
  it('refuses a single entry on the Engine\'s provider and a chain over the cap', () => {
    expect(fallbackChainErrors([{ provider: 'claude', model: 'sonnet' }], opts).list).toMatch(/add a second entry/);
    // A lone entry on the Engine's transport slot (claude → zai / openrouter) is refused too; with a second entry it is fine.
    expect(fallbackChainErrors([{ provider: 'zai' }], { ...opts, providers: [...opts.providers, 'zai'] }).list).toMatch(/provider or transport/);
    expect(fallbackChainErrors([{ provider: 'zai' }, { provider: 'codex' }], { ...opts, providers: [...opts.providers, 'zai'] }).list).toBeUndefined();
    expect(fallbackChainErrors([{ provider: 'codex' }], opts).list).toBeUndefined();
    // A team default has no Engine yet: a lone zai is the project's call.
    expect(fallbackChainErrors([{ provider: 'zai' }], { primary: '' }).list).toBeUndefined();
    const long = Array.from({ length: FALLBACK_CHAIN_MAX + 1 }, (_, i) => ({ provider: 'codex', model: `m${i}` }));
    expect(fallbackChainErrors(long, opts).list).toMatch(/at most 8/);
  });
});
