import { relTime, absTime } from '../time';

/** One timestamp presentation across the hub: the relative word, with the absolute time (UTC,
 * matching the run record on disk) in a tooltip — see docs/design/hub-audit.md P2 #2. Replaces the
 * three formats (relative, local "YYYY-MM-DD HH:MM", raw ISO) that used to vary by screen. */
export function Timestamp({ ms, className }: { ms: number; className?: string }) {
  return (
    <span className={className} title={absTime(ms)}>
      {relTime(ms)}
    </span>
  );
}
