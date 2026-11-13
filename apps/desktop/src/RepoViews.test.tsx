import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoFailures } from './RepoViews';

test('names the repositories that could not be read', () => {
  render(<RepoFailures failures={[{ repoPath: '/r/b', repoName: 'b', error: 'tracker down' }]} />);
  expect(screen.getByRole('alert')).toHaveTextContent('b (tracker down)');
});
