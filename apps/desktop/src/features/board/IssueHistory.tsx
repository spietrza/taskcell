import { readIssueHistory } from '../../ipc';
import { useAsync } from '../../hooks';

const ISSUE = /(\d+)$/;

/** The card's History section: records oldest to newest (time, actor, what), each with its source and whether it is chained. */
export function IssueHistory({ project, taskId }: { project: string; taskId: string }) {
  const issue = Number(ISSUE.exec(taskId)?.[1]);
  const { data, error, loading } = useAsync(
    () => (Number.isInteger(issue) && issue > 0 ? readIssueHistory(project, issue) : Promise.reject(new Error('no issue number'))),
    [project, issue],
  );
  return (
    <section aria-label="History">
      <div className="mb-2 caption">History</div>
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading history…</div>
      ) : error ? (
        <div className="text-sm text-muted-foreground">History is not available here. {error}</div>
      ) : !data || data.entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">No history yet.</div>
      ) : (
        <>
          {data.chains.some((c) => !c.ok) && (
            <div role="alert" className="mb-2 text-sm text-destructive">
              A chain did not verify: {data.chains.filter((c) => !c.ok).map((c) => c.name).join(', ')}. Run `taskcell audit verify`.
            </div>
          )}
          <ol className="space-y-2">
            {data.entries.map((e, i) => (
              <li key={i} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">{e.time.replace('T', ' ').slice(0, 16)}</span>
                  <span>{e.actor?.name ?? e.actor?.kind ?? 'unknown'}</span>
                </div>
                <div className="mt-1">{e.what}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {e.source.url !== undefined ? (
                    <a href={e.source.url} target="_blank" rel="noreferrer" className="underline">
                      {e.source.stream} {e.source.ref}
                    </a>
                  ) : (
                    <span>
                      {e.source.stream} {e.source.ref}
                    </span>
                  )}
                  {e.chain === 'none' && ' · no chain'}
                  {e.chain === 'failed' && ' · chain failed'}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
