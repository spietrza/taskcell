import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, lstat, chmod, symlink, readdir, mkdir } from 'node:fs/promises';
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
    const out = warn.mock.calls.flat().join('\n');
    expect(out).toContain('did not come from a local auth file');
    // A stored credential (hub run): no path on this machine, no local sign-in advice.
    expect(out).not.toContain(file);
    expect(out).not.toContain('codex login');
  });

  it('a symlinked auth.json is resolved once: the target is updated (0600) and the link stays a link', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file } = await setup(host);
    await mkdir(join(dir, 'link'));
    const link = join(dir, 'link', 'auth.json');
    await symlink(file, link);
    await reportRotation(rotated, 'old-refresh', { CODEX_AUTH_FILE: link });
    expect(await readFile(file, 'utf8')).toContain('new-refresh');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readdir(join(dir, 'link'))).toEqual(['auth.json']);
    expect((await readdir(dir)).sort()).toEqual(['auth.json', 'link']);
    expect(warn.mock.calls.flat().join('\n')).toContain('written back');
  });

  it('a symlink to a file holding another token is left alone, like a regular file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file } = await setup(host);
    const link = join(dir, 'link.json');
    await symlink(file, link);
    await reportRotation(rotated, 'started-with-this', { CODEX_AUTH_FILE: link });
    expect(await readFile(file, 'utf8')).toBe(host);
  });

  it('updates a CODEX_AUTH_JSON held by this process, so its later runs are not refused; another token is left alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { file } = await setup(host);
    const env: NodeJS.ProcessEnv = { CODEX_AUTH_FILE: file, CODEX_AUTH_JSON: host };
    await reportRotation(rotated, 'old-refresh', env);
    const held = JSON.parse(env.CODEX_AUTH_JSON!) as { OPENAI_API_KEY: string; tokens: Record<string, string> };
    expect(held.OPENAI_API_KEY).toBe('sk-keep');
    expect(held.tokens).toEqual({ id_token: 'real-id', access_token: 'new-access', refresh_token: 'new-refresh' });
    expect(warn.mock.calls.flat().join('\n')).toContain('Later runs of this process');

    const other: NodeJS.ProcessEnv = { CODEX_AUTH_FILE: file, CODEX_AUTH_JSON: host };
    await reportRotation(rotated, 'started-with-this', other);
    expect(other.CODEX_AUTH_JSON).toBe(host);
  });

  it('the written file is 0600 even when the original was world-readable and the umask is permissive', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { file, env } = await setup(host);
    await chmod(file, 0o644);
    // process.umask(mask) throws in worker threads: this needs Vitest's forks pool (the default here).
    const prev = process.umask(0);
    try {
      await reportRotation(rotated, 'old-refresh', env);
    } finally {
      process.umask(prev);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('new-refresh');
  });

  it('does not write a rotated credential without an access token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file, env } = await setup(host);
    await reportRotation(JSON.stringify({ tokens: { refresh_token: 'new-refresh' } }), 'old-refresh', env);
    expect(await readFile(file, 'utf8')).toBe(host);
    expect(await readdir(dir)).toEqual(['auth.json']);
    expect(warn.mock.calls.flat().join('\n')).toContain('Could not write');
  });

  it('refuses a non-regular file (a directory) at the auth path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'rot-'));
    await mkdir(join(dir, 'auth.json'));
    await reportRotation(rotated, 'old-refresh', { CODEX_AUTH_FILE: join(dir, 'auth.json') });
    expect(await readdir(dir)).toEqual(['auth.json']);
    expect(warn.mock.calls.flat().join('\n')).toContain('did not come from a local auth file');
  });

  it('reports (not throws) a missing host file and leaves no temp file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), 'rot-'));
    await reportRotation(rotated, 'old-refresh', { CODEX_AUTH_FILE: join(dir, 'nope.json') });
    const out = warn.mock.calls.flat().join('\n');
    expect(out).toContain('save a current credential there again');
    expect(out).not.toContain(dir);
    expect(out).not.toContain('codex login');
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
