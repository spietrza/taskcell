/** A user-facing message for a caught error: the underlying message, never a raw `Error: …` dump
 * or `[object Object]` — see docs/design/hub-audit.md P2 #12. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Something went wrong.';
}
