import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { Button, LINK_CLASS, Timestamp, cn } from '@/ui';
import { Check, Circle, CircleDot, Play, X } from 'lucide-react';
import { apiSetTaskSkills, fetchSpec, hubTaskStart, listNeedsYou, listRuns, readRun, type NeedsYouItem } from '../../ipc';
import { errorMessage } from '../../errors';
import { useAppConfig, useAsync } from '../../hooks';
import { isDemoLink } from '../../transport';
import type { BoardTask, RepoStamp, RunDetail, RunSummary } from '../../wire';
import { STATION_SHORT, cardStationOf } from '../../stations';
import { taskSourceLabel } from '../../platform';
import { costLabel, estTitle } from '../../cost';
import { ASKED_WORDS, NEEDS_YOU_CHIP, startedByLabel } from '../../runLabels';
import { verdictWord } from '../../status';
import { AgentText } from '../../components/AgentText';
import { ExternalLink, hostName } from '../../components/ExternalLink';
import { MergeButton, ReplyBox } from '../needs-you/NeedsYou';
import { PausedPanel } from './paused';
import { receipt } from './receipt';
import { SkillPicker } from './SkillPicker';
import { repairAttempts, repairCap, stepsAt, type StageStatus } from './stageLine';
import { diffStat, stationNote, stationState } from './stationNotes';
import { taskRefKey } from './taskref';
import { ScheduleEditor, ScheduleLines } from './Schedule';

/** A paused pull request's card (`gh-pr-N`): it is not an issue, so the issue-only actions (skills, full page) are not offered. */
export const isPullRequestCard = (id: string): boolean => /^gh-pr-\d+$/i.test(id);
/** A hub-board task's card (`hub-N`): its skills are stored on the task itself. */
const isHubTaskCard = (id: string): boolean => /^hub-[1-9]\d*$/.test(id);
export const isInvalidHubCard = (id: string): boolean => id === 'hub-invalid';

export const TRACKER_NAME = { github: taskSourceLabel('github'), gitlab: taskSourceLabel('gitlab'), linear: taskSourceLabel('linear') } as const;

/** The board's column names: the Board's headers and the quick view's status share them. */
export const COLUMN_LABEL: Record<BoardTask['column'], string> = {
  queued: 'Queued',
  claimed: 'Claimed',
  running: 'Running',
  'verify-failed': 'Verify failed',
  review: 'Review',
  done: 'Done',
};

export type QuickTask = BoardTask & Partial<RepoStamp>;

/** Why a waiting card waits, in plain words: a pull request to merge, or a question from the factory. */
export function waitingWhy(item: Pick<NeedsYouItem, 'kind'>): string {
  return item.kind === 'pr' ? 'Pull request ready' : 'Question for you';
}

/**
 * The needs-you item that is THIS card: its pull request (same address), or — for a GitHub card only,
 * where issue numbers are the tracker's own — the issue with the card's number. Never by number alone
 * across trackers: a Linear card's digits can equal an unrelated GitHub issue's.
 */
export function matchNeedsYou(items: NeedsYouItem[], task: Pick<BoardTask, 'id' | 'source'>, prUrl: string | undefined): NeedsYouItem | null {
  const m = /(\d+)$/.exec(taskRefKey(task.id));
  const number = m && !isPullRequestCard(task.id) ? Number(m[1]) : undefined;
  return (
    items.find((i) =>
      i.kind === 'card' ? i.id === taskRefKey(task.id)
      : i.kind === 'pr' ? prUrl !== undefined && i.url === prUrl : task.source === 'github' && number !== undefined && i.number === number,
    ) ?? null
  );
}

// Orange (primary) is reserved for the needs-you chip; current is plain ink, failed is red.
const DOT: Record<StageStatus, string> = {
  done: 'text-success-text',
  current: 'text-foreground',
  waiting: 'text-muted-foreground/50',
  failed: 'text-destructive-text',
};
const FACT_TONE = { pass: '', fail: 'text-destructive-text', none: 'text-muted-foreground' } as const;
const HEADING = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';
/** A description longer than this folds behind "Show all". */
const LONG_SPEC = 600;

type RunState = { runs: RunSummary[]; detail?: RunDetail };

