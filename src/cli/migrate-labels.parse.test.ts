import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli migrate-labels', () => {
  it('parses migrate-labels (dry-run unless --apply)', () => {
    expect(parseCli(['migrate-labels', '--github-repo', 'o/r'], '/work')).toEqual({ kind: 'migrate-labels', repoSlug: 'o/r', apply: false });
    expect(parseCli(['migrate-labels', '--github-repo', 'o/r', '--apply'], '/work')).toEqual({ kind: 'migrate-labels', repoSlug: 'o/r', apply: true });
    expect(parseCli(['migrate-labels'], '/work')).toMatchObject({ kind: 'error' });
  });
});
