import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoFailures } from './RepoViews';

test('names the repositories that could not be read', () => {
  render(<RepoFailures failures={[{ repoPath: '/r/b', repoName: 'b', error: 'tracker down' }]} />);
  expect(screen.getByRole('alert')).toHaveTextContent('b (tracker down)');
});

test('says the other repositories are listed only when there are others', () => {
  const failures = [{ repoPath: '/r/b', repoName: 'b', error: 'tracker down.' }];
  const { rerender } = render(<RepoFailures failures={failures} total={1} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/^Could not read b \(tracker down\)\.$/);
  rerender(<RepoFailures failures={failures} total={2} />);
  expect(screen.getByRole('alert')).toHaveTextContent('The other repositories are listed.');
});
