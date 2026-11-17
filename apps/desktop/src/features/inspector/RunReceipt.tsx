import { useEffect, useState } from 'react';
import { Button, cn } from '@/ui';
import { Check, Circle, CircleDot, MessageSquare, ReceiptText } from 'lucide-react';
import { listNeedsYou, type NeedsYouItem } from '../../ipc';
import { receiptRows } from '../board/receipt';
import type { StageStatus, StageStep } from '../board/stageLine';
import { stationNote, type NoteContext } from '../board/stationNotes';
import { STATION_SHORT } from '../../stations';
import { matchNeedsYou } from '../board/QuickView';
import { MergeButton, ReplyBox } from '../needs-you/NeedsYou';
import type { RunDetail } from '../../wire';

const TONE = { pass: 'text-success-text', fail: 'text-destructive-text', none: '' } as const;
const NOT_YET_TONE = 'text-muted-foreground';
const DOT: Record<StageStatus, string> = { done: 'text-success-text', current: 'text-foreground', waiting: 'text-muted-foreground/50', failed: 'text-destructive-text' };

/** The run's six stations (runStations / liveStations), each with its note: a row on desktop, a column on a phone. */
export function StationTrack({ steps, ctx }: { steps: StageStep[]; ctx: NoteContext }) {
  return (
    <ol aria-label="Stations" className="flex shrink-0 flex-col gap-1 md:flex-row md:gap-0">
      {steps.map((s, i) => {
        const note = stationNote(s, ctx);
        return (
          <li key={s.key} data-status={s.status} aria-current={s.status === 'current' ? 'step' : undefined} className={cn('flex min-w-0 flex-1 items-start gap-2 md:flex-col md:gap-1 md:border-t-2 md:pt-2 md:pr-2', s.status === 'done' ? 'md:border-success-text/50' : s.status === 'failed' ? 'md:border-destructive' : s.status === 'current' ? 'md:border-foreground' : 'md:border-border')}>
            {s.status === 'done' ? <Check className={cn('mt-0.5 size-4 shrink-0', DOT.done)} aria-hidden /> : s.status === 'waiting' ? <Circle className={cn('mt-0.5 size-4 shrink-0', DOT.waiting)} aria-hidden /> : <CircleDot className={cn('mt-0.5 size-4 shrink-0', DOT[s.status])} aria-hidden />}
            <span className="min-w-0">
              <span className="hidden font-mono text-[10px] text-muted-foreground md:block">{String(i + 1).padStart(2, '0')}</span>
              <span className={cn('mr-2 text-sm md:mr-0 md:block', s.status === 'waiting' && 'text-muted-foreground', s.status === 'current' && 'font-semibold', s.status === 'failed' && 'font-medium text-destructive-text')}>{STATION_SHORT[s.key]}</span>
              {note !== '' && <span className="break-words text-xs text-muted-foreground md:block">{note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The run's receipt: what the records say, "not yet" where they are silent. Merge and "Ask for changes" show
 * when the run's pull request waits for you in the hub's needs-you list (GitHub only); "Ask for changes" is the
 * same reply that list sends: a comment on the PR plus the `needs revision` label, which starts a revise run.
 */
export function RunReceipt({ detail, project, merged, cost, live = false }: { detail: RunDetail; project: string; merged: boolean; cost?: string | undefined; live?: boolean }) {
  const [item, setItem] = useState<NeedsYouItem | null>(null);
  const [asking, setAsking] = useState(false);
  const [nonce, setNonce] = useState(0);
  const prUrl = detail.prUrl;
  useEffect(() => {
    let alive = true;
    setItem(null);
    if (prUrl === undefined || merged || live) return;
    listNeedsYou(project)
      .then((r) => alive && setItem(matchNeedsYou(r.items, { id: detail.taskId }, prUrl)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project, prUrl, merged, live, detail.taskId, nonce]);
  const reload = (): void => {
    setAsking(false);
    setNonce((n) => n + 1);
  };
  const delivered = prUrl !== undefined;
  const pr = item?.kind === 'pr' ? item : null;

  return (
    <section aria-label="Receipt" className="rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ReceiptText className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{delivered && !live ? 'Delivery receipt' : 'Receipt so far'}</h3>
        <span className="ml-auto text-xs uppercase tracking-wide text-muted-foreground">{live ? 'in progress' : merged ? 'merged' : delivered ? 'waiting for sign-off' : ''}</span>
      </header>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-3 py-2.5 text-sm">
        {receiptRows(detail, cost, live).map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-xs leading-5 text-muted-foreground">{r.label}</dt>
            <dd className={cn('min-w-0 break-words', r.value === 'not yet' || r.value === 'not recorded' ? NOT_YET_TONE : TONE[r.tone])}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {pr !== null && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
          <MergeButton project={project} item={pr} onMerged={reload} />
          {asking ? (
            <ReplyBox project={project} item={pr} onReplied={reload} placeholder="What should change?" action="Send back" />
          ) : (
            <Button variant="text" color="secondary" onClick={() => setAsking(true)} startIcon={<MessageSquare className="size-4" />}>
              Ask for changes
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
