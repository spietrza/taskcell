import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RepoFailures, RepoFilter } from './RepoFilter';
import { ALL_REPOS, loadRepoFilter, saveRepoFilter } from './repoFilter';
import type { Project } from './wire';

const project = (path: string, name: string): Project =>
  ({ path, name, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 });

test('lists "All repositories" first, then one entry per repository', () => {
  const onChange = vi.fn();
  render(<RepoFilter projects={[project('/r/a', 'a'), project('/r/b', 'b')]} value={ALL_REPOS} onChange={onChange} />);
  const options = screen.getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['All repositories', 'a', 'b']);
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '/r/b' } });
  expect(onChange).toHaveBeenCalledWith('/r/b');
});

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
