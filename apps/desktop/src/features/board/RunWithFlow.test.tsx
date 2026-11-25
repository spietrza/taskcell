import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunWithFlow } from './RunWithFlow';
import { stubHubCalls } from '../../testHub';

vi.mock('../../ipc', () => ({
  callerCapabilities: vi.fn(async () => ({ mutationsAllowed: true, owner: true, admin: true, canAddProject: { allowed: true }, teamRoles: {} })),
  apiCapabilitiesCached: vi.fn(async () => ({ flows: [{ name: 'plan', label: 'Plan' }] })),
  hubTaskStart: vi.fn(async (_repo: string, id: string) => ({ id })),
  hubTaskRetry: vi.fn(async (_repo: string, id: string) => ({ id })),
}));
import { hubTaskRetry } from '../../ipc';

beforeEach(() => {
  stubHubCalls({ api_list_flows: async () => ({ flows: [] }) });
});
afterEach(() => vi.restoreAllMocks());

test('after a successful pick the button is enabled again and the Flows list is closed', async () => {
  const onDone = vi.fn();
  render(<RunWithFlow repoPath="/repo" taskId="hub-1" mode="retry" onDone={onDone} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Run with flow…' }));
  const flows = await screen.findByRole('list', { name: 'Flows' });
  fireEvent.click(await within(flows).findByRole('button', { name: 'Plan' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(hubTaskRetry).toHaveBeenCalledWith('/repo', 'hub-1', 'plan');
  expect(screen.getByRole('button', { name: 'Run with flow…' })).toBeEnabled();
  expect(screen.queryByRole('list', { name: 'Flows' })).toBeNull();
});

test('after a start the picker is gone: a second start is not offered', async () => {
  const onDone = vi.fn();
  render(<RunWithFlow repoPath="/repo" taskId="hub-2" mode="start" onDone={onDone} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Run with flow…' }));
  fireEvent.click(await within(await screen.findByRole('list', { name: 'Flows' })).findByRole('button', { name: 'Plan' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Run with flow…' })).toBeNull());
});
