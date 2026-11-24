import { describe, it, expect, assert, afterEach } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli hub', () => {
  it('preserves repeated allowed Hosts', () => {
    expect(parseCli(['hub', '--demo'], '/repo')).toMatchObject({ kind: 'hub', demo: true });
    expect(parseCli(['hub'], '/repo')).not.toHaveProperty('demo');
    expect(parseCli(['hub', '--allowed-host', 'hub.example', '--allowed-host', 'other.example:8080'], '/repo'))
      .toMatchObject({ kind: 'hub', allowedHosts: ['hub.example', 'other.example:8080'] });
  });

  it('preserves repeated admin GitHub logins', () => {
    expect(parseCli(['hub', '--admin-github-login', 'alice', '--admin-github-login', 'bob'], '/repo'))
      .toMatchObject({ kind: 'hub', adminGithubLogins: ['alice', 'bob'] });
  });

  const originalHost = process.env.TASKCELL_HUB_HOST;
  const originalPort = process.env.TASKCELL_HUB_PORT;

  afterEach(() => {
    if (originalHost === undefined) delete process.env.TASKCELL_HUB_HOST;
    else process.env.TASKCELL_HUB_HOST = originalHost;
    if (originalPort === undefined) delete process.env.TASKCELL_HUB_PORT;
    else process.env.TASKCELL_HUB_PORT = originalPort;
  });

  it('T-86 parses --repo/--port/--host/--ui-dir/--no-open, defaulting host/port when absent', () => {
    delete process.env.TASKCELL_HUB_HOST;
    delete process.env.TASKCELL_HUB_PORT;
    expect(parseCli(['hub', '--token-file', '/s/k'], '/repo')).toMatchObject({ kind: 'hub', tokenFile: '/s/k' });
    expect(parseCli(['hub', 'rotate-token', '--token-file', '/s/k'], '/repo')).toEqual({ kind: 'hub-rotate-token', tokenFile: '/s/k' });
    expect(parseCli(['hub', 'rotate-token'], '/repo')).toMatchObject({ kind: 'error', message: expect.stringContaining('--token-file') });
    expect(parseCli(['hub', 'bogus'], '/repo')).toMatchObject({ kind: 'error', message: expect.stringContaining('bogus') });
    process.env.TASKCELL_HUB_TOKEN_FILE = '/env/k';
    try {
      expect(parseCli(['hub'], '/repo')).toMatchObject({ tokenFile: '/env/k' });
      expect(parseCli(['hub', 'rotate-token'], '/repo')).toEqual({ kind: 'hub-rotate-token', tokenFile: '/env/k' });
    } finally {
      delete process.env.TASKCELL_HUB_TOKEN_FILE;
    }
    expect(parseCli(['hub'], '/repo')).toEqual({
      kind: 'hub',
      repoPath: '/repo',
      host: '127.0.0.1',
      port: 7777,
      open: true,
    });
    expect(
      parseCli(['hub', '--repo', '/elsewhere', '--port', '9999', '--host', '0.0.0.0', '--ui-dir', '/ui', '--no-open'], '/repo'),
    ).toEqual({
      kind: 'hub',
      repoPath: '/elsewhere',
      host: '0.0.0.0',
      port: 9999,
      uiDir: '/ui',
      open: false,
    });
  });

  it('T-86 falls back to TASKCELL_HUB_HOST/TASKCELL_HUB_PORT when the flags are absent', () => {
    process.env.TASKCELL_HUB_HOST = '0.0.0.0';
    process.env.TASKCELL_HUB_PORT = '9000';
    const cmd = parseCli(['hub'], '/repo');
    assert(cmd.kind === 'hub');
    expect(cmd.host).toBe('0.0.0.0');
    expect(cmd.port).toBe(9000);
    // An explicit flag still wins over the env default.
    const flagged = parseCli(['hub', '--host', '127.0.0.1', '--port', '1234'], '/repo');
    assert(flagged.kind === 'hub');
    expect(flagged.host).toBe('127.0.0.1');
    expect(flagged.port).toBe(1234);
  });

  it('T-87 an invalid explicit --port is an actionable error, not help', () => {
    for (const bad of ['0', '65536', '1.5', 'NaN', 'abc']) {
      const cmd = parseCli(['hub', '--port', bad], '/repo');
      expect(cmd.kind).toBe('error');
      assert(cmd.kind === 'error');
      expect(cmd.message).toMatch(/--port/);
    }
  });

  it('T-88 adding hub does not change any other command\'s parse result', () => {
    expect(parseCli(['gc'], '/work')).toEqual({
      kind: 'gc',
      repoPath: '/work',
      maxAgeMs: 6 * 60 * 60 * 1000,
      dryRun: false,
      abandoned: false,
    });
    expect(parseCli(['run', '--linear', 'TES-1'], '/work')).toEqual({
      kind: 'run',
      source: 'linear',
      id: 'TES-1',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
    });
    expect(parseCli(['watch', '--source', 'linear', '--label', 'vanguard'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      repoPath: '/work',
      label: 'vanguard',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
    expect(parseCli([], '/work').kind).toBe('help');
    expect(parseCli(['frobnicate'], '/work').kind).toBe('help');
  });
});
