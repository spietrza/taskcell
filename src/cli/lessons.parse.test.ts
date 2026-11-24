import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli lessons', () => {
  it('parses lessons record/list/dismiss and rejects bad input', () => {
    expect(parseCli(['lessons', 'record', '--pr', '9', '--github-repo', 'o/r', '--provider-model', 'sonnet', '--dry-run'], '/work')).toEqual({
      kind: 'lessons', action: 'record', repoPath: '/work', repoSlug: 'o/r', prNumber: 9, dryRun: true, model: 'sonnet',
    });
    expect(parseCli(['lessons', 'record', '--gitlab-project', 'g/p', '--mr', '4'], '/work')).toEqual({
      kind: 'lessons', action: 'record', repoPath: '/work', repoSlug: 'g/p', prNumber: 4, gitlab: true, dryRun: false,
    });
    expect(parseCli(['lessons', 'record', '--gitlab-project', 'g/p'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['lessons', 'list', '--json', '--branch', 'm'], '/work')).toEqual({ kind: 'lessons', action: 'list', repoPath: '/work', json: true, branch: 'm' });
    expect(parseCli(['lessons', 'dismiss', 'abcdef012345'], '/work')).toEqual({ kind: 'lessons', action: 'dismiss', repoPath: '/work', id: 'abcdef012345' });
    expect(parseCli(['lessons', 'dismiss', 'nope'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['lessons', 'record', '--pr', '9'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['lessons'], '/work')).toMatchObject({ kind: 'error' });
  });
});
