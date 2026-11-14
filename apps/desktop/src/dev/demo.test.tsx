import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from '../App';
import { Dashboard } from '../features/dashboard/Dashboard';
import { handleDemo } from './mockBackend';
import { isDemoMode, isHubMode, invoke } from '../transport';
import { DEMO_REPO_PATH, DEMO_WRITE_COMMANDS, demoActiveRuns, demoBoardTasks, demoNeedsYou, demoProject, demoRunDetails, demoRuns } from './demoData';

afterEach(() => {
  cleanup(); // unmount while demo mode is still on, so effect cleanups stay in-browser
  delete window.__TASKCELL_DEMO__;
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

test('the marker and ?demo=1 both select demo mode, which also counts as hub mode', () => {
  expect(isDemoMode()).toBe(false);
  window.history.replaceState(null, '', '/?demo=1');
  expect(isDemoMode()).toBe(true);
  expect(isHubMode()).toBe(true);
  window.history.replaceState(null, '', '/');
  window.__TASKCELL_DEMO__ = true;
  expect(isDemoMode()).toBe(true);
});

test('demo data covers the lanes, Needs you and a dependency chain', () => {
  const lanes = new Set(demoBoardTasks.map((t) => t.column));
  expect(lanes.size).toBeGreaterThanOrEqual(5);
  expect(lanes).toContain('running');
  expect(demoNeedsYou.length).toBeGreaterThanOrEqual(2);
  expect(demoBoardTasks.filter((t) => t.state.startsWith('Blocked by')).length).toBeGreaterThanOrEqual(2);
});

test('demo data is consistent: one name, the demo repository, a spec per card, matching counts', () => {
  const all = JSON.stringify([demoNeedsYou, handleDemo('list_lessons', {})]);
  expect(all).not.toMatch(/vanguard|acme/);
  expect(handleDemo('fetch_spec', { taskId: 'DEMO-101' })).not.toEqual(handleDemo('fetch_spec', { taskId: 'DEMO-102' }));
  expect(handleDemo('list_drafts', {})).toEqual([]);
  // The rail's Runs badge counts what the Runs list shows: finished runs plus the one in flight.
  expect(demoProject.runCount).toBe(demoRuns.length + demoActiveRuns.length);
  // The Board header's "Running" counts the cards the factory holds; one is shown as running.
  expect(demoBoardTasks.filter((t) => t.column === 'claimed' || t.column === 'running')).toHaveLength(demoActiveRuns.length);
  expect((handleDemo('api_list_flows', {}) as { flows: { file: string }[] }).flows.every((f) => !f.file.includes('/'))).toBe(true);
});

test('demo mode refuses every write command and never fetches', async () => {
  window.__TASKCELL_DEMO__ = true;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  for (const cmd of DEMO_WRITE_COMMANDS) {
    // eslint-disable-next-line no-await-in-loop
    await expect(invoke(cmd, { repoPath: DEMO_REPO_PATH })).rejects.toMatch(/read-only/);
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(() => handleDemo('read_run', { taskId: 'DEMO-101' })).not.toThrow();
});

test('the empty Home offers "Try the demo project", linking to ?demo=1', () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  render(<Dashboard projects={[]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Try the demo project' }));
  expect(assign).toHaveBeenCalledWith('/?demo=1');
  vi.unstubAllGlobals();
});

test('every main screen opens in demo mode without errors', async () => {
  window.__TASKCELL_DEMO__ = true;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<App />);
  expect(await screen.findByRole('status')).toHaveTextContent(/Demo project/);
  fireEvent.click(await screen.findByText('storefront (demo)', { selector: '*' }));

  // A project opens on Runs. The run in progress opens first, as after a reload with a live run: DEMO-104 with its stages, not an empty box.
  expect(await screen.findByRole('button', { name: /Back to runs/ })).toBeInTheDocument();
  expect(screen.getAllByText('DEMO-104').length).toBeGreaterThan(0);
  expect(screen.getByTestId('stage-0')).toHaveAttribute('data-phase', 'done');
  expect(screen.getByTestId('stage-1')).toHaveTextContent('implement');
  expect(screen.getByTestId('stage-1')).toHaveAttribute('data-phase', 'running');
  expect(screen.queryByText('starting…')).not.toBeInTheDocument();
  // A click on the rail's Runs item while it is open shows the list; and from a run detail it goes back to the list.
  fireEvent.click(screen.getByRole('button', { name: /^Runs/ }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Back to runs/ })).not.toBeInTheDocument());
  fireEvent.click(await screen.findByText('DEMO-101'));
  expect(await screen.findByText('reviewer')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Runs/ }));
  await waitFor(() => expect(screen.queryByText('reviewer')).not.toBeInTheDocument());
  expect(screen.getByPlaceholderText(/^Search/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
  expect(await screen.findByText('Fix cart total rounding')).toBeInTheDocument();
  expect(screen.getByText('Add wishlist to the account page')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Line' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Line' })).toHaveAttribute('aria-selected', 'true'));

  // Home carries both the Needs you section and the project list.
  fireEvent.click(screen.getByRole('button', { name: /^Home/ }));
  expect(await screen.findByText('Case-insensitive product search')).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  expect(error).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
}, 30000);

