import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, symlink, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportRotation } from './codex-rotation.js';

const rotated = JSON.stringify({ tokens: { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'synthetic' }, last_refresh: '2026-01-01T00:00:00Z' });
const host = JSON.stringify({ OPENAI_API_KEY: 'sk-keep', tokens: { id_token: 'real-id', access_token: 'old-access', refresh_token: 'old-refresh' }, last_refresh: 'old' });

afterEach(() => vi.restoreAllMocks());

const setup = async (content: string): Promise<{ dir: string; file: string; env: NodeJS.ProcessEnv }> => {
  const dir = await mkdtemp(join(tmpdir(), 'rot-'));
  const file = join(dir, 'auth.json');
  await writeFile(file, content);
  return { dir, file, env: { CODEX_AUTH_FILE: file } };
};

describe('reportRotation', () => {
  it('merges only access/refresh tokens and last_refresh, atomically at 0600, keeping the real id_token and API key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file, env } = await setup(host);
    await reportRotation(rotated, 'old-refresh', env);
    const out = JSON.parse(await readFile(file, 'utf8')) as { OPENAI_API_KEY: string; tokens: Record<string, string>; last_refresh: string };
    expect(out.OPENAI_API_KEY).toBe('sk-keep');
    expect(out.tokens).toEqual({ id_token: 'real-id', access_token: 'new-access', refresh_token: 'new-refresh' });
    expect(out.last_refresh).toBe('2026-01-01T00:00:00Z');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['auth.json']);
    expect(warn.mock.calls.flat().join('\n')).toContain('rotated');
  });

  it('is silent when the refresh token did not change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { file, env } = await setup(host);
    await reportRotation(JSON.stringify({ tokens: { refresh_token: 'old-refresh' } }), 'old-refresh', env);
    expect(warn).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(host);
  });

  it('leaves a host file alone when it holds a different (newer) refresh token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { file, env } = await setup(host);
    await reportRotation(rotated, 'started-with-this', env);
    expect(await readFile(file, 'utf8')).toBe(host);
    expect(warn.mock.calls.flat().join('\n')).toContain('left alone');
  });

  it('updates a symlinked auth.json in place', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file } = await setup(host);
    await mkdir(join(dir, 'link'));
    const link = join(dir, 'link', 'auth.json');
    await symlink(file, link);
    await reportRotation(rotated, 'old-refresh', { CODEX_AUTH_FILE: link });
    expect((await readFile(file, 'utf8')).includes('new-refresh')).toBe(true);
    expect((await stat(link)).isFile()).toBe(true);
  });

  it('reports (not throws) a missing host file and leaves no temp file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'rot-'));
    await reportRotation(rotated, 'old-refresh', { CODEX_AUTH_FILE: join(dir, 'nope.json') });
    expect(warn.mock.calls.flat().join('\n')).toContain('Could not write');
    expect(await readdir(dir)).toEqual([]);
  });

  it('CI: no file write; log and job summary say the stored secret is stale', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file } = await setup(host);
    const summary = join(dir, 'summary.md');
    await reportRotation(rotated, 'old-refresh', { CI: '1', CODEX_AUTH_FILE: file, GITHUB_STEP_SUMMARY: summary });
    expect(await readFile(file, 'utf8')).toBe(host);
    expect(await readFile(summary, 'utf8')).toContain('CODEX_AUTH_JSON secret is now stale');
    expect(warn.mock.calls.flat().join('\n')).toContain('now stale');
  });
});
