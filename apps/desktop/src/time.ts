/** Compact "Ns/m/h/d ago" from an epoch-ms timestamp; future times clamp to "0s ago". */
export function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** `2026-07-06T19:12:02.123Z` (as ms) -> `2026-07-06 19:12`: the absolute time behind a relative
 * word, shown as a tooltip by `Timestamp` (`@/ui`) — see docs/design/hub-audit.md P2 #2. A
 * non-finite input (an unparseable timestamp) has no absolute time, so it renders as `—` rather
 * than throwing `RangeError` mid-render. */
export function absTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}
