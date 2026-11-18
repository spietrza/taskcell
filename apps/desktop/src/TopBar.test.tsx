import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { TopBar } from './TopBar';

test('the command palette button takes focus when clicked, so the palette can hand it back', () => {
  // ThemeToggle reads matchMedia on mount; jsdom has none.
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const onCommandK = vi.fn();
  render(<TopBar crumbs={[]} onHome={() => {}} onCommandK={onCommandK} theme="light" onToggleTheme={() => {}} />);
  const button = screen.getByRole('button', { name: 'Search / command palette' });
  fireEvent.click(button);
  expect(onCommandK).toHaveBeenCalled();
  expect(button).toHaveFocus();
  vi.unstubAllGlobals();
});

test('the team sits next to the brand, before the nav; the switchers render on the right', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  render(<TopBar team={<span>acme team</span>} nav={<nav aria-label="Main" />} switchers={<span>switchers</span>} crumbs={[]} onHome={() => {}} onCommandK={() => {}} theme="light" onToggleTheme={() => {}} />);
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(screen.getByText('switchers')).toBeInTheDocument();
  const team = screen.getByText('acme team');
  expect(team.compareDocumentPosition(screen.getByRole('navigation', { name: 'Main' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  vi.unstubAllGlobals();
});
