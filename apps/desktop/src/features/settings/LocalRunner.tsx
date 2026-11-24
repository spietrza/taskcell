import { Chip, Timestamp } from '@/ui';
import { hub } from '../../transport';
import { useAsync } from '../../hooks';
import type { LocalWorkerState } from '../../wire';

/** The local hub's runner state in words: its switch, else why it cannot serve this project. */
export function localRunnerState(s: LocalWorkerState): { word: string; on: boolean } {
  if (s.enabled) return { word: 'on: picks up cards', on: true };
  return { word: s.blocked !== undefined ? `off: ${s.blocked}` : 'Auto-run off: cards start only when you press Start run', on: false };
}

/** Settings → Runners: the local hub as a runner (its local worker switch and last pick-up). Hidden where the hub cannot say (no hub). */
export function LocalRunner({ project }: { project: string }) {
  const { data } = useAsync(() => hub().call('local_worker_state', { repoPath: project }), [project]);
  if (!data) return null;
  const { word, on } = localRunnerState(data);
  return (
    <section className="space-y-2" aria-label="Local hub runner">
      <h3 className="text-lg font-semibold">Local hub</h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm">
        <span className="font-medium">This hub</span>
        <Chip color={on ? 'success' : 'secondary'} variant="outlined">{word}</Chip>
        <span className="text-muted-foreground">
          {data.lastPickupAt !== undefined ? (
            <>
              Last pick-up <Timestamp ms={Date.parse(data.lastPickupAt)} />
              {data.lastPickup !== undefined && ` (${data.lastPickup})`}
            </>
          ) : (
            'No pick-up yet'
          )}
        </span>
        {data.lastError !== undefined && <span className="text-destructive-text">Last error: {data.lastError}</span>}
      </div>
    </section>
  );
}
