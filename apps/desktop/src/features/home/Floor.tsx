import { STATIONS, STATION_SHORT } from '../../stations';
import { runLocationLabel, effectiveRunLocation } from '../../platform';
import { projectColor } from '../../color';
import type { FloorRow, FloorStation } from './homeModel';

const MAX_DOTS = 3;

/** "Gates: 1 card, failed" for one station. */
const stationText = (label: string, s: FloorStation): string =>
  `${label}: ${s.n} ${s.n === 1 ? 'card' : 'cards'}${s.failed > 0 ? ', failed' : ''}${s.waiting > 0 ? `, ${s.waiting} waiting for you` : ''}`;

/** The six stations with a dot per open card (up to three, then "+n"): ink = on it, red = failed, orange = waits for you. */
export function StationStrip({ stations }: { stations: FloorStation[] }) {
  return (
    // One image for assistive tech: the dots alone say nothing, the label carries the counts.
    <div role="img" aria-label={STATIONS.map((k, i) => stationText(STATION_SHORT[k], stations[i]!)).join('; ')} className="grid grid-cols-6 gap-1">
      {STATIONS.map((key, i) => {
        const s = stations[i]!;
        const dots = [
          ...Array.from({ length: s.failed }, () => 'bg-destructive'),
          ...Array.from({ length: s.waiting }, () => 'bg-primary'),
          ...Array.from({ length: Math.max(0, s.n - s.failed - s.waiting) }, () => 'bg-foreground'),
        ];
        return (
          <div key={key} className="min-w-0 text-center" aria-hidden>
            <div className="flex h-5 items-center justify-center gap-1 rounded-sm border border-border">
              {dots.slice(0, MAX_DOTS).map((c, j) => (
                <span key={j} className={`size-2 rounded-full ${c}`} />
              ))}
              {dots.length > MAX_DOTS && <span className="text-[10px] tabular-nums text-muted-foreground">+{dots.length - MAX_DOTS}</span>}
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">{STATION_SHORT[key]}</div>
          </div>
        );
      })}
    </div>
  );
}

/** The factory floor: one row per busy project with its cards on the six stations. Idle projects fold into one line. */
export function Floor({ rows, idle, onOpen }: { rows: FloorRow[]; idle: number; onOpen: (path: string) => void }) {
  if (rows.length === 0 && idle === 0) return null;
  return (
    <section aria-label="The floor" className="space-y-3">
      <h2 className="text-xl font-semibold">The floor</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open cards and no runs this week.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <li key={r.path}>
              <button
                type="button"
                onClick={() => onOpen(r.path)}
                aria-label={`Open ${r.name} on the Board`}
                className="grid w-full items-center gap-x-6 gap-y-2 p-4 text-left transition-colors hover:bg-muted/40 md:grid-cols-[14rem_minmax(0,1fr)_6rem]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-8 w-1 shrink-0 rounded-sm" style={{ backgroundColor: projectColor(r.project) }} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{runLocationLabel(effectiveRunLocation(r.project.taskSource, r.project.runLocation))}</span>
                  </span>
                </span>
                <StationStrip stations={r.stations} />
                <span className="text-xs tabular-nums text-muted-foreground md:text-right">${r.spendWeek.toFixed(2)} this week</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {idle > 0 && <p className="text-xs text-muted-foreground">and {idle} idle {idle === 1 ? 'project' : 'projects'}</p>}
    </section>
  );
}
