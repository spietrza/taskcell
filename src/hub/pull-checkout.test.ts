import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, expect, test } from 'vitest';
import { pullCheckout } from './pull-checkout.js';
import { dispatchRpc, makeCtx, type OWNER } from './test-kit.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const g = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.test', '-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();

/** A work clone (the "hub checkout") of a bare origin, and a second clone to push new commits from. */
async function fixture(): Promise<{ checkout: string; other: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pull-checkout-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  await execa('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const checkout = join(root, 'checkout');
  const other = join(root, 'other');
  await execa('git', ['clone', '-q', origin, other]);
  await writeFile(join(other, 'a.txt'), '1');
  await g(other, 'add', '.');
  await g(other, 'commit', '-qm', 'one');
  await g(other, 'push', '-q', 'origin', 'main');
  await execa('git', ['clone', '-q', origin, checkout]);
  return { checkout, other };
}
const push = async (other: string, file: string): Promise<void> => {
  await writeFile(join(other, file), file);
  await g(other, 'add', '.');
  await g(other, 'commit', '-qm', file);
  await g(other, 'push', '-q', 'origin', 'main');
};

test('fast-forwards a clean checkout on the default branch', async () => {
  const { checkout, other } = await fixture();
  expect(await pullCheckout(checkout)).toEqual({ updated: false });
  await push(other, 'b.txt');
  expect(await pullCheckout(checkout)).toEqual({ updated: true });
  expect(await g(checkout, 'rev-parse', 'HEAD')).toBe(await g(other, 'rev-parse', 'HEAD'));
});

test('refuses a dirty tree (tracked or untracked) and changes nothing', async () => {
  const { checkout, other } = await fixture();
  await push(other, 'b.txt');
  const head = await g(checkout, 'rev-parse', 'HEAD');
  await writeFile(join(checkout, 'untracked.txt'), 'x');
  await expect(pullCheckout(checkout)).rejects.toThrow('uncommitted changes');
  await rm(join(checkout, 'untracked.txt'));
  await writeFile(join(checkout, 'a.txt'), 'edited');
  await expect(pullCheckout(checkout)).rejects.toThrow('uncommitted changes');
  expect(await g(checkout, 'rev-parse', 'HEAD')).toBe(head);
});

test('refuses another branch and never switches', async () => {
  const { checkout, other } = await fixture();
  await push(other, 'b.txt');
  await g(checkout, 'switch', '-q', '-c', 'feature');
  const head = await g(checkout, 'rev-parse', 'HEAD');
  await expect(pullCheckout(checkout)).rejects.toThrow('not on main');
  expect(await g(checkout, 'branch', '--show-current')).toBe('feature');
  expect(await g(checkout, 'rev-parse', 'HEAD')).toBe(head);
});

test('refuses a diverged checkout and changes nothing', async () => {
  const { checkout, other } = await fixture();
  await push(other, 'b.txt');
  await writeFile(join(checkout, 'local.txt'), 'l');
  await g(checkout, 'add', '.');
  await g(checkout, 'commit', '-qm', 'local');
  const head = await g(checkout, 'rev-parse', 'HEAD');
  await expect(pullCheckout(checkout)).rejects.toThrow('diverged');
  expect(await g(checkout, 'rev-parse', 'HEAD')).toBe(head);
});

test('pull_checkout is owner-only, and runs for the owner', async () => {
  const { checkout, other } = await fixture();
  await push(other, 'b.txt');
  const { ctx } = await makeCtx(checkout);
  const member: typeof OWNER = { user: { id: 'u2', email: 'u2@x.test', name: 'Member' }, owner: false };
  await expect(dispatchRpc(ctx, 'pull_checkout', { repoPath: checkout }, member)).rejects.toThrow('only the hub owner');
  expect(await dispatchRpc(ctx, 'pull_checkout', { repoPath: checkout })).toEqual({ updated: true });
});