/** A titled block of the panel body. */
function Section({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={label} className={cn('space-y-2', className)}>
      <h3 className={HEADING}>{label}</h3>
      {children}
    </section>
  );
}

/** One row of the Details box. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * The card's skills: tick the installed ones, Save writes them to the task as its `Skills:` line
 * (through the tracker, so a run started from CI or `watch` sees them too).
 */
function CardSkills({ task, repoPath, onSaved, onOpenSkills }: { task: QuickTask; repoPath: string; onSaved?: ((skills: string[]) => void) | undefined; onOpenSkills?: (() => void) | undefined }) {
  const [saved, setSaved] = useState(task.skills ?? []);
  const [skills, setSkills] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = skills.length !== saved.length || skills.some((s) => !saved.includes(s));
  const save = (): void => {
    setBusy(true);
    setError(null);
    apiSetTaskSkills(repoPath, task.id, skills)
      .then((r) => {
        setSaved(r.skills);
        setSkills(r.skills);
        onSaved?.(r.skills);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const empty = (
    <span className="text-xs text-muted-foreground">
      None installed
      {onOpenSkills && (
        <>
          {' · '}
          <button type="button" onClick={onOpenSkills} className={LINK_CLASS}>
            Settings → Skills
          </button>
        </>
      )}
    </span>
  );
  return (
    <section aria-label="Skills" className="space-y-1.5">
      <SkillPicker project={repoPath} value={skills} onChange={setSkills} disabled={busy} empty={empty} />
      {dirty && (
        <Button variant="outlined" disabled={busy} onClick={save}>
          Save skills
        </Button>
      )}
      {error !== null && <div role="alert" className="break-words text-xs text-destructive-text">{error}</div>}
    </section>
  );
}

/** The card's issue body, as the full page renders it; a long one folds. */
function Description({ repoPath, taskId, title }: { repoPath: string; taskId: string; title: string }) {
  const { data: spec, error, loading } = useAsync(() => fetchSpec(repoPath, taskId), [repoPath, taskId]);
  const [all, setAll] = useState(false);
  if (loading) return <div className="text-sm text-muted-foreground">Loading description…</div>;
  if (error) return <div className="text-sm text-muted-foreground">Could not load the description. {error}</div>;
  // The header already shows the title: a leading heading that repeats it is dropped.
  const body = spec?.replace(/^\s*#{1,6}\s+(.*)\n?/, (line, heading: string) => (heading.trim() === title.trim() ? '' : line)).trim();
  if (!body) return <div className="text-sm text-muted-foreground">No description.</div>;
  const long = body.length > LONG_SPEC;
  return (
    <div>
      {/* A panel, not a page: the body's headings stay at reading size. */}
      <div className={cn('relative text-sm [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1,&_h2,&_h3]:mt-3 [&_h1,&_h2,&_h3]:mb-1', long && !all && 'max-h-48 overflow-hidden')}>
        <AgentText>{body}</AgentText>
        {long && !all && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background" />}
      </div>
      {long && (
        <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className={cn('mt-1 text-xs', LINK_CLASS)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** The card's detail panel: a drawer over the Board on desktop, a full-screen sheet on phones. No transcript or diff tabs. */
export function QuickView({
  task,
  project,
  onClose,
  onFullPage,
  onStartRun,
  onOpenRuns,
  onOpenSkills,
  onSkillsSaved,
  onChanged,
  ref,
}: {
  task: QuickTask;
  project: string;
  onClose: () => void;
  onFullPage: () => void;
  /** Opens the run form for this card; absent where runs cannot start from here. */
  onStartRun?: () => void;
  /** Opens the Runs screen, where the live run is. */
  onOpenRuns?: () => void;
  /** Opens Settings → Skills. */
  onOpenSkills?: () => void;
  /** The card's skills were written to its task. */
  onSkillsSaved?: (skills: string[]) => void;
  /** The task was edited: the board reloads. */
  onChanged?: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const repoPath = task.repoPath ?? project;
  const [run, setRun] = useState<RunState | null>(null);
  const [item, setItem] = useState<NeedsYouItem | null>(null);
  const [needsYouError, setNeedsYouError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [cfg, , cfgStatus] = useAppConfig(repoPath);

  // The run list is cheap; the latest record (stages, diffs) is read for the receipt and the station notes.
  useEffect(() => {
    let alive = true;
    setRun(null);
    const key = taskRefKey(task.id);
    void (async () => {
      try {
        const runs = (await listRuns(repoPath)).filter((r) => taskRefKey(r.taskId) === key);
        const latest = runs[0];
        const state: RunState = { runs };
        if (latest !== undefined && latest.source !== 'ci') {
          const detail = await readRun(repoPath, { source: { kind: 'local' }, taskId: latest.taskId, timestamp: latest.timestamp }).catch(() => undefined);
          if (detail !== undefined) state.detail = detail;
        }
        if (alive) setRun(state);
      } catch {
        if (alive) setRun({ runs: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [task.id, task.column, repoPath]);

  const latest = run?.runs[0];
  const prUrl = run?.detail?.prUrl ?? latest?.prUrl;
  // Name the link by what it opens ("PR #28"), not by the host: the id chip is already the issue link.
  const prLabel = (url: string): string => `${hostName(url) === 'GitLab' ? 'MR !' : 'PR #'}${/\/(\d+)\/?$/.exec(url)?.[1] ?? ''}`.replace(/[#!]$/, '');
  // Only cards that can wait for the user cost the hub's `gh` listing.
  const mayWait = task.column === 'queued' || task.column === 'review' || task.column === 'verify-failed';

  useEffect(() => {
    let alive = true;
    setItem(null);
    setNeedsYouError(false);
    // The pull request address comes from the run list; wait for it before matching a PR item.
    if (!mayWait || run === null) return;
    listNeedsYou(repoPath)
      .then((r) => {
        if (alive) setItem(matchNeedsYou(r.items, task, prUrl));
      })
      .catch(() => {
        if (alive) setNeedsYouError(true);
      });
    return () => {
      alive = false;
    };
  }, [task.id, repoPath, mayWait, run, prUrl, nonce]);

  // A finished card follows its newest run (the Runs row's own mapping); a live or waiting one its column.
  const lineOpts = { prExists: prUrl !== undefined, repairs: repairAttempts(run?.detail), maxRepairs: repairCap(run?.detail) };
  const steps = stepsAt(cardStationOf(task, latest?.source === 'ci' ? undefined : latest, lineOpts), lineOpts);
  const noteCtx = { task, ...(cfgStatus === 'ready' ? { cfg } : {}), ...(run?.detail ? { detail: run.detail } : {}), ...(prUrl !== undefined ? { prUrl } : {}), merged: latest?.prState === 'merged' };
  const facts = receipt(run?.detail, latest?.totalCostUsd);
  const repo = task.repoName ?? repoPath.split('/').filter(Boolean).pop() ?? repoPath;
  const reload = (): void => setNonce((n) => n + 1);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // A hub-board card is started through the hub scheduler (picks it up within ~15 s); other cards open the run form.
  const startRun = (): void => {
    if (!hubCard) return onStartRun?.();
    setStarting(true);
    setStartError(null);
    hubTaskStart(repoPath, task.id)
      .then(() => onChanged?.())
      .catch((e: unknown) => {
        setStartError(errorMessage(e));
        setStarting(false);
      });
  };
  const issueCard = !isPullRequestCard(task.id) && !isInvalidHubCard(task.id);
  const hubCard = isHubTaskCard(task.id);
  // A card that waits for an answer is answered (below), not re-run: spending must not look like the way on.
  const runnable = issueCard && (hubCard || onStartRun !== undefined) && (task.column === 'queued' || task.column === 'verify-failed') && task.asked !== true && item?.kind !== 'card';
  const implementer = run?.detail?.stages.find((s) => s.record.stage === 'implementer');
  const model = implementer?.record.model;
  const stat = diffStat(implementer?.diff);
  const branch = task.baseBranch ?? implementer?.record.baseBranch;

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={`Quick view: ${task.title}`}
      className={cn(
        'flex min-h-0 flex-col bg-background outline-none',
        'absolute inset-y-0 right-0 z-30 w-[32rem] max-w-full rounded-xl border border-border/60 shadow-xl',
        'max-md:fixed max-md:inset-0 max-md:z-50 max-md:w-auto max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <header className="shrink-0 border-b border-border/60 px-4 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span className="max-w-[12rem] truncate rounded bg-muted px-1.5 py-0.5" title={repo}>{repo}</span>
            {task.url !== undefined && !isDemoLink(task.url) ? (
              <a href={task.url} target="_blank" rel="noreferrer" className={cn('shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', LINK_CLASS)}>
                {task.id}
              </a>
            ) : (
              <span className="shrink-0">{task.id}</span>
            )}
            {task.asked === true ? (
              <span data-column={task.column} className={cn('shrink-0 font-sans', NEEDS_YOU_CHIP)}>{ASKED_WORDS}</span>
            ) : (
              <span data-column={task.column} className={cn('shrink-0 rounded px-1.5 py-0.5 font-sans', task.column === 'verify-failed' ? 'bg-destructive/15 text-destructive-text' : task.column === 'done' ? 'bg-success/15 text-success-text' : 'bg-muted text-foreground')}>
                {COLUMN_LABEL[task.column]}
              </span>
            )}
          </div>
          <button type="button" aria-label="Close quick view" onClick={onClose} className="-mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <h2 className="mt-2 text-base font-semibold leading-snug text-balance">{task.title}</h2>
      </header>

      {/* The action row stays under the header while the body scrolls. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        {runnable && (
          <Button disabled={starting} onClick={startRun} startIcon={<Play className="size-4" />}>
            {starting ? 'Starting…' : 'Start run'}
          </Button>
        )}
        {startError !== null && <div role="alert" className="w-full break-words text-xs text-destructive-text">{startError}</div>}
        {(task.column === 'running' || task.column === 'claimed') && (
          <span role="status" className="flex items-center gap-2 text-sm">
            <span className="size-2 animate-pulse rounded-full bg-foreground" aria-hidden />
            {task.column === 'claimed' ? 'Claimed by the factory' : `Running${task.stage ? ` · ${task.stage}` : ''}`}
          </span>
        )}
        {(task.column === 'running' || task.column === 'claimed') && onOpenRuns && (
          <button type="button" onClick={onOpenRuns} className={cn('text-xs', LINK_CLASS)}>
            Open the run
          </button>
        )}
        {item?.kind === 'pr' && <MergeButton project={repoPath} item={item} onMerged={reload} />}
        {prUrl !== undefined && <ExternalLink href={prUrl}>{prLabel(prUrl)}</ExternalLink>}
        {issueCard && (
          <Button className="ml-auto" variant="outlined" onClick={onFullPage}>
            Full page
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4">
        <PausedPanel repoPath={repoPath} task={task} onRetried={onChanged} />
        {needsYouError && <div className="text-xs text-muted-foreground">Could not check whether this card waits for you.</div>}
        {item !== null && (
          <div className="space-y-2">
            {/* The one orange thing here: the card waits for the user. */}
            <span className="inline-block rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary-text">
              Needs you · {waitingWhy(item)}
            </span>
            {item.lastComment && <div className="break-words rounded bg-muted/40 px-3 py-2 text-sm"><AgentText>{item.lastComment.body}</AgentText></div>}
            <ReplyBox project={repoPath} item={item} onReplied={reload} />
          </div>
        )}

        <Section label="Progress">
          <ol aria-label="Stage line">
            {steps.map((s, i) => {
              const state = stationState(s, task.column);
              const note = stationNote(s, noteCtx);
              const last = i === steps.length - 1;
              return (
                <li key={s.key} data-status={s.status} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3">
                  <div className="flex flex-col items-center">
                    {s.status === 'done' ? (
                      <Check className={cn('mt-0.5 size-4', DOT.done)} aria-hidden />
                    ) : s.status === 'waiting' ? (
                      <Circle className={cn('mt-0.5 size-4', DOT.waiting)} aria-hidden />
                    ) : (
                      <CircleDot className={cn('mt-0.5 size-4', DOT[s.status], state === 'running' && 'animate-pulse')} aria-hidden />
                    )}
                    {!last && <span aria-hidden className={cn('my-1 w-px flex-1', s.status === 'done' ? 'bg-success-text/40' : 'bg-border')} />}
                  </div>
                  <div className={cn('min-w-0', !last && 'pb-3')}>
                    <div className="flex items-baseline gap-2">
                      <span className={cn('text-sm', s.status === 'current' && 'font-medium', s.status === 'waiting' && 'text-muted-foreground', s.status === 'failed' && 'font-medium text-destructive-text')}>
                        {STATION_SHORT[s.key]}
                      </span>
                      <span className={cn('ml-auto text-[11px]', state === 'failed' ? 'text-destructive-text' : 'text-muted-foreground')}>{state}</span>
                    </div>
                    {note !== '' && <div className="break-words text-xs text-muted-foreground">{note}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </Section>

        {issueCard && (
          <Section label="Description">
            <Description repoPath={repoPath} taskId={task.id} title={task.title} />
          </Section>
        )}

        <Section label="Details">
          <dl className="divide-y divide-border/50">
            <Field label="Project"><span className="block truncate" title={repoPath}>{repo}</span></Field>
            <Field label="Source">{task.source !== undefined ? TRACKER_NAME[task.source] : isHubTaskCard(task.id) || isInvalidHubCard(task.id) ? taskSourceLabel('hub') : 'none'}</Field>
            {branch !== undefined && <Field label="Target branch"><span className="font-mono text-xs">{branch}</span></Field>}
            {task.labels !== undefined && task.labels.length > 0 && <Field label="Labels">{task.labels.join(', ')}</Field>}
            {(task.source !== undefined || isHubTaskCard(task.id)) && !isPullRequestCard(task.id) && (
              <Field label="Skills">
                <CardSkills key={`${repoPath}:${task.id}`} task={task} repoPath={repoPath} onSaved={onSkillsSaved} onOpenSkills={onOpenSkills} />
              </Field>
            )}
          </dl>
          {task.schedule !== undefined && !isInvalidHubCard(task.id) && onChanged !== undefined ? (
            <ScheduleEditor repoPath={repoPath} task={task} onSaved={onChanged} />
          ) : (
            (!!task.blockedBy?.length || task.startDate !== undefined || isInvalidHubCard(task.id)) && (
              <section aria-label="Schedule" className="mt-3 space-y-1 border-t border-border/50 pt-3">
                <h4 className={HEADING}>Schedule</h4>
                <ScheduleLines task={task} />
              </section>
            )
          )}
        </Section>

        <Section label="Latest run">
          {run === null ? (
            <div className="text-sm text-muted-foreground">Loading runs…</div>
          ) : latest === undefined ? (
            <div className="text-sm text-muted-foreground">No runs yet.</div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className={cn('font-medium', latest.anyFailed && !latest.stoppedBy && 'text-destructive-text')}>
                  {latest.stoppedBy ? 'stopped: provider limit' : verdictWord(!latest.anyFailed)}
                </span>
                {/* With a record the receipt below carries the cost. */}
                {run.detail === undefined && <span className="tabular-nums text-muted-foreground" {...estTitle(costLabel(latest))}>{costLabel(latest)}</span>}
                {stat !== undefined && <span className="tabular-nums text-muted-foreground">{stat}</span>}
                {model !== undefined && <span className="font-mono text-xs text-muted-foreground">{model}</span>}
              </div>
              {run.detail !== undefined && (
                <dl aria-label="Receipt" className="grid grid-cols-2 gap-2">
                  {facts.map((f) => (
                    <div key={f.key} className="rounded border border-border/60 px-2 py-1.5">
                      <dt className="text-[11px] text-muted-foreground">{f.label}</dt>
                      <dd className={cn('text-sm', FACT_TONE[f.tone])}>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          )}
        </Section>

        {run !== null && run.runs.length > 0 && (
          <Section label="Activity">
            <ol className="space-y-1.5">
              {run.runs.map((r) => (
                <li key={r.timestamp} className="flex items-baseline gap-2 text-xs">
                  <Timestamp ms={Date.parse(r.timestamp)} className="w-20 shrink-0 tabular-nums text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    Run {r.stoppedBy ? 'stopped: provider limit' : verdictWord(!r.anyFailed)}
                    {/* A person only: the hub's shared token, the local worker and `watch` are not anyone. */}
                    {startedByLabel(r.startedBy) !== undefined && <span className="text-muted-foreground"> · by {startedByLabel(r.startedBy)}</span>}
                    {r.prState === 'merged' && <span className="text-muted-foreground"> · merged</span>}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{costLabel(r)}</span>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>
    </aside>
  );
}
