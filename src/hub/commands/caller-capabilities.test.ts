import { expect, test } from 'vitest';
import type { CallerCapabilities } from '../../wire.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

test('caller_capabilities on a loopback hub allows the owner every write', async () => {
  const repo = await tmpRepo();
  const { ctx } = await makeCtx(repo);
  const caps = (await dispatchRpc(ctx, 'caller_capabilities', { repoPath: repo })) as CallerCapabilities;
  expect(caps).toMatchObject({ mutationsAllowed: true, owner: true, canAddProject: { allowed: true } });
  expect(caps.project).toMatchObject({ teamRole: 'admin', canMerge: { allowed: true }, canEditSkills: { allowed: true } });
});

test('caller_capabilities on a non-loopback hub without the opt-in refuses writes, with the reason', async () => {
  const repo = await tmpRepo();
  const { ctx } = await makeCtx(repo, { bind: { isLoopback: false, allowAdd: false } });
  const caps = (await dispatchRpc(ctx, 'caller_capabilities', { repoPath: repo })) as CallerCapabilities;
  expect(caps.mutationsAllowed).toBe(false);
  expect(caps.canAddProject.reason).toContain('TASKCELL_HUB_ALLOW_ADD=1');
  expect(caps.project?.canMerge).toMatchObject({ allowed: false, reason: expect.stringContaining('TASKCELL_HUB_ALLOW_ADD=1') });
  expect(caps.project?.canReply.allowed).toBe(false);
});

test('a hub admin may add a project (clone), a plain member may not', async () => {
  const repo = await tmpRepo();
  const { ctx } = await makeCtx(repo);
  const user = { id: 'u', email: '', name: 'u' } as never;
  const admin = (await dispatchRpc(ctx, 'caller_capabilities', undefined, { user, owner: false, hubAdmin: true })) as CallerCapabilities;
  expect(admin.canAddProject.allowed).toBe(true);
  const member = (await dispatchRpc(ctx, 'caller_capabilities', undefined, { user, owner: false })) as CallerCapabilities;
  expect(member.canAddProject).toMatchObject({ allowed: false, reason: expect.stringContaining('hub admin') });
});
