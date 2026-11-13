import { describe, expect, test } from 'vitest';
import { combinationNote, legacySource, resolveTaskSource, runLocationLabel, runLocationOf, taskSourceLabel, taskSourceOf } from './platform';

describe('platform', () => {
  test('unset or unknown values fall back to GitHub Issues + GitHub Actions', () => {
    expect(taskSourceOf(undefined)).toBe('github');
    expect(taskSourceOf('jira')).toBe('github');
    expect(runLocationOf(null)).toBe('github-actions');
    expect(taskSourceLabel('github-project')).toBe('GitHub Projects');
    expect(runLocationLabel('watch')).toBe('Self-hosted (watch)');
  });

  test('resolveTaskSource: taskSource, else legacy source, else unset', () => {
    expect(resolveTaskSource({})).toBeUndefined();
    expect(resolveTaskSource({ source: 'gitlab' })).toBe('gitlab');
    expect(resolveTaskSource({ taskSource: 'hub', source: 'github' })).toBe('hub');
    expect(resolveTaskSource({ taskSource: 'jira', source: 'linear' })).toBe('linear');
    expect(resolveTaskSource({ source: 'jira' })).toBeUndefined();
  });

  test('legacy source maps only the sources the board reads', () => {
    expect(legacySource('gitlab')).toBe('gitlab');
    expect(legacySource('hub')).toBeUndefined();
    expect(legacySource('github-project')).toBeUndefined();
  });

  test('combination notes', () => {
    expect(combinationNote(undefined, undefined)).toBeNull(); // the existing GitHub flow
    expect(combinationNote('gitlab', 'gitlab-ci')).toBeNull();
    expect(combinationNote('linear', 'watch')).toMatch(/code host/);
    expect(combinationNote('gitlab', 'github-actions')).toMatch(/GitLab Issues/);
    expect(combinationNote('github', 'gitlab-ci')).toMatch(/GitHub Issues/);
    expect(combinationNote('github-project', 'github-actions')).toMatch(/GitHub Projects/);
    expect(combinationNote('hub', 'gitlab-ci')).toMatch(/hub board/);
    expect(combinationNote('hub', 'local')).toBeNull();
  });
});