test('Run on the New Run form says the demo is read-only, even with the demo run live', async () => {
  window.__TASKCELL_DEMO__ = true;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  render(<App />);
  fireEvent.click(await screen.findByText('storefront (demo)', { selector: '*' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Board/ }));
  fireEvent.click((await screen.findByText('Fix cart total rounding')).closest('button')!);
  fireEvent.click(await screen.findByRole('button', { name: 'Full page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'New Run' }));
  fireEvent.change(await screen.findByPlaceholderText(/issue ref/), { target: { value: '101' } });
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  expect(await screen.findByText(/Demo project is read-only/)).toBeInTheDocument();
  vi.unstubAllGlobals();
}, 30000);

test('demo runs tell one story: list and detail agree, dates are recent, a failed run does not pass tests, lessons fit the task', () => {
  for (const run of demoRuns) {
    const detail = demoRunDetails[run.taskId]!;
    expect(detail.stages.map((st) => st.record.stage)).toEqual(run.stages);
    expect(detail.stages.reduce((sum, st) => sum + (st.record.costUsd ?? 0), 0)).toBeCloseTo(run.totalCostUsd);
    expect(JSON.stringify(detail).includes('tests passed')).toBe(!run.anyFailed);
  }
  expect(demoRuns.filter((r) => Date.now() - Date.parse(r.timestamp) < 24 * 3_600_000)).toHaveLength(demoProject.runsLast24h);
  expect(new Set(Object.values(demoRunDetails).map((d) => d.stages[1]!.diff)).size).toBe(demoRuns.length);
  // Every Needs you item is a card on the Board.
  for (const item of demoNeedsYou) expect(demoBoardTasks.some((t) => t.title === item.title)).toBe(true);
  expect(demoProject.taskCount).toBe(demoBoardTasks.length);
  expect(demoProject.taskSource).toBe('github');
  expect(handleDemo('factory_state', {})).toMatchObject({ state: 'ready' });
  expect((handleDemo('read_session', {}) as { estCostUsd: number }).estCostUsd).toBe(0.12);
  const lessons = (text: string): unknown[] => (handleDemo('list_lessons', { taskText: text }) as { lessons: unknown[] }).lessons;
  expect(lessons('Fix cart total rounding')).toHaveLength(1);
  expect(lessons('Dark mode for the storefront')).toHaveLength(0);
});

test('demo: Stop says read-only; the New Run form closes on Cancel and on navigation, taking its message with it', async () => {
  window.__TASKCELL_DEMO__ = true;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  render(<App />);
  fireEvent.click(await screen.findByText('storefront (demo)', { selector: '*' }));
  fireEvent.click(await screen.findByRole('button', { name: /^(Stop|Cancel)/ }));
  expect(await screen.findByText(/Demo project is read-only/)).toBeInTheDocument();

  const openForm = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: /^Board/ }));
    fireEvent.click((await screen.findByText('Fix cart total rounding')).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Full page' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New Run' }));
    // The card's own ref is filled in.
    expect(await screen.findByLabelText('Issue ref')).toHaveValue('DEMO-101');
  };
  await openForm();
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  expect(await screen.findByText(/Demo project is read-only/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText(/Demo project is read-only/)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'New run' })).toBeNull();

  await openForm();
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'New run' })).toBeNull());
  expect(screen.queryByText(/Demo project is read-only/)).toBeNull();
  vi.unstubAllGlobals();
}, 30000);

test('opening a run from its row with Enter leaves focus on the run, not on the page body', async () => {
  window.__TASKCELL_DEMO__ = true;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
  render(<App />);
  fireEvent.click(await screen.findByText('storefront (demo)', { selector: '*' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Runs/ }));
  const row = (await screen.findByText('DEMO-101')).closest('tr')!;
  row.focus();
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(await screen.findByText('reviewer')).toBeInTheDocument();
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  vi.unstubAllGlobals();
}, 30000);

test('the running demo card and its live transcript tell the same story', () => {
  const card = demoBoardTasks.find((t) => t.id === demoActiveRuns[0]!.taskId)!;
  expect(card.title).toBe('Add wishlist to the account page');
  const text = (handleDemo('read_session', {}) as { entries: { text: string }[] }).entries.map((e) => e.text).join('\n');
  expect(text).toMatch(/wishlist/i);
  expect(text).toMatch(/account/i);
  expect(text).not.toMatch(/Add the new endpoint|src\/index\.ts/);
});
