import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { projects } from '../../dev/fixtures';

const [first] = projects;

function setup(): { onOpen: ReturnType<typeof vi.fn>; onRemove: ReturnType<typeof vi.fn>; onEnableFactory: ReturnType<typeof vi.fn> } {
  const onOpen = vi.fn();
  const onRemove = vi.fn();
  const onEnableFactory = vi.fn();
  render(<Dashboard projects={[first]} onOpen={onOpen} onAdd={() => {}} onRemove={onRemove} onEnableFactory={onEnableFactory} />);
  return { onOpen, onRemove, onEnableFactory };
}

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
    fireEvent.click(screen.getByRole('button', { name: /Enable factory/ }));
    expect(onRemove).toHaveBeenCalledWith(first.path);
    expect(onEnableFactory).toHaveBeenCalledWith({ path: first.path, name: first.name });
    expect(onOpen).not.toHaveBeenCalled();
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
