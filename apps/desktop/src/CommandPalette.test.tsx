import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';

const base = { projects: [], onOpenProject: vi.fn(), onHome: vi.fn(), onAddProject: vi.fn(), onToggleTheme: vi.fn(), onClose: vi.fn() };

test('offers the open project\'s screens and actions, naming the project', () => {
  const onScreen = vi.fn();
  const onNewTask = vi.fn();
  const onAutoRun = vi.fn();
  render(<CommandPalette {...base} projectName="demo" onScreen={onScreen} onNewTask={onNewTask} onAutoRun={onAutoRun} />);
  for (const l of ['Board', 'Runs', 'Settings', 'New card', 'Set up auto-run']) expect(screen.getByText(`${l} · demo`)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Settings · demo'));
  expect(onScreen).toHaveBeenCalledWith('settings');
  fireEvent.click(screen.getByText('New card · demo'));
  expect(onNewTask).toHaveBeenCalled();
  fireEvent.click(screen.getByText('Set up auto-run · demo'));
  expect(onAutoRun).toHaveBeenCalled();
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

test('finds loaded cards and runs by id and title in the shown projects, and opens them', () => {
  const onOpenCard = vi.fn();
  const onOpenRun = vi.fn();
  const projects = [{ path: '/r/form', name: 'taskcell-demo-form' }, { path: '/r/hub', name: 'hub-app' }] as never;
  const cards = [
    { id: 'hub-4', title: 'Fix the login form', repoPath: '/r/hub' },
    { id: 'hub-5', title: 'Other team card', repoPath: '/r/elsewhere' },
  ];
  const runs = [{ taskId: 'hub-4', timestamp: '2026-11-17T10:00:00Z', stages: [], totalCostUsd: 0, anyFailed: false, repoPath: '/r/hub' }];
  render(<CommandPalette {...base} projects={projects} cards={cards} runs={runs} onOpenCard={onOpenCard} onOpenRun={onOpenRun} />);
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'hub-4' } });
  expect(screen.queryByText('No matches')).toBeNull();
  fireEvent.click(screen.getByText('hub-4 · Fix the login form'));
  expect(onOpenCard).toHaveBeenCalledWith(cards[0]);
  fireEvent.change(input, { target: { value: 'login' } });
  fireEvent.click(screen.getByText('Run · hub-4 · Fix the login form'));
  expect(onOpenRun).toHaveBeenCalledWith(runs[0]);
});

test('a card outside the shown projects, or naming none, is not offered', () => {
  const cards = [{ id: 'hub-5', title: 'Other team card', repoPath: '/r/elsewhere' }, { id: 'hub-55', title: 'No repository' }];
  render(<CommandPalette {...base} projects={[{ path: '/r/hub', name: 'hub' }] as never} cards={cards} onOpenCard={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hub-5' } });
  expect(screen.getByText('No matches')).toBeInTheDocument();
});

test('Board and Runs name what they show; project commands name the project', () => {
  render(<CommandPalette {...base} projectName="taskcell-demo-form" scopeName="All repositories" onScreen={vi.fn()} onNewTask={vi.fn()} />);
  expect(screen.getByText('Board · All repositories')).toBeInTheDocument();
  expect(screen.getByText('Runs · All repositories')).toBeInTheDocument();
  expect(screen.getByText('Settings · taskcell-demo-form')).toBeInTheDocument();
  expect(screen.getByText('New card · taskcell-demo-form')).toBeInTheDocument();
});

test('the Home commands say Home, and the inbox uses Home\'s name for it', () => {
  render(<CommandPalette {...base} onNeedsYou={vi.fn()} />);
  expect(screen.getAllByText('Home')).toHaveLength(2); // the command and the inbox's hint
  expect(screen.getByText('Waiting for you')).toBeInTheDocument();
  expect(screen.queryByText('All projects')).toBeNull();
});
