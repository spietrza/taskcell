import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunList } from './RunList';

test('the empty Runs page links to creating a task', () => {
  const onNewTask = vi.fn();
  render(<RunList runs={[]} active={[]} onSelect={() => {}} onOpenActive={() => {}} onNewTask={onNewTask} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create a task' }));
  expect(onNewTask).toHaveBeenCalled();
});
