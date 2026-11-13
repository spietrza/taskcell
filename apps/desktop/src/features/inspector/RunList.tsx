import { useMemo, useState } from 'react';
import { Table, Chip, Empty, Input, ScrollTable, Timestamp } from '@/ui';
import { Inbox, RefreshCw, Search } from 'lucide-react';
import { verdictColor, verdictWord } from '../../status';
import { RepoLabel } from '../../RepoViews';
import { ExternalLink, hostName } from '../../components/ExternalLink';
import type { ActiveRun, RunSummary } from '../../taskcell-output';
import type { RepoStamp } from '../../wire';

type Filter = 'all' | 'passed' | 'failed';
type Run = RunSummary & Partial<RepoStamp>;
type Active = ActiveRun & Partial<RepoStamp>;

export function RunList({
  runs,
  active,
  showRepo = false,
  onSelect,
  onOpenActive,
}: {
  runs: Run[];
  /** In-flight runs discovered from `.taskcell` state, rendered as running rows at the top. */
  active: Active[];
  /** "All repositories": each row names its repository. */
  showRepo?: boolean;
  onSelect: (r: Run) => void;
  onOpenActive: (a: Active) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // Only hub-started runs carry `startedBy`; elsewhere the column would be a column of dashes.
  const showStartedBy = runs.some((r) => r.startedBy !== undefined);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (q && !r.taskId.toLowerCase().includes(q)) return false;
      if (filter === 'passed' && r.anyFailed) return false;
      if (filter === 'failed' && !r.anyFailed) return false;
      return true;
    });
  }, [runs, query, filter]);

  // Running rows have no pass/fail verdict yet, so they only appear under the "all" filter.
  const shownActive = useMemo(() => {
    if (filter !== 'all') return [];
    const q = query.trim().toLowerCase();
    return active.filter((a) => !q || a.taskId.toLowerCase().includes(q));
  }, [active, query, filter]);

  if (runs.length === 0 && active.length === 0) {
    return (
      <Empty.Root>
        <Empty.Media>
          <Inbox />
        </Empty.Media>
        <Empty.Title>No runs found</Empty.Title>
        <Empty.Description>
          This repo has no <code>.taskcell/runs</code> yet.
        </Empty.Description>
      </Empty.Root>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          startAdornment={<Search className="size-4" />}
          placeholder="Filter by task…"
          className="w-56"
        />
        <div className="flex gap-1">
          {(['all', 'passed', 'failed'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-1 text-xs capitalize transition-colors ${
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {shown.length + shownActive.length} /{' '}
          {runs.length + (filter === 'all' ? active.length : 0)}
        </span>
      </div>

      {shown.length === 0 && shownActive.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No runs match.</div>
      ) : (
        <ScrollTable>
        <Table.Root>
          <Table.Header className="sticky top-0 z-10 bg-background [&_th]:caption">
            <Table.Row>
              <Table.Head>Task</Table.Head>
              {showRepo && <Table.Head>Repository</Table.Head>}
              {showStartedBy && <Table.Head>Started by</Table.Head>}
              <Table.Head>When</Table.Head>
              <Table.Head>Stages</Table.Head>
              <Table.Head className="text-right">Cost</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Links</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shownActive.map((a) => (
              <Table.Row
                key={`active:${a.repoPath ?? ''}:${a.taskId}`}
                onClick={() => onOpenActive(a)}
                className="cursor-pointer bg-primary/5"
              >
                <Table.Cell className="font-medium">{a.taskId}</Table.Cell>
                {showRepo && <Table.Cell><RepoLabel name={a.repoName} /></Table.Cell>}
                {showStartedBy && <Table.Cell className="text-muted-foreground">—</Table.Cell>}
                <Table.Cell className="tabular-nums text-muted-foreground">
                  <Timestamp ms={a.lastActivityMs} />
                </Table.Cell>
                <Table.Cell className="text-muted-foreground">—</Table.Cell>
                <Table.Cell className="text-right tabular-nums text-muted-foreground">—</Table.Cell>
                <Table.Cell>
                  {/* Amber (live), not green, so a running row isn't mistaken for a green "passed" one. */}
                  <Chip color="primary" variant="outlined">
                    <span className="inline-flex items-center gap-1">
                      <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
                      running
                    </span>
                  </Chip>
                </Table.Cell>
                <Table.Cell />
              </Table.Row>
            ))}
            {shown.map((r) => (
              <Table.Row
                key={`${r.repoPath ?? ''}:${r.taskId}:${r.timestamp}`}
                onClick={() => onSelect(r)}
                className="cursor-pointer"
              >
                <Table.Cell className="font-medium">{r.taskId}</Table.Cell>
                {showRepo && <Table.Cell><RepoLabel name={r.repoName} /></Table.Cell>}
                {showStartedBy && <Table.Cell className="text-muted-foreground">{r.startedBy ?? '—'}</Table.Cell>}
                <Table.Cell className="tabular-nums text-muted-foreground">
                  <Timestamp ms={Date.parse(r.timestamp)} />
                </Table.Cell>
                <Table.Cell className="text-muted-foreground">{r.stages.join(', ')}</Table.Cell>
                <Table.Cell className="text-right tabular-nums">${r.totalCostUsd.toFixed(2)}</Table.Cell>
                <Table.Cell>
                  <Chip color={verdictColor(!r.anyFailed)} variant="outlined">
                    {verdictWord(!r.anyFailed)}
                  </Chip>
                </Table.Cell>
                <Table.Cell>
                  <div className="flex flex-col gap-0.5">
                    {r.prUrl !== undefined && <ExternalLink href={r.prUrl}>{`Open in ${hostName(r.prUrl)}`}</ExternalLink>}
                    <ExternalLink href={r.ciUrl}>CI run</ExternalLink>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        </ScrollTable>
      )}
    </div>
  );
}
