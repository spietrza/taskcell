import { test, expect, vi } from 'vitest';
import { handle, HANDLED_COMMANDS } from './mockBackend';
import type { Commands } from '../wire';

// The coverage guard (every wire command has a fixture handler) is type-level, in mockBackend.ts.

// The handler map is `satisfies`-checked against the wire catalogue, so a fixture whose shape has
// drifted from the real backend's payload cannot reach a test — tsc rejects it. Shown, not asserted:
// `pnpm build` (tsc) fails on the line below without the ts-expect-error, with exactly
//   error TS2322: Type 'number' is not assignable to type 'string'.
type Handler<K extends keyof Commands> = (args: Commands[K]['args']) => Promise<Commands[K]['result']> | Commands[K]['result'];
// @ts-expect-error — taskId is a string on the wire; a number result is a compile error, not a test failure.
const wrongResultShape: Handler<'list_runs'> = () => [{ taskId: 42, timestamp: 'ts', stages: [], totalCostUsd: 0, anyFailed: false }];
void wrongResultShape;

test('no handler falls through to the unhandled-command warn path', async () => {
  // Commands whose wire result is `void` legitimately resolve undefined now that the handler map is
  // typed against the catalogue (`null` is not a `void` result), so the warn path itself is the
  // signal — not an undefined return value.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const cmd of HANDLED_COMMANDS) {
    // eslint-disable-next-line no-await-in-loop
    await handle(cmd, undefined);
  }
  expect(warn.mock.calls.map((args) => String(args[0])), 'mockBackend.ts warned on a command it claims to handle').toEqual([]);
  warn.mockRestore();
});

test('fixtures: no vanguard name and a spec per board task', async () => {
  const fx = await import('./fixtures');
  expect(JSON.stringify(fx)).not.toMatch(/vanguard/i);
  expect(new Set(fx.boardTasks.map((t) => fx.taskSpecs[t.id])).size).toBe(fx.boardTasks.length);
  expect(fx.taskSpecs['LINEAR-124']).toMatch(/dark mode/i);
  expect(Date.now() - Date.parse(fx.runs[0]!.timestamp)).toBeLessThan(86_400_000);
});

test('lesson and audit times are relative to now, so they never age', async () => {
  const ago = (iso: string): number => Date.now() - Date.parse(iso);
  const { lessons } = handle('list_lessons', { repoPath: '/x' }) as { lessons: { timestamp: string }[] };
  expect(lessons.length).toBeGreaterThan(0);
  for (const l of lessons) expect(ago(l.timestamp)).toBeLessThan(7 * 86_400_000);
  const audit = handle('read_audit', { repoPath: '/x' }) as { time: string }[];
  expect(audit.length).toBeGreaterThan(0);
  for (const a of audit) expect(ago(a.time)).toBeLessThan(86_400_000);
});
