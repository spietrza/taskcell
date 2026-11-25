import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LiveRun } from './LiveRun';
import { readRunEvents } from '../../ipc';
import { stubHubCalls } from '../../testHub';

vi.mock('../../ipc', async (orig) => ({ ...(await orig<typeof import('../../ipc')>()), readRunEvents: vi.fn() }));
vi.mock('./StreamView', () => ({ StreamView: () => null }));

const active = { taskId: 'gh-3', sessionFile: '/x', lastActivityMs: 0 };
const session = { entries: [], inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
const runStart = { id: 1, ts: '2026-11-25T10:00:00.000Z', event: 'api:event', data: { runId: 'r1', event: { type: 'run-start', taskId: 'gh-3', flow: 'plan', stages: ['implementer'] } } };

afterEach(() => vi.restoreAllMocks());

test('shows the flow of the run, read from the repository it is given', async () => {
  stubHubCalls({ read_session: async () => session as never });
  vi.mocked(readRunEvents).mockResolvedValue({ events: [runStart], nextAfter: 1, hasMore: false, truncated: false });
  render(<LiveRun active={active} repo="/repo" refreshKey={0} />);
  expect(await screen.findByText('plan')).toBeInTheDocument();
  expect(readRunEvents).toHaveBeenCalledWith('/repo', 'gh-3');
});

test('says the flow is unavailable when the run\'s events cannot be read', async () => {
  stubHubCalls({ read_session: async () => session as never });
  vi.mocked(readRunEvents).mockRejectedValue(new Error('gone'));
  render(<LiveRun active={active} repo="/repo" refreshKey={0} />);
  await waitFor(() => expect(screen.getByText(/Flow unavailable/)).toBeInTheDocument());
});
