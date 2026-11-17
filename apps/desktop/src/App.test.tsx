import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { projects, runDetail, runs } from './dev/fixtures';
import { STARTER_TASK } from './features/onboarding/steps';
import type { Team } from './wire';

// Settings is its own test target; here it only has to be a screen the nav can leave.
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
  // Home subscribes to the hub's event stream.
  vi.stubGlobal('EventSource', class { addEventListener(): void {} removeEventListener(): void {} close(): void {} });
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
  window.history.replaceState(null, '', '/');
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
  extra: Record<string, unknown> = {},
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
        ...extra,
      };
      const result = cmd === 'list_projects' ? await listProjects(args.teamId) : (results[cmd] ?? null);
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { cmds };
}

// The main navigation's entry (Home carries its waiting count in its name).
const navButton = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: new RegExp(`^${name}`) });

test('switching to a team with no repositories clears Home’s live runs and disables the project screens', async () => {
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
  const asked: (string | undefined)[] = [];
  stubTeamHub(
    [
      { id: 'a', name: 'Alpha', members: [], repositories: [p2.path] },
      { id: 'b', name: 'Beta', members: [], repositories: [p1.path, p2.path] },
    ],
    // The unscoped list is another team's: it has none of these repositories, so the stand-in is empty.
    (teamId) => {
      asked.push(teamId);
      return teamId === 'a' ? [p2] : teamId === 'b' ? slow : [];
    },
  );
  render(<App />);
  expect(await screen.findByTitle(p2.name)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'b' } });
  await waitFor(() => expect(asked).toContain('b'));
  release([p1, p2]);
  await screen.findByText(p1.name);
  await new Promise((r) => setTimeout(r, 50));
  // Still the shared project in the switcher, not the new team's first.
  expect(screen.getByTitle(p2.name)).toBeInTheDocument();
  expect(screen.queryByTitle(p1.name)).toBeNull();
});

test('a Moving row with a live run opens it', async () => {
  const p = projects[0]!;
  const { cmds } = stubTeamHub([], () => [p]);
  render(<App />);
  fireEvent.click(await screen.findByText(`RUN${p.path}`));
  // The live run view reads the run's session; the runs list never does.
  await waitFor(() => expect(cmds).toContain('read_session'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getAllByText('running').length).toBeGreaterThan(0);
  expect(window.location.search).toBe('?screen=runs');
});

test('a Moving row clicked after an open run detail opens the live run, on every click', async () => {
  const p = projects[0]!;
  const run = { ...runs[0]!, repoPath: p.path, repoName: p.name };
  stubTeamHub([], () => [p], { list_runs_all: { runs: [run], failures: [] }, read_run: runDetail });
  render(<App />);
  await screen.findByText(`RUN${p.path}`);
  await waitFor(() => expect(navButton('Runs')).toBeEnabled());
  const crumbs = (): HTMLElement => screen.getByRole('navigation', { name: /breadcrumb/i });
  // Open a run's detail, go Home and click the same row, twice.
  for (let i = 0; i < 2; i++) {
    fireEvent.click(navButton('Runs'));
    fireEvent.click(await screen.findByText(run.taskId));
    await waitFor(() => expect(crumbs()).toHaveTextContent(run.taskId));
    expect(screen.getAllByText('passed').length).toBeGreaterThan(0);
    fireEvent.click(navButton('Home'));
    fireEvent.click(await screen.findByText(`RUN${p.path}`));
    await waitFor(() => expect(crumbs()).toHaveTextContent(`RUN${p.path}`));
    expect(crumbs()).not.toHaveTextContent(run.taskId);
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    // The list's own "passed" pill is a button; no status chip says passed for the live run.
    expect(screen.queryAllByText('passed', { selector: ':not(button)' })).toEqual([]);
  }
});

test('a tab the hub refuses shows only how to reconnect, not an empty project list', async () => {
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401, headers: { 'content-type': 'application/json' } })));
  render(<App />);
  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('open the URL that taskcell hub printed');
  expect(banner.textContent).toContain('needs that link');
  expect(banner.textContent).toContain('Reloading will not help');
  await waitFor(() => expect(screen.queryByRole('button', { name: /Add/ })).toBeNull());
  expect(screen.queryByText(/No projects yet/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try the demo project' })).toBeNull();
});

