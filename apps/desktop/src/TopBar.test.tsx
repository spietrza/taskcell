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
