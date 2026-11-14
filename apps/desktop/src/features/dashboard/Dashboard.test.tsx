import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { factoryStateNone, factoryStateSettingUp, projects } from '../../dev/fixtures';
import type { FactoryState } from '../../wire';

const [first] = projects;

function setup(): { onOpen: ReturnType<typeof vi.fn>; onRemove: ReturnType<typeof vi.fn>; onEnableFactory: ReturnType<typeof vi.fn> } {
  const onOpen = vi.fn();
  const onRemove = vi.fn();
  const onEnableFactory = vi.fn();
  render(<Dashboard projects={[first]} onOpen={onOpen} onAdd={() => {}} onRemove={onRemove} onEnableFactory={onEnableFactory} />);
  return { onOpen, onRemove, onEnableFactory };
}

describe('Dashboard platform', () => {
  test('projects with different platforms show side by side; an unset task source is not shown as GitHub Issues', () => {
    const [a, b] = projects;
    render(<Dashboard projects={[{ ...a!, taskSource: undefined, runLocation: undefined }, b!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('No task source')).toBeInTheDocument();
    expect(screen.queryByText('GitHub Issues')).toBeNull();
    expect(screen.getByText('GitHub Actions')).toBeInTheDocument();
    expect(screen.getByText('GitLab Issues')).toBeInTheDocument();
    expect(screen.getByText('GitLab CI')).toBeInTheDocument();
  });

  test('an invalid combination is explained on the card', () => {
    render(<Dashboard projects={[{ ...first!, taskSource: 'linear', runLocation: 'github-actions' }]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText(/Linear only supplies tasks/)).toBeInTheDocument();
  });
});

describe('Dashboard project card', () => {
  test('opens from the keyboard: the project name is a focusable button', () => {
    const { onOpen } = setup();
    const open = screen.getByRole('button', { name: first.name });
    open.focus();
    expect(open).toHaveFocus();
    // A native <button> turns Enter/Space into a click; jsdom does not, so click stands in for it.
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith({ path: first.path, name: first.name });
  });

  test('Remove and Enable factory run their own action without opening the project', () => {
    const { onOpen, onRemove, onEnableFactory } = setup();
    fireEvent.click(screen.getByRole('button', { name: `Remove ${first.name}` }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: /Enable factory/ }));
    expect(onRemove).toHaveBeenCalledWith(first.path);
    expect(onEnableFactory).toHaveBeenCalledWith({ path: first.path, name: first.name });
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('Remove asks first; Cancel keeps the project', () => {
    const { onRemove } = setup();
    fireEvent.click(screen.getByRole('button', { name: `Remove ${first.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `Remove ${first.name}` })).toBeInTheDocument();
  });

  test('card actions are stacked above the stretched open overlay', () => {
    // jsdom has no layout, so guard the stacking classes the browser relies on: the overlay is the
    // name button's ::after, and any action without `relative z-10` would be painted under it.
    setup();
    for (const name of [`Remove ${first.name}`, /Enable factory/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('relative', 'z-10');
    }
  });
});

describe('Dashboard empty state', () => {
  test('says what to do next and links to adding a project and the setup guide', () => {
    const onAdd = vi.fn();
    const onOpenSetup = vi.fn();
    render(<Dashboard projects={[]} onOpen={() => {}} onAdd={onAdd} onRemove={() => {}} onOpenSetup={onOpenSetup} />);
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open setup guide' }));
    expect(onOpenSetup).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add project' })[0]!);
    expect(onAdd).toHaveBeenCalled();
  });
});

describe('Dashboard factory state', () => {
  const label = (f: FactoryState): string => {
    const { unmount } = render(<Dashboard projects={[first!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} factory={{ [first!.path]: f }} />);
    const text = screen.getByTestId('factory-state').textContent ?? '';
    unmount();
    return text;
  };

  test('shows not enabled / setting up with the step / ready / broken with the reason', () => {
    expect(label(factoryStateNone)).toBe('Factory: not enabled');
    expect(label(factoryStateSettingUp)).toBe('Factory: setting up — Secret set');
    expect(label({ ...factoryStateNone, state: 'ready' })).toBe('Factory: ready');
    expect(label({ ...factoryStateNone, state: 'broken', reason: 'the doctor run failure' })).toBe('Factory: broken — the doctor run failure');
  });

  test('without factory data the card has no factory line', () => {
    render(<Dashboard projects={[first!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.queryByTestId('factory-state')).not.toBeInTheDocument();
  });
});

test('the Running tile is a button when it can open the running runs, and plain otherwise', () => {
  const onOpenRunning = vi.fn();
  const { unmount } = render(<Dashboard projects={[first!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} onOpenRunning={onOpenRunning} />);
  fireEvent.click(screen.getByRole('button', { name: /^Running/ }));
  expect(onOpenRunning).toHaveBeenCalledOnce();
  unmount();
  render(<Dashboard projects={[first!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
  expect(screen.queryByRole('button', { name: /^Running/ })).toBeNull();
});
