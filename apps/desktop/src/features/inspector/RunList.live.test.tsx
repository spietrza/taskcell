import { test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RunList } from './RunList';
import { readRunEvents } from '../../ipc';
import type { ActiveRun } from '../../taskcell-output';

vi.mock('../../ipc', async (orig) => ({ ...(await orig<typeof import('../../ipc')>()), readRunEvents: vi.fn() }));

const noop = (): void => {};
const active: ActiveRun[] = [{ taskId: 'gh-3', sessionFile: '/x', lastActivityMs: Date.now() }];
const ev = (n: number, event: Record<string, unknown>) => ({ id: n, ts: new Date(Date.now() - 60_000 + n * 1000).toISOString(), event: 'api:event', data: { runId: 'run-9', event } });

test('a live run in its reviewer stage shows Review on its row', async () => {
  vi.mocked(readRunEvents).mockResolvedValue({
    events: [
      ev(1, { type: 'run-start', taskId: 'gh-3', stages: ['implementer', 'reviewer'] }),
      ev(2, { type: 'stage-start', name: 'implementer', index: 0, of: 2 }),
      ev(3, { type: 'stage-end', name: 'implementer', index: 0, of: 2, outcome: 'completed' }),
      ev(4, { type: 'stage-start', name: 'reviewer', index: 1, of: 2 }),
    ],
    nextAfter: 4,
    hasMore: false,
    truncated: false,
  });
  render(<RunList runs={[]} active={active} onSelect={noop} onOpenActive={noop} />);
  await waitFor(() => expect(screen.getByTestId('run-row').querySelector('[role="img"]')).toHaveAttribute('aria-label', 'Station: Review'));
});
