import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScheduleEditor, ScheduleLines } from './Schedule';
import type { BoardTask } from '../../wire';

vi.mock('../../ipc', () => ({ hubTaskSchedule: vi.fn().mockResolvedValue({ id: 'hub-2' }) }));
import { hubTaskSchedule } from '../../ipc';

const base: BoardTask = { id: 'hub-2', title: 'B', column: 'queued', state: '' };

describe('ScheduleLines', () => {
  test('shows what blocks a card and when it waits until', () => {
    render(<ScheduleLines task={{ blockedBy: ['hub-1'], schedule: { state: 'blocked', label: 'blocked by hub-1' } }} />);
    expect(screen.getByText('blocked by hub-1')).toHaveAttribute('data-schedule', 'blocked');
  });
  test('a cycle or missing reference shows its reason', () => {
    render(<ScheduleLines task={{ schedule: { state: 'invalid', reason: 'x', label: 'cannot start: dependency cycle: a → b → a' } }} />);
    expect(screen.getByText(/dependency cycle: a → b → a/)).toHaveAttribute('data-schedule', 'invalid');
  });
  test('a GitHub card shows the dependencies and start the source reports', () => {
    render(<ScheduleLines task={{ blockedBy: ['#4', 'o/r#5'], startDate: '2026-11-18' }} />);
    expect(screen.getByText('blocked by #4, o/r#5')).toBeInTheDocument();
    expect(screen.getByText('starts 2026-11-18')).toBeInTheDocument();
  });
});

describe('ScheduleEditor', () => {
  test('saves blocked-by ids and the start date', async () => {
    const onSaved = vi.fn();
    render(<ScheduleEditor repoPath="/r" task={{ ...base, blockedBy: ['hub-1'], timeZone: 'Europe/Berlin' }} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/Blocked by/), { target: { value: 'hub-1, hub-3' } });
    fireEvent.change(screen.getByLabelText(/Start date/), { target: { value: '2026-11-18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(hubTaskSchedule).toHaveBeenCalledWith('/r', 'hub-2', { blockedBy: ['hub-1', 'hub-3'], startDate: '2026-11-18' });
  });
  test('a refusal is shown', async () => {
    vi.mocked(hubTaskSchedule).mockRejectedValueOnce(new Error('startDate must be YYYY-MM-DD'));
    render(<ScheduleEditor repoPath="/r" task={base} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('startDate must be');
  });
});
