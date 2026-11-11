import { relTime, absTime } from '../time';

/** One timestamp presentation across the hub: the relative word, with the absolute time (UTC,
 * matching the run record on disk) in a tooltip — see docs/design/hub-audit.md P2 #2. Replaces the
 * three formats (relative, local "YYYY-MM-DD HH:MM", raw ISO) that used to vary by screen. */
export function Timestamp({ ms, className }: { ms: number; className?: string }) {
  // An unparseable timestamp (`Date.parse` of a malformed string) shows `absTime`'s em dash rather
  // than "NaNs ago", and has no absolute time to hang a tooltip off.
  if (!Number.isFinite(ms)) return <span className={className}>{absTime(ms)}</span>;
  return (
    <span className={className} title={`${absTime(ms)} UTC`}>
      {relTime(ms)}
    </span>
  );
}
