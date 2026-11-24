import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowEditor } from './WorkflowEditor';
import { NavGuardContext, createNavGuardRegistry } from '../../navGuard';
import type { FlowDoc, RepoFlowInfo } from '../../ipc';
import { stubHubCalls } from '../../testHub';

// The editor's flow-file hub commands, as positional fakes the hub stub forwards to.
const api = {
  apiListFlows: vi.fn(async (_repoPath: string): Promise<{ flows: RepoFlowInfo[] }> => ({ flows: [{ file: 'a.hcl', name: 'a', label: 'A' }] })),
  apiReadFlow: vi.fn(async (_repoPath: string, _file: string): Promise<{ doc: FlowDoc; source: string }> => ({
    doc: { name: 'a', label: 'A', stages: [{ name: 'planner', overrides: {} }], loops: [] },
    source: 'flow "a" {}',
  })),
  apiWriteFlow: vi.fn(async (_repoPath: string, _file: string, _doc: FlowDoc): Promise<{ source: string }> => ({ source: 'flow "a" {}' })),
};

vi.mock('../../ipc.js', () => ({
  apiCapabilitiesCached: vi.fn(async () => ({
    providers: ['claude'],
    flows: [],
    stages: ['planner', 'implementer'],
    transports: ['github'],
    defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
  })),
}));

beforeEach(() => {
  stubHubCalls({
    api_list_flows: ({ repoPath }) => api.apiListFlows(repoPath),
    api_read_flow: ({ repoPath, file }) => api.apiReadFlow(repoPath, file),
    api_write_flow: ({ repoPath, file, doc }) => api.apiWriteFlow(repoPath, file, doc),
  });
});
afterEach(() => vi.restoreAllMocks());

// S8 / #339: while the editor is dirty, the App-level registry must be guarded — shell navigations
// (project switch, Rail click, window close) unmount this component, so the guard is the only
// protection. Clean editor ⇒ unguarded.
test('registers a nav guard while dirty and unregisters when clean', async () => {
  const registry = createNavGuardRegistry();
  render(
    <NavGuardContext.Provider value={registry}>
      <WorkflowEditor project="/repo" />
    </NavGuardContext.Provider>,
  );
  await screen.findByText('a'); // rail lists flow "a"
  expect(registry.guarded()).toBe(false);

  // create a fresh flow (dirty from birth), then add a palette stage so Save is enabled
  fireEvent.change(screen.getByPlaceholderText('new-flow-name'), { target: { value: 'fresh' } });
  fireEvent.click(screen.getByRole('button', { name: /create flow/i }));
  await waitFor(() => expect(registry.guarded()).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /^implementer$/ }));

  // guard proxies confirmDiscard: cancel blocks, accept passes
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(registry.confirm()).toBe(false);
  confirmSpy.mockReturnValue(true);
  expect(registry.confirm()).toBe(true);
  confirmSpy.mockRestore();

  // saving cleans the state → guard released
  vi.mocked(api.apiWriteFlow).mockResolvedValueOnce({ source: 'flow "fresh" {}' });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(registry.guarded()).toBe(false));
});

// T12 / AC-8 (#339 follow-up): after the refactor onto the shared `useDiscardGuard` hook the
// editor must still release its slot on unmount — a stale guard would block the next navigation.
test('unmounting a dirty editor releases the nav guard (shared useDiscardGuard hook)', async () => {
  const registry = createNavGuardRegistry();
  const { unmount } = render(
    <NavGuardContext.Provider value={registry}>
      <WorkflowEditor project="/repo" />
    </NavGuardContext.Provider>,
  );
  await screen.findByText('a');
  fireEvent.change(screen.getByPlaceholderText('new-flow-name'), { target: { value: 'fresh' } });
  fireEvent.click(screen.getByRole('button', { name: /create flow/i }));
  await waitFor(() => expect(registry.guarded()).toBe(true));
  unmount();
  expect(registry.guarded()).toBe(false);
});
