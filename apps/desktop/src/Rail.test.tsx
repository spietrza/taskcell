import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Rail, NAV, resolveScreen } from './Rail';
import type { Team } from './wire';

const noop = (): void => {};
const team: Team = { id: 'a', name: 'Team a', members: [], repositories: [] };
// A team is selected so TeamSwitcher renders before the nav, as in the app.
const mount = (needsCount?: number, onScreen: (s: string) => void = noop) =>
  render(
    <Rail
      projects={[]}
      activePath={null}
      screen="home"
      running={[]}
      needsCount={needsCount}
      teams={[team]}
      team={team}
      onTeam={noop}
      onScreen={onScreen}
      onOpenRunning={noop}
    />,
  );
const navButtons = (): HTMLElement[] => within(screen.getByRole('navigation')).getAllByRole('button');

test('the rail lists Home, Board, Runs and Settings, in that order', () => {
  mount();
  expect(NAV.map((n) => n.label)).toEqual(['Home', 'Board', 'Runs', 'Settings']);
  expect(navButtons().map((b) => b.textContent)).toEqual(['Home', 'Board', 'Runs', 'Settings']);
  for (const old of ['Dashboard', 'Task board', 'Needs you', 'Fleet', 'Remote', 'Workflow']) {
    expect(screen.queryByRole('button', { name: old })).toBeNull();
  }
});

test('the needs-you count badges Home and clicking it opens Home', () => {
  const onScreen = vi.fn();
  mount(3, onScreen);
  const home = navButtons()[0];
  expect(home).toHaveTextContent('Home3');
  fireEvent.click(home);
  expect(onScreen).toHaveBeenCalledWith('home');
});

test('no badge when nothing waits', () => {
  mount(0);
  expect(navButtons()[0]).toHaveTextContent(/^Home$/);
});

test('the old Needs you entry opens Home at that section', () => {
  expect(resolveScreen('needs')).toEqual({ screen: 'home', section: 'needs' });
  expect(resolveScreen('board')).toEqual({ screen: 'board' });
});
