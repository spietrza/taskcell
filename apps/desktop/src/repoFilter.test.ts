import { expect, test } from 'vitest';
import { inRepos } from './repoFilter';

test('inRepos keeps only rows of the given repositories', () => {
  const rows = [{ repoPath: '/a' }, { repoPath: '/b' }];
  expect(inRepos(rows, ['/b'])).toEqual([{ repoPath: '/b' }]);
  expect(inRepos(rows, [])).toEqual([]);
});
