import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ConflictStats } from './ConflictStats';

const conflictStats = vi.hoisted(() => vi.fn());
vi.mock('../../ipc', () => ({ conflictStats }));

test('shows the conflict totals and top files', async () => {
  conflictStats.mockResolvedValue({
    weeks: [],
    total: { merges: 4, conflicts: 3, autoResolved: 2, leftForHuman: 1 },
    topFiles: [{ file: 'src/a.ts', conflicts: 2 }],
  });
  render(<ConflictStats repoPath="/r" />);
  expect((await screen.findByTestId('conflict-stats')).textContent).toBe(
    'Base merges: 4 · conflicts 3 · auto-resolved 2 · left for a human 1 · top conflicted files: src/a.ts (2)',
  );
});

test('renders nothing before any base merge was recorded', async () => {
  conflictStats.mockResolvedValue({ weeks: [], total: { merges: 0, conflicts: 0, autoResolved: 0, leftForHuman: 0 }, topFiles: [] });
  const { container } = render(<ConflictStats repoPath="/r" />);
  await vi.waitFor(() => expect(conflictStats).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});
