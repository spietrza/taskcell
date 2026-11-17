import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamSwitcher } from './TeamSwitcher';
import type { Team } from './wire';

const t = (id: string): Team => ({ id, name: `Team ${id}`, members: [], repositories: [] });
const noop = (): void => {};

test('one team shows its name with no menu', () => {
  render(<TeamSwitcher teams={[t('a')]} active={t('a')} onSelect={noop} />);
  expect(screen.getByText('Team a')).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

test('two teams show a menu that selects the other team', () => {
  const onSelect = vi.fn();
  render(<TeamSwitcher teams={[t('a'), t('b')]} active={t('a')} onSelect={onSelect} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Team' }), { target: { value: 'b' } });
  expect(onSelect).toHaveBeenCalledWith('b');
});

test('no team renders nothing', () => {
  const { container } = render(<TeamSwitcher teams={[]} active={undefined} onSelect={noop} />);
  expect(container).toBeEmptyDOMElement();
});
