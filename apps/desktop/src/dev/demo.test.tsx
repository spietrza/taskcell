import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from '../App';
import { Dashboard } from '../features/dashboard/Dashboard';
import { handleDemo } from './mockBackend';
import { isDemoMode, isHubMode, invoke } from '../transport';
import { DEMO_REPO_PATH, DEMO_WRITE_COMMANDS, demoActiveRuns, demoBoardTasks, demoNeedsYou, demoProject, demoRuns } from './demoData';

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

  fireEvent.click(await screen.findByRole('button', { name: /^Runs/ }));
  // The rail item opens the list, not a run; and from a run detail it goes back to the list.
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

test('Run on the New Run form says the demo is read-only', async () => {
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
