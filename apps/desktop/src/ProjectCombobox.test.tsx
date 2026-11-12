import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectCombobox } from './ProjectCombobox';
import { ALL_REPOS } from './repoFilter';
import type { Project } from './wire';

const project = (path: string, name: string): Project =>
  ({ path, name, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 });
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});

const [a, b] = [project('/r/a', 'a'), project('/r/b', 'b')];

test('offers "All repositories" first and reports it as ALL_REPOS', () => {
  const onSelect = vi.fn();
  render(<ProjectCombobox projects={[a, b]} active={a} allOption all onSelect={onSelect} />);
  expect(screen.getByRole('combobox')).toHaveValue('All repositories');
  fireEvent.click(screen.getByLabelText('Switch project'));
  const options = screen.getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['All repositories', 'a', 'b']);
  fireEvent.click(screen.getByRole('option', { name: 'All repositories' }));
  expect(onSelect).toHaveBeenCalledWith(ALL_REPOS);
});

test('without allOption only repositories are listed', () => {
  render(<ProjectCombobox projects={[a, b]} active={a} onSelect={() => {}} />);
  fireEvent.click(screen.getByLabelText('Switch project'));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['a', 'b']);
});