test('switching team clears the previous team’s runs at once, before the new team’s list answers', async () => {
  const p = projects[0]!;
  const teams: Team[] = [
    { id: 'a', name: 'Alpha', members: [], repositories: [p.path] },
    { id: 'b', name: 'Beta', members: [], repositories: [p.path] },
  ];
  const run = (taskId: string): unknown => ({ taskId, timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.1, anyFailed: false, repoPath: p.path, repoName: p.name });
  let release: (v: unknown) => void = () => {};
  const slow = new Promise<unknown>((r) => (release = r));
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('EventSource', class { addEventListener(): void {} removeEventListener(): void {} close(): void {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      const args = JSON.parse(init?.body ?? '{}') as { teamId?: string };
      const results: Record<string, unknown> = {
        list_teams: teams,
        list_projects: [p],
        list_active: [],
        list_runs_all: args.teamId === 'b' ? await slow : { runs: [run('A-RUN')], failures: [] },
        list_needs_you_all: { items: [], failures: [] },
        setup_status: SETUP,
      };
      return new Response(JSON.stringify({ result: results[cmd] ?? null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: p.name }));
  expect(await screen.findByText('A-RUN')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'b' } });
  await waitFor(() => expect(screen.queryByText('A-RUN')).toBeNull());
  release({ runs: [run('B-RUN')], failures: [] });
  expect(await screen.findByText('B-RUN')).toBeInTheDocument();
});

test('Home’s “See all on the Board” opens the Board with the Running filter on; the address names the screen, and Back returns Home', async () => {
  const p = projects[0]!;
  const running = { id: 'gh-9', title: 'Moving card', column: 'running', state: 'x', repoPath: p.path, repoName: p.name };
  stubTeamHub([], () => [p], { list_tasks_all: { tasks: [running], capped: false, failures: [] } });
  render(<App />);
  const see = await screen.findByRole('button', { name: /^See all \d+ on the Board/ });
  await waitFor(() => expect(navButton('Board')).toBeEnabled());
  fireEvent.click(see);
  expect(await screen.findByRole('button', { name: 'Running', pressed: true })).toBeInTheDocument();
  expect(window.location.search).toBe('?screen=board');
  // Back: the browser restores the previous address and tells the page.
  window.history.replaceState(null, '', '/');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  expect(navButton('Home')).toHaveAttribute('aria-current', 'page');
});

test('a reload restores the screen the address names, keeping other parameters and the fragment', async () => {
  const p = projects[0]!;
  stubTeamHub([], () => [p]);
  window.history.replaceState(null, '', '/?x=1&screen=settings#keep=1');
  render(<App />);
  expect(await screen.findByText('settings screen')).toBeInTheDocument();
  fireEvent.click(navButton('Board'));
  await waitFor(() => expect(window.location.search + window.location.hash).toBe('?x=1&screen=board#keep=1'));
  fireEvent.click(navButton('Home'));
  await waitFor(() => expect(window.location.search + window.location.hash).toBe('?x=1#keep=1'));
});

test('the address names a Settings section; picking another from the Settings menu rewrites it in place', async () => {
  const p = projects[0]!;
  stubTeamHub([], () => [p]);
  window.history.replaceState(null, '', '/?screen=settings&section=line');
  render(<App />);
  expect(await screen.findByText('settings screen')).toBeInTheDocument();
  const history = window.history.length;
  fireEvent.click(navButton('Settings'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Runners' }));
  await waitFor(() => expect(window.location.search).toBe('?screen=settings&section=runners'));
  // A section change replaces the address; Back leaves Settings, not a section.
  expect(window.history.length).toBe(history);
});
