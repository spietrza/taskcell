import type { ReactNode } from 'react';
import { cn } from '@/ui';

/**
 * The Runs screen's frame: the list on the left, the open run on the right (the landing's Runs window).
 * Under the `md` breakpoint only one shows: the list, or, once a run is open, the run full width (its
 * pane carries the back button).
 */
export function RunsSplit({ open, list, pane }: { open: boolean; list: ReactNode; pane: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border" data-testid="runs-split" data-open={open}>
      <div className={cn('flex min-h-0 w-full flex-col md:w-[26rem] md:shrink-0 md:border-r md:border-border', open && 'max-md:hidden')} data-testid="runs-list">
        {list}
      </div>
      <div className={cn('min-h-0 min-w-0 flex-1 p-4', !open && 'max-md:hidden')} data-testid="runs-pane">
        {pane}
      </div>
    </div>
  );
}
