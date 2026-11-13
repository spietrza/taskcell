import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { projects } from './dev/fixtures';
import { STARTER_TASK } from './features/onboarding/steps';

const SETUP = { tools: [], models: { claude: false, codex: false } };
const LISTING = { path: '/root', entries: [{ name: 'app', path: '/root/app', isGitRepo: true, hasTaskcell: true }] };

/** A hub stub; `listProjects` answers per call so a test can delay or change it. */
function stubHub(listProjects: () => Promise<unknown[]> | unknown[], onAdd?: () => unknown[]): { cmds: string[] } {
  const cmds: string[] = [];
  const results: Record<string, () => unknown> = {
    list_teams: () => [],
    list_active: () => [],
    list_runs: () => [],
    list_runs_all: () => ({ runs: [], failures: [] }),
    list_needs_you: () => ({ items: [] }),
    list_needs_you_all: () => ({ items: [], failures: [] }),
    add_project: () => onAdd?.() ?? [],
    setup_status: () => SETUP,
    browse_dirs: () => LISTING,
    list_tasks: () => ({ tasks: [], capped: false }),
    list_tasks_all: () => ({ tasks: [], capped: false, failures: [] }),
  };
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      cmds.push(cmd);
      const result = cmd === 'list_projects' ? await listProjects() : (results[cmd]?.() ?? null);
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { cmds };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

test('a hub with no projects opens the setup guide; Dismiss remembers it', async () => {
  stubHub(() => []);
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
  expect(JSON.parse(localStorage.getItem('vanguard.onboarding')!)).toMatchObject({ completed: true });
  // The empty Home still links back to the guide.
  expect(screen.getByRole('button', { name: 'Open setup guide' })).toBeInTheDocument();
});

test('an established hub whose teams load before its projects does not get the guide', async () => {
  let release: (p: unknown[]) => void = () => {};
  const slow = new Promise<unknown[]>((r) => (release = r));
  const { cmds } = stubHub(() => slow);
  render(<App />);
  await waitFor(() => expect(cmds).toContain('list_teams'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
  release([projects[0]]);
  await screen.findByText(projects[0]!.name);
  expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
});

test('adding the first project offers the starter task, created only on click', async () => {
  let list: unknown[] = [];
  const { cmds } = stubHub(
    () => list,
    () => (list = [{ ...projects[0]!, path: '/root', name: 'app' }]),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add a repository' }));
  fireEvent.click(await screen.findByText('app'));
  fireEvent.click(await screen.findByRole('button', { name: 'Add this repo' }));
  expect(await screen.findByText(STARTER_TASK.title)).toBeInTheDocument();
  expect(cmds).not.toContain('api_create_task');
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(screen.queryByText(STARTER_TASK.title)).toBeNull();
});
