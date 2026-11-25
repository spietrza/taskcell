// Opt-in paid fallback: when every subscription account a run could use is cooling (hit its plan limit), a scope that
// switched it on continues on its own per-token API key instead of parking until the reset. Decided once, at run start,
// from the repo's cool-down file; the funding scope's switch is the only one read, and an instance key never funds a user run.
import { entryKey } from '../core/model-pool.js';
import type { RunCredential } from '../wire.js';
import { PAID_NAMES, SUBSCRIPTION_NAMES } from './credentials.js';

const firstValue = (env: Record<string, string>, names: readonly string[] | undefined): string | undefined => names?.find((n) => (env[n] ?? '') !== '');

/** Pure: decide whether this run moves to paid usage. `paidEnv` is the funding scope's values only (instance: store + host env). */
export function decidePaidFallback(opts: {
  provider: string;
  candidates: readonly { provider: string; model?: string }[];
  cooling: ReadonlyMap<string, Date>;
  credential: RunCredential;
  enabled: boolean;
  paidEnv: Record<string, string>;
}): { credential: RunCredential; warning?: string } {
  const { credential, candidates, cooling, paidEnv } = opts;
  const unchanged = { credential };
  if (candidates.length === 0 || candidates.some((c) => !cooling.has(entryKey(c)))) return unchanged;
  const onPlan = (provider: string): boolean => firstValue({ ...paidEnv, ...credential.env }, SUBSCRIPTION_NAMES[provider]) !== undefined;
  if (!candidates.some((c) => onPlan(c.provider))) return unchanged;
  if (!opts.enabled) return unchanged;
  const scope = credential.source === 'user' ? 'your credentials' : 'the instance';
  const paidName = firstValue(paidEnv, PAID_NAMES[opts.provider]);
  if (paidName === undefined) {
    const names = PAID_NAMES[opts.provider]?.join(' or ') ?? 'none';
    return { credential, warning: `paid fallback is on but ${scope} has no paid key for ${opts.provider} (${names}); the run parks until the limit resets` };
  }
  const entries = candidates.map((c) => entryKey(c).replace(/\/$/, ''));
  const until = [...candidates.map((c) => cooling.get(entryKey(c))!)].sort((a, b) => a.getTime() - b.getTime())[0]!.toISOString();
  const env: Record<string, string> = { ...credential.env };
  for (const names of Object.values(SUBSCRIPTION_NAMES)) for (const n of names) delete env[n];
  for (const p of new Set(candidates.map((c) => c.provider))) {
    for (const n of PAID_NAMES[p] ?? []) if ((paidEnv[n] ?? '') !== '') env[n] = paidEnv[n]!;
  }
  const reason = `every subscription account is out (${entries.join(', ')} until ${until}); continuing on ${opts.provider}'s paid API key (${paidName})`;
  return { credential: { source: credential.source, env, paid: { reason, until, entries } } };
}
