import { expect, test } from 'vitest';
import { commands } from './ci-cost.js';
import type { CommandCall } from '../command-kit.js';

const call = (args: Record<string, unknown>): CommandCall => ({ args, allow: async (p: string) => p }) as never;

test('read_cost_breakdown rejects an unknown period and a missing repoPath', async () => {
  const h = commands.handlers.read_cost_breakdown;
  await expect(h(call({ repoPath: '/r', period: '1y' }))).rejects.toThrow(/period/);
  await expect(h(call({}))).rejects.toThrow(/repoPath/);
});

test('read_cost_breakdown on a repo with no metrics branch answers no-branch with a hint', async () => {
  const out = (await commands.handlers.read_cost_breakdown(call({ repoPath: '/nonexistent-vg-repo' }))) as { status: string; period: string; hint: string };
  expect(out).toMatchObject({ status: 'no-branch', period: 'all' });
  expect(out.hint).toContain('metrics push');
});
