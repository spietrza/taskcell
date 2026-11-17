import { cn } from '@/ui';
import { STATIONS, STATION_LABEL, STATION_SHORT } from '../stations';

/** "Gates (failed)", "Done": the station a mark names, for its label and its text. */
export function stationName(at: number, failed: boolean, short = false): string {
  const key = STATIONS[at];
  if (key === undefined) return 'Done';
  return `${(short ? STATION_SHORT : STATION_LABEL)[key]}${failed ? ' (failed)' : ''}`;
}

/**
 * A compact station indicator: six ticks (done ones filled, the current one ink, red when failed) and the station's
 * short name. `at` and `failed` come from `stationOf` / `runStationOf`; `at` 6 is past the line.
 */
export function StationMark({ at, failed, passed, className }: { at: number; failed: boolean; passed?: readonly number[]; className?: string }) {
  return (
    <span role="img" aria-label={`Station: ${stationName(at, failed)}`} data-station={STATIONS[at] ?? 'done'} className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="flex gap-0.5" aria-hidden>
        {STATIONS.map((k, i) => (
          <span
            key={k}
            className={cn(
              'h-1.5 w-2.5 rounded-full',
              i < at || passed?.includes(i) === true ? 'bg-foreground/40' : i === at ? (failed ? 'bg-destructive' : 'bg-foreground') : 'bg-border',
            )}
          />
        ))}
      </span>
      <span aria-hidden className={cn('text-[11px]', failed ? 'text-destructive-text' : 'text-muted-foreground')}>
        {stationName(at, false, true)}
      </span>
    </span>
  );
}
