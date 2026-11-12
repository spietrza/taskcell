import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@/ui';
import {
  deleteInstanceCredential,
  deleteUserCredential,
  getCredentialPolicy,
  instanceCredentialsStatus,
  saveInstanceCredential,
  saveUserCredential,
  setCredentialPolicy,
  userCredentialsStatus,
} from '../../ipc';
import type { CredentialPolicy } from '../../wire';

/** Mirrors `CREDENTIAL_NAMES` in src/hub/credentials.ts — the only variables the hub will store. */
const NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_AUTH_JSON',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'CURSOR_API_KEY',
  'MERIDIAN_API_KEY',
];

const POLICY_LABELS: Record<CredentialPolicy, string> = {
  off: 'Off — every run uses the instance credential',
  'user-first': 'User first, instance fallback',
  'user-only': 'User only — runs need the starter’s own credential',
};

/** Write-only editor: shows which credential names are saved, never their values. */
function CredentialEditor({
  title,
  names,
  onSave,
  onDelete,
}: {
  title: string;
  names: string[];
  onSave: (name: string, value: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(NAMES[0]!);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="space-y-2">
      <div className="caption">{title}</div>
      {names.length === 0 && <p className="text-sm text-muted-foreground">None saved.</p>}
      {names.map((n) => (
        <div key={n} className="flex items-center gap-2 text-sm">
          <code>{n}</code>
          <span className="text-muted-foreground">saved</span>
          <Button className="ml-auto" onClick={() => void run(() => onDelete(n))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select aria-label={`${title} variable`} value={name} onChange={(e) => setName(e.target.value)}>
          {NAMES.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <Input
          type="password"
          autoComplete="off"
          aria-label={`${title} value`}
          placeholder="write-only"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          disabled={value.trim() === ''}
          onClick={() =>
            void run(async () => {
              await onSave(name, value);
              setValue('');
            })
          }
        >
          Save
        </Button>
      </div>
      {error !== undefined && <div className="text-xs text-destructive-text">{error}</div>}
    </div>
  );
}

/** Hub-only. A user sees their own credentials once an admin turns per-user credentials on; the
 * switch and the instance credentials render only for admins (the hub 403s anyone else). */
export function CredentialsPanel() {
  const [status, setStatus] = useState<{ enabled: boolean; admin: boolean; names: string[] } | undefined>();
  const [policy, setPolicy] = useState<CredentialPolicy>('off');
  const [instanceNames, setInstanceNames] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await userCredentialsStatus();
      setStatus(s);
      if (s.admin) {
        setPolicy((await getCredentialPolicy()).policy);
        setInstanceNames((await instanceCredentialsStatus()).names);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error !== undefined) return <div className="text-xs text-destructive-text">{error}</div>;
  if (status === undefined) return null;
  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/30 p-3">
      <div className="caption">Hub credentials</div>
      {status.admin && (
        <>
          <label className="block space-y-1 text-sm">
            <span>Per-user credentials</span>
            <select
              className="block"
              value={policy}
              onChange={(e) => {
                const next = e.target.value as CredentialPolicy;
                void setCredentialPolicy(next).then(refresh, (err) => setError(String(err)));
              }}
            >
              {(Object.keys(POLICY_LABELS) as CredentialPolicy[]).map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <CredentialEditor
            title="Instance credentials"
            names={instanceNames}
            onSave={async (n, v) => {
              await saveInstanceCredential(n, v);
              await refresh();
            }}
            onDelete={async (n) => {
              await deleteInstanceCredential(n);
              await refresh();
            }}
          />
        </>
      )}
      {status.enabled ? (
        <CredentialEditor
          title="Your credentials"
          names={status.names}
          onSave={async (n, v) => {
            await saveUserCredential(n, v);
            await refresh();
          }}
          onDelete={async (n) => {
            await deleteUserCredential(n);
            await refresh();
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Per-user credentials are off on this hub.</p>
      )}
    </div>
  );
}
