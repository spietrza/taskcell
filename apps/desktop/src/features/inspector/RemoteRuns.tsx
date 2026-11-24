import { useState, type ReactNode } from 'react';
import { Button, Table, Chip, ErrorNote, ScrollTable, Timestamp } from '@/ui';
import { Download } from 'lucide-react';
import { useAsync, usePhone } from '../../hooks';
import { ExternalLink } from '../../components/ExternalLink';
import { verdictColor, verdictWord } from '../../status';
import type { RemoteImport, RemoteRun, RunSource, RunSummary } from '../../taskcell-output';
import { NO_REMOTE_MESSAGE } from '../../wire';
import { hub } from '../../transport';

function StatusChip({ r }: { r: RemoteRun }) {
  if (r.status !== 'completed') {
    return <Chip color="warning" variant="outlined">{r.status.replace(/_/g, ' ')}</Chip>;
  }
  // success/failure is the same verdict the run list calls passed/failed (hub-audit P2 #3); any
  // other CI conclusion (cancelled, skipped…) isn't a binary verdict, so it shows as-is — neutral,
  // except `timed_out`, which is a failure by another name and stays red.
  if (r.conclusion === 'success' || r.conclusion === 'failure') {
    const ok = r.conclusion === 'success';
    return (
      <Chip color={verdictColor(ok)} variant="outlined">
        {verdictWord(ok)}
      </Chip>
    );
  }
  return (
    <Chip color={r.conclusion === 'timed_out' ? verdictColor(false) : 'secondary'} variant="outlined">
      {r.conclusion || 'done'}
    </Chip>
  );
}

/** What started a CI run, in words (GitHub's `event`): the workflow name alone reads the same on every row. */
export function ciOrigin(event: string): string {
  const words: Record<string, string> = { issues: 'issue label', pull_request: 'pull request', pull_request_target: 'pull request', push: 'push', schedule: 'schedule', workflow_dispatch: 'started by hand', workflow_call: 'called by a workflow', issue_comment: 'comment' };
  return words[event] ?? event.replace(/_/g, ' ');
}

/** Per-row state of the record fetch; absent = not asked yet. */
type Records = { loading: true } | { error: string } | { data: RemoteImport };

