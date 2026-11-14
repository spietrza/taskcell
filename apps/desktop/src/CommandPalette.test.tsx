import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';

const base = { projects: [], onOpenProject: vi.fn(), onHome: vi.fn(), onAddProject: vi.fn(), onToggleTheme: vi.fn(), onClose: vi.fn() };

test('offers the open project\'s screens and actions, naming the project', () => {
  const onScreen = vi.fn();
  const onNewTask = vi.fn();
  const onEnableFactory = vi.fn();
  render(<CommandPalette {...base} projectName="demo" onScreen={onScreen} onNewTask={onNewTask} onEnableFactory={onEnableFactory} />);
  for (const l of ['Board', 'Runs', 'Settings', 'New task', 'Enable factory']) expect(screen.getByText(`${l} · demo`)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Settings · demo'));
  expect(onScreen).toHaveBeenCalledWith('settings');
  fireEvent.click(screen.getByText('New task · demo'));
  expect(onNewTask).toHaveBeenCalled();
  fireEvent.click(screen.getByText('Enable factory · demo'));
  expect(onEnableFactory).toHaveBeenCalled();
});

test('omits project commands when no project is open', () => {
  render(<CommandPalette {...base} />);
  expect(screen.queryByText(/^Board/)).toBeNull();
});

test('Tab on the search input stays inside the dialog', () => {
  render(<CommandPalette {...base} projectName="demo" onScreen={vi.fn()} />);
  const input = screen.getByRole('combobox');
  expect(input).toHaveFocus();
  const notPrevented = fireEvent.keyDown(input, { key: 'Tab' });
  expect(notPrevented).toBe(false);
});

test('Escape closes the palette and focus returns to what opened it', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>open palette</button>
        {open && <CommandPalette {...base} onClose={() => setOpen(false)} />}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'open palette' });
  opener.focus();
  fireEvent.click(opener);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(opener).toHaveFocus();
});
