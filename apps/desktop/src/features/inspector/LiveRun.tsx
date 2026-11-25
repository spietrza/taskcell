import { useEffect, useRef, useState } from 'react';
import { StreamView } from './StreamView';
import { hub } from '../../transport';
import { cn } from '@/ui';
import { FlowLine } from './RunDetail';
import { foldRunEvents } from './runStages';
import { readRunEvents } from '../../ipc';
import type { ActiveRun, SessionRead } from '../../taskcell-output';

export function LiveRun({
  active,
  repo,
  refreshKey,
  budgetUsd,
}: {
  active: ActiveRun;
  /** The run's repository: its event log is read from there. */
  repo: string;
  refreshKey: number;
  /** Budget cap from the project's .taskcell/app.json; when set, the strip shows spend vs cap.
   *  Nullable like the config field — Rust's serde writes `null` for an absent `Option`. */
  budgetUsd?: number | null;
}) {
  const [data, setData] = useState<SessionRead | null>(null);
  // The live run's flow, from its event log (as the detail view reads it).
  const [flow, setFlow] = useState<string | undefined>();
  const [flowFailed, setFlowFailed] = useState(false);
  // The flow never changes once the run started: a tick re-reads the log only until it is known.
  const flowOf = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${repo}\0${active.taskId}`;
    if (flowOf.current === key) return;
    let alive = true;
    setFlowFailed(false);
    readRunEvents(repo, active.taskId)
      .then((r) => {
        const f = foldRunEvents(r.events).flow;
        if (!alive) return;
        flowOf.current = f === undefined ? undefined : key;
        setFlow(f);
      })
      .catch(() => alive && setFlowFailed(true));
    return () => {
      alive = false;
    };
  }, [repo, active.taskId, refreshKey]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    hub().call('read_session', { sessionFile: active.sessionFile })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active.sessionFile, refreshKey]);

  const entries = data?.entries ?? [];
  const turns = entries.filter((e) => e.role === 'assistant').length;
  const tools = entries.filter((e) => e.role === 'tool').length;
  const tok = data ? data.inputTokens + data.outputTokens : 0;
  const cost = data?.estCostUsd ?? 0;
  const cap = budgetUsd && budgetUsd > 0 ? budgetUsd : null;
  const pct = cap ? Math.min(100, (cost / cap) * 100) : null;
  const over = cap != null && cost > cap;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span
          className="font-medium text-foreground"
          title="Estimated spend so far — priced live from token usage; a lower bound (unpriced models excluded)"
        >
          ~${cost.toFixed(2)}
        </span>
        {cap != null && (
          <span
            className={cn('flex items-center gap-1.5', over && 'font-medium text-destructive')}
            title={`Budget cap $${cap.toFixed(2)} (from .taskcell/app.json)`}
          >
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full', over ? 'bg-destructive' : pct! >= 75 ? 'bg-warning' : 'bg-success')}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span>
              ${cost.toFixed(2)} / ${cap.toFixed(2)}
            </span>
          </span>
        )}
        <span className="text-border">·</span>
        <span>{turns} turns</span>
        <span>{tools} tools</span>
        {tok > 0 && (
          <span>
            {data!.inputTokens.toLocaleString()}/{data!.outputTokens.toLocaleString()} tok
          </span>
        )}
      </div>
      <FlowLine flow={flow} unavailable={flowFailed} />
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-4">
        <StreamView entries={entries} empty="Waiting for output…" />
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
