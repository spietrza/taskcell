import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { Timestamp } from '@/ui';
import { readSettingsHistory } from '../../ipc';
import { STATION_SHORT, type Station } from '../../stations';
import type { SettingsHistoryEntry } from '../../wire';

/** Which station edits each app.json key; keys with no station live in General. */
const KEY_STATION: Record<string, Station> = {
  label: 'card',
  provider: 'cell',
  budgetUsd: 'cell',
  verifyCmd: 'gates',
  reviewProvider: 'review',
  baseBranch: 'pr',
  flow: 'spec',
};

/** The hub records the shared token identity as `token` (TOKEN_ACTOR in src/hub/audit.ts): a hub with no sign-in. */
export const authorLabel = (login: string): string => (login === 'token' ? 'you (local hub)' : login);

export const keyLabel = (k: string): string => {
  const s = KEY_STATION[k];
  return `${s === undefined ? 'General' : STATION_SHORT[s]} · ${k}`;
};

/** "old → new" for a key the hub recorded values for (its non-secret allowlist); null for a names-only key. */
export function valueChange(e: SettingsHistoryEntry, key: string): string | null {
  const c = e.changes?.find((x) => x.key === key);
  return c === undefined ? null : `${c.from ?? 'unset'} → ${c.to ?? 'unset'}`;
}

const flowFile = (e: SettingsHistoryEntry): string | undefined => (e.detail.length === 0 && e.target.endsWith('.hcl') ? e.target.slice(e.target.lastIndexOf(':') + 1) : undefined);

/** Saves made from the hub, newest first: who, when and which fields, with old → new values for the non-secret keys the hub records. Re-reads when `version` changes. */
export function LineHistory({ project, version }: { project: string; version: number }) {
  const [rows, setRows] = useState<SettingsHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    readSettingsHistory(project).then(
      (r) => { if (live) { setRows(r); setFailed(false); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [project, version]);

  return (
    <section aria-label="Line history" className="rounded-lg border border-border">
      <h3 className="caption flex items-center gap-2 border-b border-border px-4 py-3"><History className="size-3.5" aria-hidden />Line history <span className="font-normal normal-case">· saved from the hub</span></h3>
      {failed ? (
        <p className="p-4 text-sm text-muted-foreground">History could not be read.</p>
      ) : rows === null ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No saves recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((e, i) => (
            <li key={`${e.time}-${i}`} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{authorLabel(e.login)}{e.outcome !== 'ok' ? ` · ${e.outcome}` : ''}</span>
                <Timestamp ms={Date.parse(e.time)} className="shrink-0" />
              </div>
              {flowFile(e) !== undefined ? (
                <div>flow {flowFile(e)} changed</div>
              ) : (
                <ul className="font-mono text-xs">
                  {e.detail.map((k) => (
                    <li key={k} className="break-words">
                      {keyLabel(k)}
                      {valueChange(e, k) !== null && <span className="text-muted-foreground">: {valueChange(e, k)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
