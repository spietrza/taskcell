import { Fragment } from 'react';
import { cn } from '@/ui';
import { AlertCircle, CheckCircle2, Circle, CircleDot } from 'lucide-react';
import { fmtDuration, stageLabel, type PaneStage } from './runStages';

const ICON = {
  done: <CheckCircle2 className="size-4 shrink-0 text-success-text" aria-hidden />,
  failed: <AlertCircle className="size-4 shrink-0 text-destructive-text" aria-hidden />,
  running: <CircleDot className="size-4 shrink-0 text-primary-text" aria-hidden />,
  pending: <Circle className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />,
} as const;

/**
 * The run's stages in a line, one card each: name, its own duration, the running one highlighted with a
 * progress bar, pending ones muted. `now` ticks the running stage's time; `onSelect` makes finished cards pickable.
 * `list` stacks them as rows (the run page's activity list) instead of a line of cards.
 */
export function StageLine({ stages, now, selected, onSelect, list = false }: { stages: PaneStage[]; now: number; selected?: number; onSelect?: (i: number) => void; list?: boolean }) {
  return (
    <ol className={list ? 'flex shrink-0 flex-col gap-1.5' : 'flex shrink-0 items-stretch overflow-x-auto pb-1'} aria-label="Stages">
      {stages.map((s, i) => {
        const label = s.label ?? stageLabel(s.name);
        const time =
          s.note !== undefined ? s.note :
          s.phase === 'running' && s.startedAt !== undefined ? fmtDuration(now - s.startedAt) : s.ms !== undefined ? fmtDuration(s.ms) : s.phase === 'pending' ? 'Waiting' : '—';
        const pickable = onSelect !== undefined && s.src !== undefined && s.phase !== 'pending' && s.phase !== 'running';
        const body = (
          <>
            <span className="flex items-start gap-2">
              <span className="flex h-5 items-center">{ICON[s.phase]}</span>
              <span className="min-w-0 text-sm font-medium leading-5 [overflow-wrap:anywhere]">{label}</span>
            </span>
            <span className={list ? 'absolute top-2 right-3 text-sm tabular-nums' : 'mt-1 block pl-6 text-sm tabular-nums'}>
              {s.href !== undefined ? <a href={s.href} target="_blank" rel="noreferrer" className="text-primary-text underline">{time}</a> : time}
            </span>
            {s.phase === 'running' && (
              <span className="mt-2 block h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${label} in progress`}>
                <span className="block h-full w-1/3 animate-[stage-run_1.6s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:animate-none motion-reduce:w-1/2" />
              </span>
            )}
          </>
        );
        const cls = cn(
          'flex min-w-24 flex-1 flex-col justify-start rounded-lg border text-left',
          list ? 'relative px-3 py-2' : 'p-3',
          s.phase === 'running' ? 'border-primary bg-primary/5 text-foreground' : s.phase === 'pending' ? 'border-border/60 text-muted-foreground' : 'border-border',
          s.phase === 'failed' && 'border-destructive/50',
          selected === i && s.phase !== 'running' && 'border-foreground/60 bg-muted/40',
          pickable && 'cursor-pointer hover:bg-muted/40',
        );
        return (
          <Fragment key={i}>
            {i > 0 && !list && <li aria-hidden className="w-3 shrink-0 self-center border-t border-border" />}
            <li data-testid={`stage-${i}`} data-phase={s.phase} className="flex min-w-24 flex-1">
              {pickable ? (
                <button type="button" className={cls} aria-pressed={selected === i} onClick={() => onSelect(i)}>
                  {body}
                </button>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
