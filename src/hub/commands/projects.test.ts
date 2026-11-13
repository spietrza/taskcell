import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as clone from '../clone.js';
import { loadPaths } from '../projects.js';
import { dispatchRpc, makeCtx, tmpRepo } from '../test-kit.js';

test('clone_project registers the clone, returns its summary and publishes progress', async () => {
  const { ctx, published } = await makeCtx(await tmpRepo());
  const target = join(ctx.browseRoot, 'repo');
  await mkdir(join(target, '.git'), { recursive: true });
  const mock = vi.spyOn(clone, 'cloneProject').mockImplementation(async (_root, _params, deps) => {
    deps?.onProgress?.('receiving objects');
    return target;
  });
  try {
    ctx.cloneHosts = ['internal.example'];
    const result = await dispatchRpc(ctx, 'clone_project', { url: 'https://internal.example/org/repo.git', parentDir: ctx.browseRoot });
    expect(result).toMatchObject({ path: target, name: 'repo' });
    expect(await loadPaths(ctx.configDir)).toEqual([target]);
    expect(published).toContainEqual({ name: 'vanguard:clone-progress', payload: { line: 'receiving objects' } });
    expect(mock).toHaveBeenCalledWith(ctx.browseRoot, expect.anything(), expect.objectContaining({ allowedHosts: ctx.cloneHosts }));
  } finally {
    mock.mockRestore();
  }
});

test('clone_project enforces mutation permissions before cloning', async () => {
  const { ctx } = await makeCtx(await tmpRepo(), { bind: { isLoopback: false, allowAdd: false } });
  const mock = vi.spyOn(clone, 'cloneProject');
  try {
    await expect(dispatchRpc(ctx, 'clone_project', { url: 'https://github.com/org/repo.git', parentDir: ctx.browseRoot }))
      .rejects.toThrow('disabled on a non-loopback bind');
    expect(mock).not.toHaveBeenCalled();
    expect(await loadPaths(ctx.configDir)).toEqual([]);
  } finally {
    mock.mockRestore();
  }
});

test('add_project is confined to the browse root, like browse_dirs', async () => {
  const outsideRepo = await tmpRepo();
  await mkdir(join(outsideRepo, '.git'));
  const { ctx } = await makeCtx(outsideRepo);
  await expect(dispatchRpc(ctx, 'add_project', { path: outsideRepo })).rejects.toThrow('path escapes the browse root');
  expect(await loadPaths(ctx.configDir)).toEqual([]);

  const inside = join(await realpath(ctx.browseRoot), 'repo');
  await mkdir(join(inside, '.git'), { recursive: true });
  // An unresolved spelling (`..`, a symlinked temp dir) is stored as its realpath.
  await dispatchRpc(ctx, 'add_project', { path: `${ctx.browseRoot}/repo/../repo` });
  expect(await loadPaths(ctx.configDir)).toEqual([inside]);
});

test('the desktop hub (browseAnywhere) adds, browses and clones outside the browse root', async () => {
  const outsideRepo = await realpath(await tmpRepo());
  await mkdir(join(outsideRepo, '.git'));
  const { ctx } = await makeCtx(outsideRepo);
  await expect(dispatchRpc(ctx, 'browse_dirs', { path: outsideRepo })).rejects.toThrow('path escapes the browse root');

  ctx.browseAnywhere = true;
  expect(await dispatchRpc(ctx, 'browse_dirs', { path: outsideRepo })).toMatchObject({ path: outsideRepo, isGitRepo: true });
  // No path: the picker still opens at the browse root (home), not at the filesystem root.
  expect(await dispatchRpc(ctx, 'browse_dirs', {})).toMatchObject({ path: await realpath(ctx.browseRoot) });
  await dispatchRpc(ctx, 'add_project', { path: outsideRepo });
  expect(await loadPaths(ctx.configDir)).toEqual([outsideRepo]);

  const mock = vi.spyOn(clone, 'cloneProject').mockResolvedValue(outsideRepo);
  try {
    await dispatchRpc(ctx, 'clone_project', { url: 'https://github.com/org/repo.git', parentDir: outsideRepo });
    expect(mock).toHaveBeenCalledWith(ctx.browseRoot, expect.anything(), expect.objectContaining({ anywhere: true }));
  } finally {
    mock.mockRestore();
  }
});
