// Its own file: the capabilities are cached per module, and App.test.tsx's hub stubs answer them with null.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { projects } from './dev/fixtures';

const SETUP = { tools: [], models: { claude: false, codex: false } };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

test('a run started from the Board lands in the Runs split view, not the old strip', async () => {
  const p = projects[0]!;
  window.__TASKCELL_HUB__ = true;
  const sse = new Map<string, () => void>();
  vi.stubGlobal('EventSource', class { addEventListener(name: string, fn: () => void): void { sse.set(name, fn); } removeEventListener(): void {} close(): void {} });
  const results: Record<string, unknown> = {
    list_teams: [],
    list_projects: [p],
    list_active: [],
    list_runs: [],
    list_needs_you: { items: [] },
    list_runs_all: { runs: [], failures: [] },
    list_needs_you_all: { items: [], failures: [] },
    list_tasks_all: { tasks: [{ id: 'gh-7', title: 'Seven', column: 'queued', state: 'Todo', repoPath: p.path, repoName: p.name }], capped: false, failures: [] },
    setup_status: SETUP,
    read_app_config_strict: {},
    read_app_config: {},
    api_capabilities: { providers: ['claude'], flows: [{ name: 'default', label: 'Default' }], stages: [], transports: ['github'], defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' } },
    api_repo_ok: true,
    api_queue: [],
    api_list_flows: { flows: [] },
    api_list_providers: { providers: [] },
    fetch_spec: { spec: 'spec' },
    list_lessons: { lessons: [], branchFound: true },
    read_approver_decisions: { decisions: [], mode: 'shadow' },
    read_issue_history: { repo: 'o/r', issue: 7, prs: [], entries: [], chains: [], unavailable: [] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      if (cmd === 'api_create_run') return new Promise<Response>(() => {}); // the run stays in flight
      return new Response(JSON.stringify({ result: results[cmd] ?? null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: p.name }));
  fireEvent.click(await screen.findByRole('button', { name: /^Board/ }));
  fireEvent.click((await screen.findByText('Seven')).closest('button')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Full page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'New Run' }));
  fireEvent.change(await screen.findByPlaceholderText(/issue ref/), { target: { value: '7' } });
  await waitFor(() => expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  // The launch switches to Runs by itself: the split view, never the old full-screen strip.
  expect(await screen.findByRole('button', { name: 'Reload' })).toBeInTheDocument();
  expect(window.location.search).toBe('?screen=runs');
  expect(screen.queryByText('starting…')).toBeNull();
  expect(screen.queryByRole('button', { name: 'show live run' })).toBeNull();
  // A running row opens in the pane beside the list, with no "running — view" chip.
  results.list_active = [{ taskId: 'gh-7', sessionFile: '/s', lastActivityMs: Date.now() }];
  results.read_session = { entries: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estCostUsd: 0 };
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  fireEvent.click(await screen.findByText('Seven'));
  expect(await screen.findByRole('region', { name: 'Run gh-7' })).toBeInTheDocument();
  expect(screen.queryByText('running — view')).toBeNull();
  // When the run ends, the pane swaps the live view for the finished record (with its PR).
  const record = { taskId: 'gh-7', timestamp: '2026-11-17T06:00:00.000Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false, prUrl: 'https://github.com/o/r/pull/10', repoPath: p.path, repoName: p.name };
  results.list_active = [];
  results.list_runs = [record];
  results.list_runs_all = { runs: [record], failures: [] };
  results.read_run = { taskId: 'gh-7', timestamp: record.timestamp, stages: [], prUrl: record.prUrl };
  results.read_run_events = { events: [] };
  // The hub tells the page the run ended (a stream resync refreshes the list as a change event would).
  act(() => sse.get('stream-reset')?.());
  await waitFor(() => expect(screen.getByRole('region', { name: 'Run gh-7' })).toHaveTextContent('#10'));
});
