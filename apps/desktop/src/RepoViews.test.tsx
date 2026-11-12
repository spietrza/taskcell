import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoFailures } from './RepoViews';
import { ALL_REPOS, loadRepoFilter, saveRepoFilter } from './repoFilter';

test('the choice survives a reload via localStorage', () => {
  localStorage.clear();
  expect(loadRepoFilter()).toBe(ALL_REPOS);
  saveRepoFilter('/r/b');
  expect(loadRepoFilter()).toBe('/r/b');
});

test('names the repositories that could not be read', () => {
  render(<RepoFailures failures={[{ repoPath: '/r/b', repoName: 'b', error: 'tracker down' }]} />);
  expect(screen.getByRole('alert')).toHaveTextContent('b (tracker down)');
});
