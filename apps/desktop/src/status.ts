/** One status vocabulary across the hub: a verdict is always "passed" or "failed", whatever the raw
 * source calls it (a run's `anyFailed`, a CI conclusion, a stage's `completed` flag, a process exit
 * code) — see docs/design/hub-audit.md P2 #3. */
export type Verdict = 'passed' | 'failed';

export function verdictWord(ok: boolean): Verdict {
  return ok ? 'passed' : 'failed';
}

export function verdictColor(ok: boolean): 'success' | 'destructive' {
  return ok ? 'success' : 'destructive';
}
