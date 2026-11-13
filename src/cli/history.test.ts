import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { historyCommand } from './history.js';

it('prints the history as JSON, offline, for an empty checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-cli-'));
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await historyCommand({ kind: 'history', repoPath: dir, repoSlug: 'o/r', issue: 3, json: true, offline: true, configDir: dir });
    const written = String(out.mock.calls[0]![0]);
    expect(JSON.parse(written)).toMatchObject({ repo: 'o/r', issue: 3, entries: [], chains: [] });
  } finally {
    out.mockRestore();
  }
});
