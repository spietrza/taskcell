import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectCombobox } from './ProjectCombobox';
import type { Project } from './wire';

const project = (path: string, name: string): Project =>
  ({ path, name, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 });
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});

const [a, b] = [project('/r/a', 'a'), project('/r/b', 'b')];

test('lists repositories only', () => {
  render(<ProjectCombobox projects={[a, b]} active={a} onSelect={() => {}} />);
  fireEvent.click(screen.getByLabelText('Switch project'));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['a', 'b']);
});
