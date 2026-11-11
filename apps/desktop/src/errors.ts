/** A user-facing message for a caught error: the underlying message, never a raw `Error: …` dump
 * or `[object Object]` — see docs/design/hub-audit.md P2 #12. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // A blank message would read as "no error at all"; the default text keeps the failure visible.
  return msg.trim() || 'Something went wrong.';
}
