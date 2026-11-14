// Its own file: the capabilities are cached per module, and App.test.tsx's hub stubs answer them with null.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { projects } from './dev/fixtures';

const SETUP = { tools: [], models: { claude: false, codex: false } };
const navButton = (name: string): HTMLElement => within(screen.getByRole('complementary')).getByRole('button', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

test('a run started from the Board shows its live strip on Runs; the rail\'s Runs item then shows the list', async () => {
  const p = projects[0]!;
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', class { addEventListener(): void {} removeEventListener(): void {} close(): void {} });
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
    read_approver_decisions: { decisions: [] },
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
  // As on main: going to Runs after the launch shows the live strip.
  fireEvent.click(navButton('Runs'));
  expect(await screen.findByRole('button', { name: /Back to runs/ })).toBeInTheDocument();
  expect(screen.getByText('starting…')).toBeInTheDocument();
  // The rail item, clicked with the strip open, shows the list; the run is one click away on its chip.
  fireEvent.click(navButton('Runs'));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Back to runs/ })).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'show live run' })).toBeInTheDocument();
});
