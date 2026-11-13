import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamSwitcher } from './TeamSwitcher';
import type { Team } from './wire';

const t = (id: string): Team => ({ id, name: `Team ${id}`, members: [], repositories: [] });
const noop = (): void => {};

test('one team shows its name with no menu', () => {
  render(<TeamSwitcher teams={[t('a')]} active={t('a')} onSelect={noop} collapsed={false} onExpand={noop} />);
  expect(screen.getByText('Team a')).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

test('two teams show a menu that selects the other team', () => {
  const onSelect = vi.fn();
  render(<TeamSwitcher teams={[t('a'), t('b')]} active={t('a')} onSelect={onSelect} collapsed={false} onExpand={noop} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Team' }), { target: { value: 'b' } });
  expect(onSelect).toHaveBeenCalledWith('b');
});

test('no team renders nothing; a collapsed rail shows the initial, which expands it', () => {
  const { container, rerender } = render(<TeamSwitcher teams={[]} active={undefined} onSelect={noop} collapsed={false} onExpand={noop} />);
  expect(container).toBeEmptyDOMElement();
  const onExpand = vi.fn();
  rerender(<TeamSwitcher teams={[t('a'), t('b')]} active={t('a')} onSelect={noop} collapsed onExpand={onExpand} />);
  fireEvent.click(screen.getByRole('button', { name: 'Team Team a' }));
  expect(onExpand).toHaveBeenCalled();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
