import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Tabs } from '@/ui';
import { ArrowLeft, Clock, GitBranch, RefreshCw, Square } from 'lucide-react';
import { readSession, tailRunEvents } from '../../ipc';
import type { RunTail } from '../../../../../packages/hub-client/src/runTail';
import { ExternalLink, hostName, issueUrl } from '../../components/ExternalLink';
import { AgentQuestion } from '../../components/AgentQuestion';
import { askedOf, cardIdOf, repoInitials, runStateTone, runStateWord, startedByLabel } from '../../runLabels';
import { detailOutcome, runStationOf } from '../../stations';
import { costLabel, estLabel } from '../../cost';
import { liveStage, liveStations, stepsAt } from '../board/stageLine';
import { StreamView } from './StreamView';
import { RunDetail } from './RunDetail';
import { StageLine } from './StageLine';
import { RunReceipt, StationTrack } from './RunReceipt';
import { CardAnswer } from '../needs-you/CardAnswer';
import { foldRunEvents, fmtDuration, gateMs, stagesFromRecords, withGateSteps, withPendingGateSteps, toLogLines, type LoggedEvent, type LogLine } from './runStages';
import type { ActiveRun, RunDetail as RunDetailT, RunSummary, SessionRead } from '../../taskcell-output';

/** The open run, for the Runs split view, receipt first (v3): header, the six stations, the receipt, then what the factory did / Diff / Transcript. */
export function RunPane({
  repo,
  repoName,
  initials,
  taskId,
  title,
  issue,
  issueHref: taskHref,
  startedBy,
  summary,
  detail,
  active,
  tick,
  onBack,
  onCancel,
  onAnswered,
}: {
  /** The card's question was answered here: the caller follows the run that answer starts. */
  onAnswered?: (() => void) | undefined;
  /** The repository the run belongs to (its path). */
  repo: string;
  repoName?: string | undefined;
  /** The avatar's letters as the Runs rows show them (projects sharing a name prefix read apart). */
  initials?: string | undefined;
  taskId: string;
  /** The task's title when the board knows it; the task id otherwise. */
  title?: string | undefined;
  issue?: number | undefined;
  /** The card's own address in its tracker (the board's task url), when known. */
  issueHref?: string | undefined;
  startedBy?: string | undefined;
  /** The run's row in the runs list: its state word and cost come from there, one source with the list. */
  summary?: RunSummary | undefined;
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
  const tail = useRef<HTMLDivElement>(null);
  const live = active !== undefined;

  // The persisted event log: stage times and the hub's run id. Hub only: elsewhere the records alone drive the line.
  // Paged to its end and, for a live run, followed: it reads again only on a hub event of this run (the tick is the backstop).
  const tailing = useRef<RunTail | undefined>(undefined);
  // The run's activity time when the pane opened: it moves with every session write, and a restarted tail would re-read from 0.
  const activeSince = useRef(active?.lastActivityMs);
  useEffect(() => {
    const t = tailRunEvents(
      { repoPath: repo, taskId, timestamp: detail?.timestamp, activeSince: activeSince.current, follow: live },
      { onEvents: setEvents, onEnd: () => {}, onError: () => {} },
    );
    tailing.current = t;
    return t;
  }, [repo, taskId, detail?.timestamp, live]);
  const seenTick = useRef(tick);
  useEffect(() => {
    if (seenTick.current !== tick) tailing.current?.refresh();
    seenTick.current = tick;
  }, [tick]);

  useEffect(() => {
    // A run listed from its launch has no session file yet: its stage line comes from the event log alone.
    if (!active || active.sessionFile === '') return;
    let alive = true;
    readSession(active.sessionFile)
      .then((d) => alive && setSession(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active?.sessionFile, tick, events.length]);

  const timeline = foldRunEvents(events);
  const [tab, setTab] = useState('activity');
  const running = live && timeline.terminal === undefined;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // The sealed cell is no stage record: its card comes from the event log (a run logged before it existed has none), live and finished alike.
  const sealed = timeline.stages[0]?.name === 'sandbox' ? timeline.stages.slice(0, 1) : [];
  const stages = detail ? [...sealed, ...withGateSteps(stagesFromRecords(detail.stages), detail.proof, detail.prUrl, gateMs(timeline.stages))] : timeline.stages.length > 0 ? withPendingGateSteps(timeline.stages) : timeline.stages;
  const liveAt = liveStage(stages);
  // A finished run shows its transcripts in the Transcript tab; the log tail is the live run's.
  const lines: LogLine[] = detail ? [] : toLogLines(session?.entries ?? []);
  useEffect(() => {
    // Scroll the log box only, not the page around it.
    if (tail.current) tail.current.scrollTop = tail.current.scrollHeight;
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

  // One state for the chip's word and its colour: the Runs row's (its summary), else the record read the same way.
  // The Runs row carries the outcome; only the record says the gates passed (the receipt reads the same proof).
  const outcome = summary !== undefined ? { ...summary, ...(detail?.proof?.passed === true ? { verifyPassed: true as const } : {}) } : detail !== undefined ? detailOutcome(detail) : undefined;
  const word = running ? 'running' : timeline.terminal === 'cancelled' ? 'cancelled' : timeline.terminal === 'error' ? 'failed' : outcome !== undefined ? runStateWord(outcome) : 'passed';
  const status = (
    <Chip color={runStateTone(word)} variant="outlined">
      {running ? (
        <span className="inline-flex items-center gap-1">
          <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          running
        </span>
      ) : (
        word
      )}
    </Chip>
  );
  const merged = summary?.prState === 'merged';
  const asked = running ? undefined : askedOf(summary, detail);
  // The header carries the run's only issue link and only PR link.
  const prUrl = running ? undefined : detail?.prUrl;
  const prNumber = prUrl === undefined ? undefined : /(\d+)\/?$/.exec(prUrl)?.[1];
  const issueHref = taskHref ?? (prUrl !== undefined && issue !== undefined ? issueUrl(prUrl, issue) : undefined);
  const base = detail?.stages.find((s) => s.record.baseBranch !== undefined)?.record.baseBranch;
  const by = startedByLabel(startedBy ?? detail?.stages.find((s) => s.record.startedBy !== undefined)?.record.startedBy);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto" aria-label={`Run ${taskId}`}>
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
        {/* The card id, as the Board names the card (gh-27, hub-4). */}
        {issueHref !== undefined ? (
          <ExternalLink href={issueHref} className="font-mono text-sm">{cardIdOf(taskId)}</ExternalLink>
        ) : (
          <span className="font-mono text-muted-foreground">{cardIdOf(taskId)}</span>
        )}
        {prUrl !== undefined && (
          <ExternalLink href={prUrl} className="rounded-full border border-border px-2 py-0.5 text-sm tabular-nums">
            {`${hostName(prUrl) === 'GitLab' ? 'MR !' : 'PR #'}${prNumber ?? ''}`}
          </ExternalLink>
        )}
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
          {initials ?? repoInitials(repoName)}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium max-md:basis-full md:truncate" title={title ?? taskId}>{title ?? taskId}</span>
        {by !== undefined && <span className="text-xs text-muted-foreground">Started by {by}</span>}
        {running && timeline.runId !== undefined && (
          <Button variant="outlined" color="secondary" onClick={() => onCancel(timeline.runId!)} startIcon={<Square className="size-3.5" />}>
            Stop run
          </Button>
        )}
      </div>

      {asked !== undefined && (
        <div role="note" className="shrink-0 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <div className="font-medium text-warning-text">Stopped to ask you: the agent ended before finishing and waits for your answer below.</div>
          {/* The run's own agent question: light markdown, no images, http(s) links only. */}
          <div className="mt-1 max-h-40 overflow-y-auto break-words text-muted-foreground"><AgentQuestion>{asked}</AgentQuestion></div>
          <div className="mt-2"><CardAnswer project={repo} taskId={taskId} onReplied={onAnswered} /></div>
        </div>
      )}
      <StationTrack
        steps={detail && outcome !== undefined ? stepsAt(runStationOf(outcome)) : liveStations(liveAt, timeline.terminal === 'error')}
        ctx={detail ? { task: { column: merged ? 'done' : 'review' }, detail, merged, ...(detail.prUrl !== undefined ? { prUrl: detail.prUrl } : {}) } : { task: { column: 'running', ...(liveAt !== undefined ? { stage: liveAt } : {}) } }}
      />
      {/* Two columns only when the pane itself is wide enough (a container query, not the window): beside the run list
          a 1024 px window leaves the pane too narrow for the tabs and the receipt side by side. Stacked, it scrolls. */}
      <div className="@container min-h-0 md:min-h-[32rem] md:flex-1 md:overflow-y-auto">
        <div className="flex flex-col gap-3 @3xl:grid @3xl:h-full @3xl:min-h-0 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:items-start">
          <div className="@3xl:order-2 @3xl:max-h-full @3xl:overflow-y-auto">
            {detail ? (
              <RunReceipt detail={detail} project={repo} merged={merged} cost={summary !== undefined ? costLabel(summary) : undefined} />
            ) : (
              <RunReceipt detail={{ taskId, timestamp: '', stages: [] }} project={repo} merged={false} cost={estLabel(session?.estCostUsd)} live />
            )}
          </div>
          <div className="shrink-0 @3xl:order-1 @3xl:h-full @3xl:min-h-0">
            {detail ? (
              <RunDetail detail={detail} project={repo} prLink={false} steps={stages} />
            ) : (
              <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))} className="flex h-full min-h-0 flex-col">
                <Tabs.List className="shrink-0 overflow-x-auto">
                  <Tabs.Tab value="activity" className="whitespace-nowrap">What the factory did</Tabs.Tab>
                  <Tabs.Tab value="diff" className="whitespace-nowrap">Diff</Tabs.Tab>
                  <Tabs.Tab value="transcript" className="whitespace-nowrap">Transcript</Tabs.Tab>
                  <Tabs.Indicator />
                </Tabs.List>
                <Tabs.Panel value="activity" className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-4">
                  {stages.length > 0 ? (
                    <StageLine stages={stages} now={now} list />
                  ) : (
                    <p className="text-sm text-muted-foreground">{running ? 'Waiting for the first stage…' : 'This run has no stage records.'}</p>
                  )}
                  <div ref={tail} className="max-h-56 shrink-0 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed" role="log" aria-label={running ? 'Live log' : 'Stage log'}>
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
                  </div>
                </Tabs.Panel>
                <Tabs.Panel value="diff" className="min-h-0 flex-1 overflow-y-auto pt-4">
                  <p className="text-sm text-muted-foreground">No diff yet: the cell is still working. It shows here when the run finishes.</p>
                </Tabs.Panel>
                <Tabs.Panel value="transcript" className="min-h-0 flex-1 overflow-y-auto pt-4">
                  <div className="rounded border border-border bg-muted/30 p-4">
                    <StreamView entries={session?.entries ?? []} empty="No output yet." />
                  </div>
                </Tabs.Panel>
              </Tabs.Root>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
