import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { projects } from './dev/fixtures';
import { STARTER_TASK } from './features/onboarding/steps';
import type { Team } from './wire';

// Settings is its own test target; here it only has to be a screen the rail can leave.
vi.mock('./features/settings/SettingsScreen', () => ({ SettingsScreen: () => <div>settings screen</div> }));

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
  // Unmount while the hub stubs still stand: a project screen's teardown calls the hub.
  cleanup();
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

/** A hub stub with teams; `listProjects` answers per team id (undefined = the unscoped list). */
function stubTeamHub(
  teams: Team[],
  listProjects: (teamId: string | undefined) => Promise<unknown[]> | unknown[],
): { cmds: string[] } {
  const cmds: string[] = [];
  window.__TASKCELL_HUB__ = true;
  // The project screens subscribe to the hub's event stream.
  vi.stubGlobal('EventSource', class { addEventListener(): void {} removeEventListener(): void {} close(): void {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      cmds.push(cmd);
      const args = JSON.parse(init?.body ?? '{}') as { teamId?: string; repoPath?: string };
      const results: Record<string, unknown> = {
        list_teams: teams,
        // One running run per repository, named after it.
        list_active: [{ taskId: `RUN${args.repoPath}`, sessionFile: '/s', lastActivityMs: Date.now() }],
        list_runs: [],
        list_runs_all: { runs: [], failures: [] },
        list_needs_you: { items: [] },
        list_needs_you_all: { items: [], failures: [] },
        list_tasks: { tasks: [], capped: false },
        list_tasks_all: { tasks: [], capped: false, failures: [] },
        setup_status: SETUP,
        read_app_config_strict: {},
        read_session: { entries: [], inputTokens: 0, outputTokens: 0, estCostUsd: 0 },
      };
      const result = cmd === 'list_projects' ? await listProjects(args.teamId) : (results[cmd] ?? null);
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { cmds };
}

// The rail's entry (Runs carries a count beside its label).
const navButton = (name: string): HTMLElement => within(screen.getByRole('complementary')).getByRole('button', { name: new RegExp(`^${name}`) });

test('switching to a team with no repositories clears the rail’s running runs and disables the project screens', async () => {
  const p = projects[0]!;
  stubTeamHub(
    [
      { id: 'a', name: 'Alpha', members: [], repositories: [p.path] },
      { id: 'b', name: 'Beta', members: [], repositories: [] },
    ],
    (teamId) => (teamId === 'b' ? [] : [p]),
  );
  render(<App />);
  expect(await screen.findByText(`RUN${p.path}`)).toBeInTheDocument();
  expect(navButton('Board')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'b' } });
  await waitFor(() => expect(screen.queryByText(`RUN${p.path}`)).toBeNull());
  // Nothing to open without a project: only Home stays clickable.
  for (const name of ['Board', 'Runs', 'Settings']) expect(navButton(name)).toBeDisabled();
  expect(navButton('Home')).toBeEnabled();
});

test('a project in both teams stays selected across a team switch, while the new team’s list is in flight', async () => {
  const [p1, p2] = [projects[0]!, projects[1]!];
  let release: (list: unknown[]) => void = () => {};
  const slow = new Promise<unknown[]>((r) => (release = r));
  stubTeamHub(
    [
      { id: 'a', name: 'Alpha', members: [], repositories: [p2.path] },
      { id: 'b', name: 'Beta', members: [], repositories: [p1.path, p2.path] },
    ],
    // The unscoped list is another team's: it has none of these repositories, so the stand-in is empty.
    (teamId) => (teamId === 'a' ? [p2] : teamId === 'b' ? slow : []),
  );
  render(<App />);
  expect(await screen.findByText(`RUN${p2.path}`)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'b' } });
  await new Promise((r) => setTimeout(r, 50));
  release([p1, p2]);
  await screen.findByText(p1.name);
  await new Promise((r) => setTimeout(r, 50));
  // Still the shared project, not the new team's first.
  expect(screen.getByText(`RUN${p2.path}`)).toBeInTheDocument();
  expect(screen.queryByText(`RUN${p1.path}`)).toBeNull();
});

test('a rail Running entry clicked from Settings opens the live run', async () => {
  const p = projects[0]!;
  const { cmds } = stubTeamHub([], () => [p]);
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has none; the live run view scrolls to its tail
  render(<App />);
  const entry = await screen.findByText(`RUN${p.path}`);
  await waitFor(() => expect(navButton('Settings')).toBeEnabled());
  fireEvent.click(navButton('Settings'));
  expect(await screen.findByText('settings screen')).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 50));
  fireEvent.click(entry);
  // The live run view reads the run's session; the runs list never does.
  await waitFor(() => expect(cmds).toContain('read_session'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByText('running')).toBeInTheDocument();
});

test('a tab the hub refuses shows only how to reconnect, not an empty project list', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401, headers: { 'content-type': 'application/json' } })));
  render(<App />);
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('open the URL that taskcell hub printed');
  expect(banner.querySelector('code')).toHaveTextContent('taskcell hub');
  await waitFor(() => expect(screen.queryByRole('button', { name: /Add/ })).toBeNull());
  expect(screen.queryByText(/No projects yet/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try the demo project' })).toBeNull();
});
