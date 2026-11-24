import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli stats', () => {
  it('parses stats --branch and metrics push, and rejects an unknown metrics subcommand', () => {
    expect(parseCli(['stats', '--branch', 'taskcell-metrics'], '/work')).toMatchObject({ kind: 'stats', branch: 'taskcell-metrics' });
    expect(parseCli(['stats'], '/work')).not.toHaveProperty('branch');
    expect(parseCli(['metrics', 'push'], '/work')).toEqual({ kind: 'metrics', action: 'push', repoPath: '/work' });
    expect(parseCli(['metrics', 'push', '--repo', '/r', '--branch', 'b'], '/work')).toMatchObject({ kind: 'metrics', repoPath: '/r', branch: 'b' });
    const bad = parseCli(['metrics', 'pull'], '/work');
    expect(bad.kind === 'error' && bad.message).toMatch(/metrics expects a subcommand/);
  });

  it('parses stats with defaults and flags', () => {
    expect(parseCli(['stats'], '/work')).toEqual({ kind: 'stats', repoPath: '/work', json: false, approver: false });
    expect(parseCli(['stats', '--repo', '/r', '--json'], '/work')).toEqual({ kind: 'stats', repoPath: '/r', json: true, approver: false });
    expect(parseCli(['stats', '--approver'], '/work')).toEqual({ kind: 'stats', repoPath: '/work', json: false, approver: true });
  });

  it('parses stats --skills [--since]', () => {
    expect(parseCli(['stats', '--skills', '--since', '30d'], '/work')).toEqual({ kind: 'stats', repoPath: '/work', json: false, approver: false, skills: true, since: '30d' });
  });

  it('accepts stats --skills after global flags and refuses ignored combinations', () => {
    expect(parseCli(['--json', 'stats', '--skills'], '/work')).toMatchObject({ kind: 'stats', json: true, skills: true });
    for (const argv of [['stats', '--skills', '--approver'], ['stats', '--skills', '--github-repo', 'a/b'], ['stats', '--skills', '--feedback-authors', 'a'], ['stats', '--skills=foo'], ['stats', '--skills', './skills'], ['stats', '--skills', '-'], ['--skills', './dir', 'stats'], ['--skills', 'gc', 'stats']]) {
      expect(parseCli(argv, '/work').kind).toBe('error');
    }
    // The string --skills without a value, and the internal --skill-stats name, are not options.
    for (const argv of [['gc', '--skill-stats'], ['watch', '--skills'], ['watch', '--skills', '--json']]) {
      expect(parseCli(argv, '/work').kind).toBe('help');
    }
  });

  it('rejects a malformed stats --since during argument parsing', () => {
    expect(parseCli(['stats', '--skills', '--since', 'soon'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('--since') });
  });

  it('parses stats --github-repo (lead-time rollup)', () => {
    expect(parseCli(['stats', '--github-repo', 'acme/widgets'], '/work')).toEqual({
      kind: 'stats',
      repoPath: '/work',
      json: false,
      approver: false,
      githubRepo: 'acme/widgets',
    });
    expect(parseCli(['stats'], '/work')).not.toHaveProperty('githubRepo');
    expect(parseCli(['stats', '--github-repo', 'acme/widgets', '--feedback-authors', 'a, B'], '/work')).toMatchObject({ kind: 'stats', feedbackAuthors: ['a', 'B'] });
    expect(parseCli(['stats'], '/work')).not.toHaveProperty('feedbackAuthors');
  });

  it('refuses a stats --github-repo that is not owner/repo', () => {
    for (const bad of ['../..', 'a/b/c', 'acme', '../x']) {
      expect(parseCli(['stats', '--github-repo', bad], '/work')).toMatchObject({ kind: 'error' });
    }
  });
});
