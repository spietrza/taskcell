import { useEffect, useState, type Ref } from 'react';
import { Button, cn } from '@/ui';
import { Check, Circle, CircleDot, X } from 'lucide-react';
import { listNeedsYou, listRuns, readRun, type NeedsYouItem } from '../../ipc';
import type { BoardTask, RepoStamp, RunDetail } from '../../wire';
import { ExternalLink, hostName } from '../../components/ExternalLink';
import { MergeButton, ReplyBox, canUseNeedsYou } from '../needs-you/NeedsYou';
import { receipt } from './receipt';
import { repairAttempts, stageLine, type StageStatus } from './stageLine';
import { taskRefKey } from './taskref';

export const TRACKER_NAME = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear' } as const;

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
  const number = m ? Number(m[1]) : undefined;
  return (
    items.find((i) =>
      i.kind === 'pr' ? prUrl !== undefined && i.url === prUrl : task.source === 'github' && number !== undefined && i.number === number,
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

type RunState = { prUrl?: string; totalCostUsd?: number; detail?: RunDetail };

/** The card's quick view: side panel beside the Board, a bottom drawer on phones. No transcript or diff tabs. */
export function QuickView({
  task,
  project,
  onClose,
  onFullPage,
  ref,
}: {
  task: QuickTask;
  project: string;
  onClose: () => void;
  onFullPage: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const repoPath = task.repoPath ?? project;
  const [run, setRun] = useState<RunState | null>(null);
  const [item, setItem] = useState<NeedsYouItem | null>(null);
  const [needsYouError, setNeedsYouError] = useState(false);
  const [nonce, setNonce] = useState(0);

  // The run list is cheap; the full record (stages, diffs) is read only when a pull request exists
  // (the receipt) or the card is running (repair attempts).
  useEffect(() => {
    let alive = true;
    setRun(null);
    const key = taskRefKey(task.id);
    void (async () => {
      try {
        const summary = (await listRuns(repoPath)).find((r) => taskRefKey(r.taskId) === key);
        if (summary === undefined) return void (alive && setRun({}));
        const state: RunState = { prUrl: summary.prUrl, totalCostUsd: summary.totalCostUsd };
        if (summary.prUrl !== undefined || task.column === 'running') {
          state.detail = await readRun(repoPath, { source: { kind: 'local' }, taskId: summary.taskId, timestamp: summary.timestamp }).catch(() => undefined);
        }
        if (alive) setRun(state);
      } catch {
        if (alive) setRun({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [task.id, task.column, repoPath]);

  const prUrl = run?.detail?.prUrl ?? run?.prUrl;
  // Only cards that can wait for the user cost the hub's `gh` listing.
  const mayWait = task.column === 'queued' || task.column === 'review' || task.column === 'verify-failed';

  useEffect(() => {
    let alive = true;
    setItem(null);
    setNeedsYouError(false);
    // The pull request address comes from the run list; wait for it before matching a PR item.
    if (!mayWait || run === null || !canUseNeedsYou()) return;
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

  const steps = stageLine(task, { prExists: prUrl !== undefined, repairs: repairAttempts(run?.detail) });
  const facts = receipt(run?.detail, run?.totalCostUsd);
  const repo = task.repoName ?? repoPath.split('/').filter(Boolean).pop() ?? repoPath;
  const reload = (): void => setNonce((n) => n + 1);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={`Quick view: ${task.title}`}
      className={cn(
        'flex min-h-0 flex-col bg-background outline-none',
        'w-96 shrink-0 rounded-xl border border-border/60',
        'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:max-h-[85vh] max-md:w-auto max-md:rounded-b-none max-md:shadow-2xl',
      )}
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border/60 p-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug">{task.title}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
            <span>{repo}</span>
            <span>{task.id}</span>
            {task.source !== undefined && <ExternalLink href={task.url}>{`Open in ${TRACKER_NAME[task.source]}`}</ExternalLink>}
          </div>
        </div>
        <button type="button" aria-label="Close quick view" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {needsYouError && <div className="text-xs text-muted-foreground">Could not check whether this card waits for you.</div>}
        {item !== null && (
          <div className="space-y-2">
            {/* The one orange thing here: the card waits for the user. */}
            <span className="inline-block rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary-text">
              Needs you · {waitingWhy(item)}
            </span>
            {item.lastComment && <div className="whitespace-pre-wrap break-words rounded bg-muted/40 px-3 py-2 text-sm">{item.lastComment.body}</div>}
            <ReplyBox project={repoPath} item={item} onReplied={reload} />
          </div>
        )}

        {prUrl !== undefined && (
          // On a phone the receipt comes first.
          <section aria-label="Receipt" className="max-md:order-first">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Receipt</h4>
            <dl className="grid grid-cols-2 gap-2">
              {facts.map((f) => (
                <div key={f.key} className="rounded border border-border/60 px-2 py-1.5">
                  <dt className="text-[11px] text-muted-foreground">{f.label}</dt>
                  <dd className={cn('text-sm', FACT_TONE[f.tone])}>{f.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <ol aria-label="Stage line" className="space-y-2">
          {steps.map((s) => (
            <li key={s.key} data-status={s.status} className="flex items-center gap-2 text-sm">
              {s.status === 'done' ? (
                <Check className={cn('size-4', DOT.done)} aria-hidden />
              ) : s.status === 'waiting' ? (
                <Circle className={cn('size-4', DOT.waiting)} aria-hidden />
              ) : (
                <CircleDot className={cn('size-4', DOT[s.status])} aria-hidden />
              )}
              <span className={cn(s.status === 'waiting' && 'text-muted-foreground', s.status === 'failed' && 'text-destructive-text')}>{s.label}</span>
              <span className="sr-only">{s.status}</span>
              {s.note && <span className="text-xs text-muted-foreground">{s.note}</span>}
            </li>
          ))}
        </ol>
      </div>

      {/* Pinned to the bottom edge: Merge and "Open in …". */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 bg-background p-3">
        {item?.kind === 'pr' && <MergeButton project={repoPath} item={item} onMerged={reload} />}
        {prUrl !== undefined && <ExternalLink href={prUrl}>{`Open in ${hostName(prUrl)}`}</ExternalLink>}
        <Button className="ml-auto" variant="outlined" onClick={onFullPage}>
          Full page
        </Button>
      </div>
    </aside>
  );
}
