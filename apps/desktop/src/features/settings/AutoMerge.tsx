import { useRef, useState } from 'react';
import { Button, ErrorNote, useFocusTrap } from '@/ui';
import { readApproverScorecard, setApproverMode } from '../../ipc';
import { useAsync } from '../../hooks';
import { errorMessage } from '../../errors';
import { ExternalLink } from '../../components/ExternalLink';
import type { ApproverMode, ApproverScorecard } from '../../wire';

const MODE_WORDS: Record<ApproverMode, string> = {
  off: 'Off — the approver does nothing',
  shadow: 'Shadow — it judges every pull request but never merges',
  act: 'Act — it merges the pull requests it approves',
};

/** The scorecard in plain words, with a clear state for no data and for a bar not met. */
export function scorecardWords(card: ApproverScorecard): string {
  if (card.status === 'no-data') return card.hint ?? 'No approver data yet.';
  const wrong = card.approvesWrong > 0 ? ` ${card.approvesWrong} approved ${card.approvesWrong === 1 ? 'one was' : 'ones were'} wrong.` : '';
  const best = card.byRiskClass.reduce((m, c) => Math.max(m, c.streak), 0);
  return (
    `${card.approves} of ${card.judged} pull requests would have been merged automatically; ` +
    `the bar is ${card.threshold} correct in a row; the longest run so far is ${best}.${wrong}`
  );
}

function Dialog({ repo, card, mode, onClose, onDone }: { repo: string; card: ApproverScorecard; mode: ApproverMode; onClose: () => void; onDone: (url: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsConfirm = mode === 'act' && !card.barMet;
  const open = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onDone((await setApproverMode(repo, mode, needsConfirm ? true : undefined)).prUrl);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Change auto-merge" className="max-h-[80vh] w-full max-w-[34rem] overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Set the approver to {mode}</h2>
        <p className="mt-2 text-sm text-muted-foreground">This opens a pull request that changes <code>.taskcell/approver.json</code>. Nothing changes until someone merges it.</p>
        {needsConfirm && (
          <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p>The bar is not met: {scorecardWords(card)}</p>
            <label className="mt-2 flex items-start gap-2">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I understand and want to turn act mode on anyway.</span>
            </label>
          </div>
        )}
        {error !== null && <p role="alert" className="mt-2 text-sm text-destructive-text">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="text" color="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={open} disabled={busy || (needsConfirm && !confirmed)}>Open pull request</Button>
        </div>
      </div>
    </div>
  );
}

/** Project settings, "Auto-merge": the 90-day scorecard beside the mode switch (hub only). The switch opens a PR. */
export function AutoMerge({ project: repo }: { project: string }) {
  const { data, error, loading } = useAsync(() => readApproverScorecard(repo, '90d'), [repo]);
  const [target, setTarget] = useState<ApproverMode | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  return (
    <section aria-label="Auto-merge" className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">Auto-merge</h3>
      {error !== null ? (
        <ErrorNote title="Could not read the approver scorecard" next="Reload to try again." error={error} />
      ) : data === null || loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <p className="text-sm">Current mode: <strong>{MODE_WORDS[data.mode]}</strong></p>
          <p className="text-sm" data-state={data.status === 'no-data' ? 'no-data' : data.barMet ? 'bar-met' : 'bar-not-met'}>
            Past 90 days: {scorecardWords(data)}
            {data.status === 'ok' && (data.barMet ? ' The bar is met.' : ' The bar is not met.')}
          </p>
          {data.status === 'ok' && data.topReasons.length > 0 && (
            <p className="text-xs text-muted-foreground">Most often left for you: {data.topReasons.map((r) => `${r.reason} (${r.count})`).join(', ')}</p>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Approver mode">
            {(['off', 'shadow', 'act'] as const).map((m) => (
              <Button key={m} variant="outlined" disabled={data.mode === m || !data.policyFound || (m === 'act' && !data.actOffered)} onClick={() => setTarget(m)}>
                {m === 'off' ? 'Turn off' : m === 'shadow' ? 'Shadow' : 'Act'}
              </Button>
            ))}
          </div>
          {!data.policyFound && <p className="text-xs text-muted-foreground">Add <code>.taskcell/approver.json</code> to the base branch first.</p>}
          {!data.actOffered && <p className="text-xs text-muted-foreground">Act mode, where the approver merges pull requests by itself, can't be turned on yet: {data.actHold !== undefined && data.actHold !== '' ? data.actHold : "it is waiting on another change that isn't finished."} Shadow mode shows what it would do without merging anything.</p>}
          {prUrl !== null && <p className="text-sm">Pull request opened: <ExternalLink href={prUrl}>{prUrl}</ExternalLink> — merge it to apply.</p>}
          {target !== null && <Dialog repo={repo} card={data} mode={target} onClose={() => setTarget(null)} onDone={(u) => { setPrUrl(u); setTarget(null); }} />}
        </>
      )}
    </section>
  );
}
