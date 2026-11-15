import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewHubTask, ScheduleEditor, ScheduleLines } from './Schedule';
import type { BoardTask } from '../../wire';

vi.mock('../../ipc', () => ({
  hubTaskSchedule: vi.fn().mockResolvedValue({ id: 'hub-2' }),
  hubTaskRetry: vi.fn().mockResolvedValue({ id: 'hub-2' }),
  hubTaskCreate: vi.fn().mockResolvedValue({ id: 'hub-3' }),
}));
import { hubTaskCreate, hubTaskRetry, hubTaskSchedule } from '../../ipc';

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
  test('a failed card shows why, a done one where its result is', () => {
    render(<ScheduleLines task={{ schedule: { state: 'failed', reason: 'no credential', label: 'failed: no credential' } }} />);
    expect(screen.getByText('failed: no credential')).toHaveAttribute('data-schedule', 'failed');
    render(<ScheduleLines task={{ schedule: { state: 'done', label: 'done', result: 'branch chore/x' } }} />);
    expect(screen.getByText('branch chore/x')).toBeInTheDocument();
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
  test('a stored instant is shown whole and not rewritten by saving only the dependencies', async () => {
    vi.mocked(hubTaskSchedule).mockClear();
    const onSaved = vi.fn();
    render(<ScheduleEditor repoPath="/r" task={{ ...base, startDate: '2099-01-01T08:30:00Z' }} onSaved={onSaved} />);
    expect(screen.getByLabelText(/Start date/)).toHaveValue('2099-01-01T08:30:00Z');
    fireEvent.change(screen.getByLabelText(/Blocked by/), { target: { value: 'hub-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(hubTaskSchedule).toHaveBeenCalledWith('/r', 'hub-2', { blockedBy: ['hub-1'] });
  });
  test('a failed task can be retried', async () => {
    const onSaved = vi.fn();
    render(<ScheduleEditor repoPath="/r" task={{ ...base, schedule: { state: 'failed', label: 'failed: boom', reason: 'boom' } }} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(hubTaskRetry).toHaveBeenCalledWith('/r', 'hub-2');
  });
  test('a refusal is shown', async () => {
    vi.mocked(hubTaskSchedule).mockRejectedValueOnce(new Error('startDate must be YYYY-MM-DD'));
    render(<ScheduleEditor repoPath="/r" task={base} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('startDate must be');
  });
});

describe('NewHubTask', () => {
  test('adds a task with its title and body, then clears', async () => {
    const onCreated = vi.fn();
    render(<NewHubTask repoPath="/r" onCreated={onCreated} />);
    expect(screen.getByRole('button', { name: 'Add task' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add a health endpoint' } });
    fireEvent.change(screen.getByLabelText(/What to do/), { target: { value: 'GET /healthz answers 200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(hubTaskCreate).toHaveBeenCalledWith('/r', 'Add a health endpoint', 'GET /healthz answers 200', {});
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });
  test('a refusal is shown', async () => {
    vi.mocked(hubTaskCreate).mockRejectedValueOnce(new Error('title must be at most 300 characters'));
    render(<NewHubTask repoPath="/r" onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 300');
  });
});
