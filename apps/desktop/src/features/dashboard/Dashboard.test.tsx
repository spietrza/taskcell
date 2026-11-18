import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { factoryStateNone, factoryStateSettingUp, projects } from '../../dev/fixtures';
import type { FactoryState, LocalWorkerState } from '../../wire';

const worker = (enabled: boolean): LocalWorkerState => ({ enabled, source: 'hub', credentials: { present: true, names: [] } }) as LocalWorkerState;

const [first] = projects;

function setup(): { onOpen: ReturnType<typeof vi.fn>; onRemove: ReturnType<typeof vi.fn>; onOpenAutoRun: ReturnType<typeof vi.fn> } {
  const onOpen = vi.fn();
  const onRemove = vi.fn();
  const onOpenAutoRun = vi.fn();
  render(<Dashboard projects={[first]} onOpen={onOpen} onAdd={() => {}} onRemove={onRemove} onOpenAutoRun={onOpenAutoRun} factory={{ [first!.path]: factoryStateNone }} />);
  return { onOpen, onRemove, onOpenAutoRun };
}

describe('Dashboard platform', () => {
  test('projects with different platforms show side by side; an unset task source is not shown as GitHub Issues', () => {
    const [a, b] = projects;
    render(<Dashboard projects={[{ ...a!, taskSource: undefined, runLocation: undefined }, b!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('No card source')).toBeInTheDocument();
    expect(screen.queryByText('GitHub Issues')).toBeNull();
    expect(screen.getByText('GitHub Actions')).toBeInTheDocument();
    expect(screen.getByText('GitLab')).toBeInTheDocument();
    expect(screen.getByText('GitLab CI')).toBeInTheDocument();
  });

  test('an invalid combination is explained on the card', () => {
    render(<Dashboard projects={[{ ...first!, taskSource: 'linear', runLocation: 'github-actions' }]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText(/Linear only supplies cards/)).toBeInTheDocument();
  });
});

describe('Dashboard hub-board project', () => {
  const hub = { ...first!, taskSource: 'hub' as const, runLocation: undefined };

  test('an unset run location reads as Local hub, with no CI mismatch note', () => {
    render(<Dashboard projects={[hub]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} onOpenAutoRun={() => {}} factory={{ [hub.path]: factoryStateNone }} />);
    expect(screen.getByText('Taskcell board')).toBeInTheDocument();
    expect(screen.getByText('Local hub')).toBeInTheDocument();
    expect(screen.queryByText('GitHub Actions')).toBeNull();
    expect(screen.queryByRole('button', { name: /Enable factory|Hub worker|Factory checklist/ })).toBeNull();
  });

  test('a never-switched worker is off even with a ready CI factory; only the switch turns a board on', () => {
    const tile = (w: LocalWorkerState | undefined): string => {
      const { unmount } = render(<Dashboard projects={[hub]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} factory={{ [hub.path]: { ...factoryStateNone, state: 'ready' } }} {...(w ? { localWorker: { [hub.path]: w } } : {})} />);
      const text = screen.getByTestId('auto-run').textContent ?? '';
      unmount();
      return text;
    };
    expect(tile(undefined)).toBe('Auto-run: off');
    expect(tile(worker(false))).toBe('Auto-run: off');
    expect(tile(worker(true))).toBe('Auto-run: on · this hub');
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

  test('Remove and Auto-run run their own action without opening the project', () => {
    const { onOpen, onRemove, onOpenAutoRun } = setup();
    fireEvent.click(screen.getByRole('button', { name: `Remove ${first.name}` }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: /Auto-run/ }));
    expect(onRemove).toHaveBeenCalledWith(first.path);
    expect(onOpenAutoRun).toHaveBeenCalledWith({ path: first.path, name: first.name });
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
    for (const name of [`Remove ${first.name}`, /Auto-run/]) {
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

describe('Dashboard auto-run state', () => {
  const label = (f: FactoryState | undefined, w?: LocalWorkerState): string => {
    const { unmount } = render(<Dashboard projects={[first!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} {...(f ? { factory: { [first!.path]: f } } : {})} {...(w ? { localWorker: { [first!.path]: w } } : {})} />);
    const text = screen.getByTestId('auto-run').textContent ?? '';
    unmount();
    return text;
  };

  test('GitHub/GitLab: on in CI once the factory is ready, on this hub when the switch is on; off says why when broken or setting up', () => {
    expect(label(factoryStateNone)).toBe('Auto-run: off');
    expect(label(factoryStateSettingUp)).toBe('Auto-run: off — setting up: Secret set');
    expect(label({ ...factoryStateNone, state: 'ready' })).toBe('Auto-run: on · CI');
    expect(label({ ...factoryStateNone, state: 'broken', reason: 'the doctor run failure' })).toBe('Auto-run: off — CI broken: the doctor run failure');
    expect(label(factoryStateNone, worker(true))).toBe('Auto-run: on · this hub');
    expect(label(undefined, { ...worker(true), lastError: 'no credential' })).toBe('Auto-run: on · this hub — last error: no credential');
  });

  test('without factory or worker data the card has no auto-run line', () => {
    render(<Dashboard projects={[first!]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.queryByTestId('auto-run')).not.toBeInTheDocument();
  });
});

test('a project card says what its numbers and chips are: spend, runs in 24h, cards from, run on', () => {
  render(<Dashboard projects={[{ ...first!, runsLast24h: 2, totalCostUsd: 1.5 }]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} />);
  expect(screen.getByText('$1.50 spent')).toBeInTheDocument();
  expect(screen.getByText('2 runs in 24h')).toBeInTheDocument();
  expect(screen.getByText('Cards from')).toBeInTheDocument();
  expect(screen.getByText('run on')).toBeInTheDocument();
});

test('a GitLab project whose factory is ready in CI says it runs on GitLab CI, not on its stored "local"', () => {
  const p = { ...first!, taskSource: 'gitlab' as const, runLocation: 'local' as const };
  const ready = { ...factoryStateNone, state: 'ready' as const, plan: { provider: 'gitlab' } as FactoryState['plan'] };
  render(<Dashboard projects={[p]} onOpen={() => {}} onAdd={() => {}} onRemove={() => {}} factory={{ [p.path]: ready }} />);
  expect(screen.getByText('GitLab CI')).toBeInTheDocument();
  expect(screen.queryByText('Local hub')).not.toBeInTheDocument();
});
