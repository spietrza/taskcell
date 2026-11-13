import { Button, Chip } from '@/ui';
import { RefreshCw, Square } from 'lucide-react';
import type { TypedRunState } from './typedRunReducer';

/** Renders the folded typed-run state: stage progress row, live spend, terminal. */
export function RunStrip({ state, onCancel }: { state: TypedRunState; onCancel: () => void }) {
  const { stages, stageState, usdSpent, warnings, terminal } = state;
  // A queued run that ended (e.g. cancelled while waiting) never started: the terminal chip below says how it ended.
  const queued = state.queuedPosition !== undefined && terminal === undefined;
  const label = queued
    ? `queued — #${state.queuedPosition} in line`
    : (state.taskId ?? (terminal !== undefined ? 'not started' : 'starting…'));
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {/* A run still waiting in the queue (or that ended there) has spent nothing yet. */}
        {state.queuedPosition === undefined && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">~${usdSpent.toFixed(2)}</span>
        )}
        {/* No Stop before the run has an id ("starting…"): the hub cancels by id only. */}
        {terminal === undefined && state.runId !== undefined && (
          <Button
            variant="text"
            color="destructive"
            className={state.queuedPosition === undefined ? undefined : 'ml-auto'}
            onClick={onCancel}
            startIcon={<Square className="size-3.5" />}
          >
            Stop
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {stages.map((name, i) => {
          const phase = stageState[i] ?? 'pending';
          return (
            <span
              key={i}
              data-testid={`stage-${i}`}
              data-phase={phase}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                phase === 'done'
                  ? 'border-success text-success-text'
                  : phase === 'failed'
                    ? 'border-destructive text-destructive-text'
                    : phase === 'running'
                      ? 'border-foreground text-foreground'
                      : 'border-border text-muted-foreground opacity-60'
              }`}
            >
              {phase === 'running' && terminal === undefined && (
                <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              )}
              {name}
            </span>
          );
        })}
      </div>
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((message, i) => (
            <div
              key={i}
              data-testid="run-warning"
              className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-text"
            >
              {message}
            </div>
          ))}
        </div>
      )}
      {terminal !== undefined && (
        <div className="text-xs">
          {terminal.kind === 'success' && terminal.prUrl !== undefined && (
            <a href={terminal.prUrl} className="text-primary-text underline">
              View PR
            </a>
          )}
          {terminal.kind === 'no-changes' && (
            <Chip color="secondary" variant="outlined">
              no PR (no changes)
            </Chip>
          )}
          {terminal.kind === 'secret-blocked' && (
            <Chip color="destructive" variant="outlined">
              secret-blocked
            </Chip>
          )}
          {terminal.kind === 'error' && (
            <Chip color="destructive" variant="outlined">
              error: {terminal.message}
            </Chip>
          )}
          {terminal.kind === 'cancelled' && (
            <Chip color="secondary" variant="outlined">
              cancelled
            </Chip>
          )}
        </div>
      )}
    </div>
  );
}
