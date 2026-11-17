import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LocalRunner, localRunnerState } from './LocalRunner';
import { ciOrigin } from '../inspector/RemoteRuns';
import { localWorkerState } from '../../ipc';

vi.mock('../../ipc', async (orig) => ({ ...(await orig<typeof import('../../ipc')>()), localWorkerState: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('the local hub is a runner: its switch and last pick-up', async () => {
  vi.mocked(localWorkerState).mockResolvedValue({ enabled: true, source: 'hub', credentials: { names: [], present: true }, lastPickupAt: '2026-11-17T15:53:18.000Z', lastPickup: 'hub-1, hub-3' });
  render(<LocalRunner project="/r" />);
  expect(await screen.findByText('on: picks up cards')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Local hub runner' })).toHaveTextContent('(hub-1, hub-3)');
  expect(localRunnerState({ enabled: false, credentials: { names: [], present: false }, blocked: 'no credential' }).word).toBe('off: no credential');
});

test('a CI row names what started it, not only the workflow', () => {
  expect(ciOrigin('issues')).toBe('issue label');
  expect(ciOrigin('push')).toBe('push');
  expect(ciOrigin('merge_group')).toBe('merge group');
});
