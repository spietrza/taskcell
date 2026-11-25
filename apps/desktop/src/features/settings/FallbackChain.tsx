import type { ReactElement } from 'react';
import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Button, Input } from '@/ui';
import { hub } from '../../transport';
import { fallbackChainErrors, type FallbackEntry, type Team } from '../../wire';
import { SELECT_CLASS } from './fields';

/** The chain as written: `provider/model` per entry, in order. */
const label = (e: FallbackEntry): string => (e.model !== undefined && e.model !== '' ? `${e.provider}/${e.model}` : e.provider);

/**
 * The ordered fallback chain: the Engine is row 0 (read-only), then the entries a run moves to when the one before hit a
 * provider limit. `chain` undefined = inherit the team default (`inherited`); `[]` = explicitly none.
 */
export function FallbackChain({
  engine,
  chain,
  providers,
  inherited,
  onChange,
}: {
  engine: string;
  chain: FallbackEntry[] | null | undefined;
  /** Providers an entry may use (built-ins and healthy customs that can run on a stored credential). */
  providers: readonly string[];
  /** The team default shown while the project sets none. */
  inherited?: FallbackEntry[] | undefined;
  onChange: (chain: FallbackEntry[] | undefined) => void;
}): ReactElement {
  const entries = chain ?? [];
  const errors = fallbackChainErrors(entries, { primary: engine, providers });
  const update = (next: FallbackEntry[]): void => onChange(next);
  const move = (i: number, d: -1 | 1): void => {
    const next = [...entries];
    const [e] = next.splice(i, 1);
    next.splice(i + d, 0, e!);
    update(next);
  };
  const patch = (i: number, p: Partial<FallbackEntry>): void => {
    const next = entries.map((e, j) => {
      if (j !== i) return e;
      const merged = { ...e, ...p };
      return merged.model === undefined || merged.model === '' ? { provider: merged.provider } : merged;
    });
    update(next);
  };
  const addable = providers.filter((p) => p !== engine);

  return (
    <div className="space-y-2" role="group" aria-label="Fallback chain">
      <p className="text-xs text-muted-foreground">
        When a run hits a provider limit it moves to the next entry that still has quota, and waits for the reset only when every entry is out. Each entry needs a credential saved in the hub. A flow stage with its own model pool keeps it. The chain never moves the review: set the review engine under Review. CI runs keep the workflow&apos;s fallback-provider input.
      </p>
      <ol className="space-y-1">
        <li className="flex items-center gap-2 text-sm">
          <span className="w-5 text-right text-muted-foreground">1</span>
          <span className="font-mono">{engine}</span>
          <span className="text-xs text-muted-foreground">Engine</span>
        </li>
        {entries.map((e, i) => (
          <li key={i} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-5 text-right text-muted-foreground">{i + 2}</span>
              <select aria-label={`Fallback ${i + 1} provider`} value={e.provider} onChange={(ev) => patch(i, { provider: ev.target.value })} className={`${SELECT_CLASS} max-w-48`}>
                <option value="">—</option>
                {e.provider !== '' && !providers.includes(e.provider) && <option value={e.provider}>{e.provider} (not configured)</option>}
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <Input aria-label={`Fallback ${i + 1} model`} value={e.model ?? ''} onChange={(ev) => patch(i, { model: ev.target.value })} placeholder="default model" className="max-w-48 font-mono text-xs" />
              <Button type="button" variant="text" aria-label={`Move fallback ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-4" aria-hidden />
              </Button>
              <Button type="button" variant="text" aria-label={`Move fallback ${i + 1} down`} disabled={i === entries.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-4" aria-hidden />
              </Button>
              <Button type="button" variant="text" aria-label={`Remove fallback ${i + 1}`} onClick={() => update(entries.filter((_, j) => j !== i))}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            {errors.rows[i] !== undefined && (
              <span role="alert" className="ml-7 block text-xs text-destructive-text">
                {errors.rows[i]}
              </span>
            )}
          </li>
        ))}
      </ol>
      {errors.list !== undefined && (
        <span role="alert" className="block text-xs text-destructive-text">
          {errors.list}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outlined" onClick={() => update([...entries, { provider: addable[0] ?? '' }])}>
          <Plus className="size-4" aria-hidden /> Add fallback
        </Button>
        {chain !== undefined && chain !== null && (
          <Button type="button" variant="text" onClick={() => onChange(undefined)}>
            Use team default
          </Button>
        )}
      </div>
      {(chain === undefined || chain === null) && (
        <p className="text-xs text-muted-foreground">
          {inherited !== undefined && inherited.length > 0 ? `Team default: ${inherited.map(label).join(' → ')}` : 'No team default: a run waits for the limit to reset.'}
        </p>
      )}
    </div>
  );
}

/** The team's default chain (Settings → Team & hub): projects without their own chain use it. Saved at once, like the members. */
export function TeamFallbackChain({ team, providers, admin, onTeam }: { team: Team; providers: readonly string[]; admin: boolean; onTeam: (t: Team) => void }): ReactElement {
  const [draft, setDraft] = useState<FallbackEntry[]>(team.fallbackChain ?? []);
  const [error, setError] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(team.fallbackChain ?? []);
  const invalid = (() => {
    const e = fallbackChainErrors(draft, { primary: '', providers });
    return e.list !== undefined || e.rows.some((r) => r !== undefined);
  })();
  const save = (): void => {
    setError(undefined);
    hub().call('set_team_fallback_chain', { teamId: team.id, chain: draft }).then(onTeam, (e: unknown) => setError(String(e)));
  };
  return (
    <section aria-label="Team fallback chain" className="space-y-3">
      <h3 className="text-base font-semibold">Fallback chain (team default)</h3>
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}
      {admin ? (
        <>
          <FallbackChain engine="the project's Engine" chain={draft} providers={providers} onChange={(c) => setDraft(c ?? [])} />
          <Button type="button" disabled={!dirty || invalid} onClick={save}>
            Save team default
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{draft.length > 0 ? draft.map(label).join(' → ') : 'None.'}</p>
      )}
    </section>
  );
}
