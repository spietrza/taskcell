import { useState } from 'react';
import { ErrorNote } from '@/ui';
import { useAsync } from '../../hooks';
import { costKindNote, EST_COST_NOTE, rowCostLabel, totalCostLabel as totalLabel } from '../../cost';
import type { CostPeriod, CostRow } from '../../wire';
import { hub } from '../../transport';

const PERIODS: { id: CostPeriod; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

function Rows({ title, rows }: { title: string; rows: CostRow[] }) {
  return (
    <div className="min-w-0 flex-1 basis-64">
      <div className="mb-1 caption">{title}</div>
      <ul className="space-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">{r.key}</span>
            <span className="shrink-0 tabular-nums">
              {rowCostLabel(r)}
              <span className="ml-1 text-xs text-muted-foreground">
                {r.entries}×{r.unknownEntries > 0 && r.unknownEntries < r.entries ? `, ${r.unknownEntries} unknown` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a project's CI runs cost (its metrics branch), by model and by stage, for a period. */
export function CostBreakdown({ project }: { project: string }) {
  const [period, setPeriod] = useState<CostPeriod>('30d');
  const { data, error, loading } = useAsync(() => hub().call('read_cost_breakdown', { repoPath: project, period }), [project, period]);

  return (
    <section aria-label="CI cost" className="mb-3 shrink-0 rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">CI cost</h3>
        {data?.status === 'ok' && <span className="text-sm tabular-nums">{totalLabel(data)}</span>}
        <div className="ml-auto flex gap-1" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={period === p.id}
              onClick={() => setPeriod(p.id)}
              className={`rounded px-2 py-1 text-xs transition-colors ${period === p.id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {error !== null ? (
        <ErrorNote title="Could not read CI cost" next="Reload to try again." error={error} />
      ) : data === null || loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.status === 'no-branch' ? (
        <p className="text-sm text-muted-foreground">No CI run metrics yet for this repo. {data.hint}</p>
      ) : data.byModel.length === 0 ? (
        <p className="text-sm text-muted-foreground">No CI runs in this period.</p>
      ) : (
        <>
          {/* "their cost is unknown" would contradict the estimate shown next to it. */}
          {!(data.costKind === 'unknown' && data.totalEstCostUsd !== undefined) && <p className="mb-2 text-xs text-muted-foreground">{costKindNote(data.costKind)}</p>}
          {data.totalEstCostUsd !== undefined && <p className="mb-2 text-xs text-muted-foreground">{EST_COST_NOTE}</p>}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Rows title="By model" rows={data.byModel} />
            <Rows title="By stage" rows={data.byStage} />
          </div>
        </>
      )}
    </section>
  );
}