export function RemoteRuns({
  project,
  onOpenRun,
}: {
  project: string;
  /** Open an imported record in the run inspector. The `source` names the CI run, never a root —
   * whichever backend imported it resolves that in `read_run`. */
  onOpenRun: (run: RunSummary, source: RunSource) => void;
}) {
  const phone = usePhone();
  const { data: runs, error, loading } = useAsync(() => hub().call('list_remote_runs', { repoPath: project }), [project]);
  const [records, setRecords] = useState<Record<number, Records>>({});

  const fetchRecords = async (id: number): Promise<void> => {
    setRecords((m) => ({ ...m, [id]: { loading: true } }));
    try {
      const data = await hub().call('import_remote_run', { repoPath: project, runId: id });
      setRecords((m) => ({ ...m, [id]: { data } }));
    } catch (e) {
      setRecords((m) => ({ ...m, [id]: { error: String(e) } }));
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading remote runs…</div>;
  if (error) {
    // The hub's own refusal already says what to do; it is not a connection problem.
    if (error.includes(NO_REMOTE_MESSAGE)) return <div role="alert" className="text-sm text-muted-foreground">{NO_REMOTE_MESSAGE}</div>;
    return (
      <ErrorNote
        title="Couldn't load remote runs"
        next="This is usually a connection or access problem: check that the CI provider is reachable and its token can see this repository, then reload."
        error={error}
      />
    );
  }
  if (!runs || runs.length === 0) {
    return <div className="text-sm text-muted-foreground">No CI runs found for this repo.</div>;
  }
  const recordsCell = (r: RemoteRun): ReactNode => {
    const rec = records[r.id];
    const cached = r.cached || (rec !== undefined && 'data' in rec);
    return (
      <span className="flex flex-wrap items-center gap-2">
        <ExternalLink href={r.url}>CI run</ExternalLink>
        {cached && <Chip color="secondary" variant="outlined">cached</Chip>}
        {!(rec !== undefined && 'data' in rec) && (
          <Button
            variant="text"
            color="secondary"
            loading={rec !== undefined && 'loading' in rec}
            onClick={() => void fetchRecords(r.id)}
            startIcon={<Download className="size-3.5" />}
          >
            {cached ? 'Open records' : 'Fetch records'}
          </Button>
        )}
      </span>
    );
  };
  // The fetched records expand under the run as a mini run list; a click opens the
  // same RunDetail (Overview / Diff / Transcript) a local run gets.
  const recordList = (rec: { data: RemoteImport }): ReactNode =>
    rec.data.runs.length === 0 ? (
      <span className="text-xs text-muted-foreground">No run records in this artifact.</span>
    ) : (
      <ul className="divide-y divide-border text-sm">
        {rec.data.runs.map((s) => (
          <li key={`${s.taskId}:${s.timestamp}`}>
            <button
              type="button"
              onClick={() => onOpenRun(s, { kind: 'ci', runId: rec.data.runId })}
              className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-left hover:bg-muted"
            >
              <span className="font-medium">{s.taskId}</span>
              <Timestamp ms={Date.parse(s.timestamp)} className="tabular-nums text-muted-foreground" />
              <span className="text-muted-foreground">{s.stages.join(', ')}</span>
              <Chip color={s.stoppedBy ? 'secondary' : verdictColor(!s.anyFailed)} variant="outlined">
                {s.stoppedBy ? 'stopped: provider limit' : verdictWord(!s.anyFailed)}
              </Chip>
            </button>
          </li>
        ))}
      </ul>
    );
  if (phone) {
    // A phone stacks each run, status first, instead of a six-column table that scrolls it off-screen.
    return (
      <ul aria-label="CI runs" className="divide-y divide-border rounded-lg border border-border">
        {runs.map((r) => {
          const rec = records[r.id];
          return (
            <li key={r.id} className="space-y-1.5 px-3 py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{r.workflow}</span>
                <StatusChip r={r} />
              </div>
              <div className="truncate text-muted-foreground" title={r.title}>{r.title}</div>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate font-mono" title={r.branch}>{r.branch}</span>
                <Timestamp ms={Date.parse(r.createdAt)} className="ml-auto shrink-0 tabular-nums" />
              </div>
              {recordsCell(r)}
              {rec !== undefined && 'data' in rec && <div className="rounded bg-muted/30 px-2">{recordList(rec)}</div>}
              {rec !== undefined && 'error' in rec && <div className="text-xs text-destructive-text">{rec.error}</div>}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ScrollTable>
    <Table.Root>
      <Table.Header className="sticky top-0 z-10 bg-background [&_th]:caption">
        <Table.Row>
          <Table.Head>Workflow</Table.Head>
          <Table.Head>Title</Table.Head>
          <Table.Head>Branch</Table.Head>
          <Table.Head>When</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head>Records</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {runs.map((r) => {
          const rec = records[r.id];
          return [
            <Table.Row key={r.id}>
              <Table.Cell className="font-medium">
                {r.workflow}
                {r.event !== '' && <span className="block text-xs font-normal text-muted-foreground">CI · {ciOrigin(r.event)}</span>}
              </Table.Cell>
              <Table.Cell className="max-w-64 truncate text-muted-foreground" title={r.title}>
                {r.title}
              </Table.Cell>
              <Table.Cell className="max-w-56 truncate text-muted-foreground" title={r.branch}>{r.branch}</Table.Cell>
              <Table.Cell className="tabular-nums text-muted-foreground">
                <Timestamp ms={Date.parse(r.createdAt)} />
              </Table.Cell>
              <Table.Cell>
                <StatusChip r={r} />
              </Table.Cell>
              <Table.Cell>{recordsCell(r)}</Table.Cell>
            </Table.Row>,
            rec !== undefined && 'data' in rec && (
              <Table.Row key={`${r.id}:records`} className="bg-muted/30">
                <Table.Cell colSpan={6}>
                  {recordList(rec)}
                </Table.Cell>
              </Table.Row>
            ),
            rec !== undefined && 'error' in rec && (
              <Table.Row key={`${r.id}:error`}>
                <Table.Cell colSpan={6} className="text-xs text-destructive">
                  {rec.error}
                </Table.Cell>
              </Table.Row>
            ),
          ];
        })}
      </Table.Body>
    </Table.Root>
    </ScrollTable>
  );
}
