import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MainNav, NAV } from './MainNav';

const noop = (): void => {};
const mount = (props: Partial<Parameters<typeof MainNav>[0]> = {}) =>
  render(<MainNav screen="home" hasProject onScreen={noop} onSettings={noop} {...props} />);
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Main' });

test('the nav lists Home, Board, Runs and Settings, in that order', () => {
  mount();
  expect(NAV.map((n) => n.label)).toEqual(['Home', 'Board', 'Runs', 'Settings']);
  expect(within(nav()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Home', 'Board', 'Runs', 'Settings']);
  for (const old of ['Dashboard', 'Task board', 'Needs you', 'Fleet', 'Remote', 'Workflow']) {
    expect(screen.queryByRole('button', { name: old })).toBeNull();
  }
});

test('the waiting count badges Home, in its name too, and clicking opens Home', () => {
  const onScreen = vi.fn();
  mount({ needsCount: 3, onScreen });
  const home = screen.getByRole('button', { name: 'Home, 3 waiting' });
  expect(home).toHaveTextContent('Home3');
  fireEvent.click(home);
  expect(onScreen).toHaveBeenCalledWith('home');
});

test('no badge when nothing waits; the open screen is the current page', () => {
  mount({ needsCount: 0, screen: 'board' });
  expect(screen.getByRole('button', { name: 'Home' })).toHaveTextContent(/^Home$/);
  expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('button', { name: 'Home' })).not.toHaveAttribute('aria-current');
});

test('Board, Runs and Settings are disabled without a project; Home stays clickable', () => {
  mount({ hasProject: false });
  for (const name of ['Board', 'Runs', 'Settings']) expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Home' })).toBeEnabled();
});

test('Settings opens a menu of its seven sections; picking one names it', async () => {
  // The menu's motion reads matchMedia; jsdom has none.
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const onSettings = vi.fn();
  mount({ onSettings });
  fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['General', 'Line', 'Runners', 'Lessons', 'Skills', 'Team & hub', 'Audit']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Line' }));
  expect(onSettings).toHaveBeenCalledWith('line');
  vi.unstubAllGlobals();
});

test('the Settings trigger is the current page while Settings is open', () => {
  mount({ screen: 'settings' });
  expect(screen.getByRole('button', { name: /^Settings/ })).toHaveAttribute('aria-current', 'page');
});
