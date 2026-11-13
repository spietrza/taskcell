import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsScreen } from './SettingsScreen';
import { NavGuardContext, createNavGuardRegistry } from '../../navGuard';

vi.mock('./Settings', () => ({ Settings: () => <div>general content</div> }));
vi.mock('../workflow/WorkflowEditor', () => ({ WorkflowEditor: () => <div>line content</div> }));
afterEach(() => vi.restoreAllMocks());

test('General, Line and Runners are one click away; Runners hosts Fleet (when given) and Remote', () => {
  render(<SettingsScreen project="/r" fleet={<div>fleet content</div>} remote={<div>remote content</div>} />);
  expect(screen.getByText('general content')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Line' }));
  expect(screen.getByText('line content')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Runners' }));
  expect(screen.getByText('fleet content')).toBeInTheDocument();
  expect(screen.getByText('remote content')).toBeInTheDocument();
});

test('Runners omits Fleet where it is not available', () => {
  render(<SettingsScreen project="/r" fleet={null} remote={<div>remote content</div>} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Runners' }));
  expect(screen.queryByRole('heading', { name: 'Fleet' })).toBeNull();
  expect(screen.getByText('remote content')).toBeInTheDocument();
});

test('switching sections goes through the unsaved-changes guard', () => {
  const registry = createNavGuardRegistry();
  registry.register(() => false);
  render(
    <NavGuardContext.Provider value={registry}>
      <SettingsScreen project="/r" fleet={null} remote={null} />
    </NavGuardContext.Provider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Line' }));
  expect(screen.getByText('general content')).toBeInTheDocument();
});

test('General offers to reopen the setup guide only when given a handler', () => {
  const onOpenSetup = vi.fn();
  const { rerender } = render(<SettingsScreen project="/r" fleet={null} remote={null} />);
  expect(screen.queryByRole('button', { name: 'Reopen setup guide' })).toBeNull();
  rerender(<SettingsScreen project="/r" fleet={null} remote={null} onOpenSetup={onOpenSetup} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen setup guide' }));
  expect(onOpenSetup).toHaveBeenCalled();
});
