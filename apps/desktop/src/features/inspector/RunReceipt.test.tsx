import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunReceipt } from './RunReceipt';
import type { NeedsYouItem, RunDetail } from '../../wire';

vi.mock('../../ipc', () => ({
  callerCapabilities: vi.fn(async () => ({ mutationsAllowed: true, owner: true, admin: true, canAddProject: { allowed: true }, teamRoles: {} })),
}));
import { stubHubCalls } from '../../testHub';

const PR = 'https://github.com/o/r/pull/9';
const item: NeedsYouItem = { id: 'o/r#9', kind: 'pr', number: 9, repoSlug: 'o/r', title: 'T', url: PR, reason: 'taskcell:needs-human-review', baseRef: 'main' };
const detail: RunDetail = { taskId: 'gh-7', timestamp: 'ts', prUrl: PR, stages: [{ record: { stage: 'reviewer', verdict: 'pass', completed: true } as never }] };

let hubCall: ReturnType<typeof stubHubCalls>;
beforeEach(() => {
  window.__TASKCELL_HUB__ = true;
  hubCall = stubHubCalls({ list_needs_you: async () => ({ items: [item] }), reply_needs_you: async () => undefined, merge_needs_you: async () => undefined });
});
afterEach(() => vi.restoreAllMocks());

test('a PR waiting for you: Merge and Ask for changes, which sends the same reply as the inbox (comment + needs revision)', async () => {
  render(<RunReceipt detail={detail} project="/repo" merged={false} />);
  expect(await screen.findByRole('button', { name: /Merge into main/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Ask for changes' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'reply to o/r#9' }), { target: { value: 'Rename the flag.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
  await waitFor(() => expect(hubCall).toHaveBeenCalledWith('reply_needs_you', { repoPath: '/repo', id: 'o/r#9', kind: 'pr', body: 'Rename the flag.' }));
});

test('a merged run offers no actions and does not ask the hub', () => {
  render(<RunReceipt detail={detail} project="/repo" merged />);
  expect(screen.getByText('Delivery receipt')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ask for changes' })).toBeNull();
  expect(hubCall).not.toHaveBeenCalled();
});

test('the heading says "so far" only while the run is live', () => {
  const { prUrl: _pr, ...noPr } = detail;
  const { rerender } = render(<RunReceipt detail={noPr} project="/repo" merged={false} />);
  expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument();
  rerender(<RunReceipt detail={noPr} project="/repo" merged={false} live />);
  expect(screen.getByRole('heading', { name: 'Receipt so far' })).toBeInTheDocument();
});
