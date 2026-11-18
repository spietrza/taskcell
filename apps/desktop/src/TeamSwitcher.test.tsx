import { beforeEach, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamSwitcher } from './TeamSwitcher';
import type { Team } from './wire';

const t = (id: string, repos = 0): Team => ({ id, name: `Team ${id}`, members: [], repositories: Array.from({ length: repos }, (_, i) => `/r${i}`) });
const noop = (): void => {};
// The menu's popup reads it.
beforeEach(() => vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))));

test('the team reads "name · team" and its menu lists the teams and the way to add a project', async () => {
  const onAdd = vi.fn();
  render(<TeamSwitcher teams={[t('a', 3)]} active={t('a', 3)} onSelect={noop} onAddProject={onAdd} />);
  fireEvent.click(screen.getByRole('button', { name: 'Team: Team a' }));
  expect(await screen.findByRole('menuitem', { name: /Team a\s*team · 3 projects/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set up a new project' }));
  expect(onAdd).toHaveBeenCalled();
});

test('picking another team selects it', async () => {
  const onSelect = vi.fn();
  render(<TeamSwitcher teams={[t('a'), t('b')]} active={t('a')} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'Team: Team a' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Team b/ }));
  expect(onSelect).toHaveBeenCalledWith('b');
});

test('no team renders nothing', () => {
  const { container } = render(<TeamSwitcher teams={[]} active={undefined} onSelect={noop} />);
  expect(container).toBeEmptyDOMElement();
});
