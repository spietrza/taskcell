import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli memory', () => {
  it('parses memory with defaults (no limit field)', () => {
    expect(parseCli(['memory'], '/work')).toEqual({ kind: 'memory', repoPath: '/work', json: false });
  });

  it('parses memory with --repo, --limit, and --json', () => {
    expect(parseCli(['memory', '--repo', '/r', '--limit', '5', '--json'], '/work')).toEqual({
      kind: 'memory',
      repoPath: '/r',
      limit: 5,
      json: true,
    });
  });

  it('falls back to no limit field on invalid --limit for memory', () => {
    const cmd = parseCli(['memory', '--limit', 'soon'], '/work');
    expect(cmd.kind === 'memory' && cmd.limit === undefined).toBe(true);
  });
});
