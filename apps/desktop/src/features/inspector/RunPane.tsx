import { useEffect, useRef, useState } from 'react';
import { Button, Chip } from '@/ui';
import { ArrowLeft, Clock, GitBranch, RefreshCw, Square } from 'lucide-react';
import { readRunEvents, readSession } from '../../ipc';
import { subscribe } from '../../transport';
import { ExternalLink, hostName } from '../../components/ExternalLink';
import { repoInitials, startedByLabel } from '../../runLabels';
import { RunDetail } from './RunDetail';
import { StageLine } from './StageLine';
import { foldRunEvents, fmtDuration, gateMs, stagesFromRecords, withGateSteps, withPendingGateSteps, toLogLines, transcriptLines, type LoggedEvent, type LogLine } from './runStages';
import type { ActiveRun, RunDetail as RunDetailT, SessionRead } from '../../taskcell-output';

/** The open run, for the Runs split view: header, stage line, log tail, and (finished) the full record below. */
export function RunPane({
  repo,
  repoName,
  taskId,
  title,
  issue,
  startedBy,
  detail,
  active,
  tick,
  onBack,
  onCancel,
}: {
  /** The repository the run belongs to (its path). */
  repo: string;
  repoName?: string | undefined;
  taskId: string;
  /** The task's title when the board knows it; the task id otherwise. */
  title?: string | undefined;
  issue?: number | undefined;
  startedBy?: string | undefined;
  /** A finished run's record. */
  detail?: RunDetailT | undefined;
  /** A running run (its session file is the live log). */
  active?: ActiveRun | undefined;
  /** Bumps when the project's files change: re-reads the persisted events and the session. */
  tick: number;
  /** Narrow screens: the way back to the list. */
  onBack: () => void;
  /** Cancels the hub run with this id (Inspector refuses it in the demo). */
  onCancel: (runId: string) => void;
}) {
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [session, setSession] = useState<SessionRead | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [picked, setPicked] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const tail = useRef<HTMLDivElement>(null);
  const live = active !== undefined;

  // The persisted event log: stage times and the hub's run id. Hub only: elsewhere the records alone drive the line.
  useEffect(() => {
    let alive = true;
    readRunEvents(repo, taskId, detail?.timestamp)
      .then((p) => alive && setEvents(p.events))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [repo, taskId, detail?.timestamp, tick, reload]);

  // Live: a hub event re-reads the log at once (the file watcher's tick is the backstop).
  useEffect(() => {
    if (!live) return;
    const un = subscribe('api:event', () => setReload((n) => n + 1));
    return () => void un.then((f) => f());
  }, [live]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    readSession(active.sessionFile)
      .then((d) => alive && setSession(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active?.sessionFile, tick, reload]);

  const timeline = foldRunEvents(events);
  const running = live && timeline.terminal === undefined;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // The sealed cell is no stage record: its card comes from the event log (a run logged before it existed has none), live and finished alike.
  const sealed = timeline.stages[0]?.name === 'sandbox' ? timeline.stages.slice(0, 1) : [];
  const stages = detail ? [...sealed, ...withGateSteps(stagesFromRecords(detail.stages), detail.proof, detail.prUrl, gateMs(timeline.stages))] : timeline.stages.length > 0 ? withPendingGateSteps(timeline.stages) : timeline.stages;
  const lastSelectable = (() => {
    // Only a stage with a record has a log to open: the first failed one, else the last.
    const withLog = stages.flatMap((s, i) => (s.src !== undefined ? [i] : []));
    return withLog.find((i) => stages[i]!.phase === 'failed') ?? withLog[withLog.length - 1] ?? 0;
  })();
  const selected = picked !== null && picked < stages.length ? picked : lastSelectable;
  const lines: LogLine[] = detail ? transcriptLines(detail.stages[stages[selected]?.src ?? -1]?.transcript) : toLogLines(session?.entries ?? []);
  useEffect(() => {
    tail.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  const startedAt = timeline.startedAt;
  const totalMs = running
    ? startedAt !== undefined
      ? now - startedAt
      : undefined
    : startedAt !== undefined && timeline.endedAt !== undefined
      ? timeline.endedAt - startedAt
      : stages.some((s) => s.ms !== undefined)
        ? stages.reduce((n, s) => n + (s.ms ?? 0), 0)
        : undefined;

  const passed = detail && (detail.proof ? detail.proof.passed : !detail.stages.some((s) => !s.record.completed));
  const status = running ? (
    <Chip color="primary" variant="outlined">
      <span className="inline-flex items-center gap-1">
        <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        running
      </span>
    </Chip>
  ) : timeline.terminal === 'cancelled' ? (
    <Chip color="secondary" variant="outlined">cancelled</Chip>
  ) : timeline.terminal === 'error' || passed === false ? (
    <Chip color="destructive" variant="outlined">failed</Chip>
  ) : (
    <Chip color="success" variant="outlined">{detail?.prUrl !== undefined ? 'PR open' : 'passed'}</Chip>
  );
  const base = detail?.stages.find((s) => s.record.baseBranch !== undefined)?.record.baseBranch;
  const by = startedByLabel(startedBy ?? detail?.stages.find((s) => s.record.startedBy !== undefined)?.record.startedBy);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 max-md:overflow-y-auto" aria-label={`Run ${taskId}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Button variant="text" color="secondary" className="md:hidden" onClick={onBack} startIcon={<ArrowLeft className="size-4" />}>
          Back to runs
        </Button>
        <GitBranch className="size-4 text-muted-foreground" aria-hidden />
        {repoName !== undefined && <span className="text-muted-foreground">{repoName}</span>}
        {base !== undefined && (
          <>
            <span className="text-muted-foreground" aria-hidden>/</span>
            <code className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs" title="Target branch">{base}</code>
          </>
        )}
        {issue !== undefined && <span className="tabular-nums text-muted-foreground">#{issue}</span>}
        <span className="ml-auto flex items-center gap-2">
          {totalMs !== undefined && (
            <span className="flex items-center gap-1 font-mono text-xs tabular-nums" aria-label="Total time">
              <Clock className="size-3.5 text-muted-foreground" aria-hidden />
              {fmtDuration(totalMs)}
            </span>
          )}
          {status}
        </span>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-bold" aria-hidden>
          {repoInitials(repoName)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium max-md:basis-full" title={title ?? taskId}>{title ?? taskId}</span>
        {by !== undefined && <span className="text-xs text-muted-foreground">Started by {by}</span>}
        {running && timeline.runId !== undefined && (
          <Button variant="outlined" color="secondary" onClick={() => onCancel(timeline.runId!)} startIcon={<Square className="size-3.5" />}>
            Cancel
          </Button>
        )}
        {!running && detail?.prUrl !== undefined && <ExternalLink href={detail.prUrl}>{`Open in ${hostName(detail.prUrl)}`}</ExternalLink>}
      </div>

      {stages.length > 0 ? (
        <StageLine stages={stages} now={now} selected={detail && picked !== null ? selected : undefined} {...(detail ? { onSelect: setPicked } : {})} />
      ) : (
        <p className="text-sm text-muted-foreground">{running ? 'Waiting for the first stage…' : 'This run has no stage records.'}</p>
      )}

      <div className="max-h-56 shrink-0 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed" role="log" aria-label={running ? 'Live log' : 'Stage log'}>
        {lines.length === 0 ? (
          <span className="text-muted-foreground">{running ? 'Waiting for output…' : 'No transcript for this stage.'}</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={l.cmd ? '' : 'text-muted-foreground'}>
              {l.cmd && <b className="mr-2">$</b>}
              <span className="break-words">{l.text}</span>
            </div>
          ))
        )}
        <div ref={tail} />
      </div>

      {detail && (
        <div className="max-md:shrink-0 md:min-h-0 md:flex-1">
          <RunDetail detail={detail} project={repo} />
        </div>
      )}
    </section>
  );
}
