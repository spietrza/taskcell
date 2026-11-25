import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@/ui';
import { callerCapabilities } from '../../ipc';
import { hub } from '../../transport';
import type { CredentialPolicy } from '../../wire';

/** Mirrors `CREDENTIAL_NAMES` in src/hub/credentials.ts — the only variables the hub will store. */
export const NAMES = [
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

/** One scope's paid-fallback opt-in: unchecked by default; the RPC error shows inline. */
function PaidFallbackToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (enabled: boolean) => Promise<void> }) {
  const [error, setError] = useState<string | undefined>();
  return (
    <label className="block space-y-1 text-sm">
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            setError(undefined);
            onChange(e.target.checked).catch((err) => setError(String(err)));
          }}
        />
        {label}
      </span>
      {error !== undefined && <span role="alert" className="block text-xs text-destructive-text">{error}</span>}
    </label>
  );
}

/** Hub-only. The one credentials panel. A user sees their own credentials once the hub owner or an admin turns
 * per-user credentials on; the switch and the instance credentials render only for the owner or an admin (the hub 403s anyone else). */
export function CredentialsPanel() {
  const [status, setStatus] = useState<{ enabled: boolean; admin: boolean; names: string[] } | undefined>();
  const [policy, setPolicy] = useState<CredentialPolicy>('off');
  const [instanceNames, setInstanceNames] = useState<string[]>([]);
  const [instanceReason, setInstanceReason] = useState<string | undefined>();
  const [paid, setPaid] = useState<{ user: boolean; instance?: boolean }>({ user: false });
  const [error, setError] = useState<string | undefined>();
  // A failed policy change keeps the panel (and its retry) on screen; a failed load or refresh replaces it.
  const [policyError, setPolicyError] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // An unreadable caller_capabilities falls back to the status's own admin flag rather than taking the panel down.
      const [s, caps] = await Promise.all([hub().call('user_credentials_status'), callerCapabilities().catch(() => null)]);
      const admin = caps?.admin ?? s.admin;
      setStatus({ ...s, admin });
      setPaid(await hub().call('get_paid_fallback'));
      if (admin) {
        setPolicy((await hub().call('get_credential_policy')).policy);
        const instance = await hub().call('instance_credentials_status');
        setInstanceNames(instance.names);
        setInstanceReason(instance.reason);
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
      <p className="text-xs text-muted-foreground">A run uses the starter’s own credential when the switch allows it, else the instance credential, else the hub’s environment.</p>
      {status.admin && (
        <>
          <label className="block space-y-1 text-sm">
            <span>Per-user credentials</span>
            <select
              className="block"
              value={policy}
              onChange={(e) => {
                const next = e.target.value as CredentialPolicy;
                setPolicyError(undefined);
                void hub().call('set_credential_policy', { policy: next }).then(refresh, (err) => setPolicyError(String(err)));
              }}
            >
              {(Object.keys(POLICY_LABELS) as CredentialPolicy[]).map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABELS[p]}
                </option>
              ))}
            </select>
            {policyError !== undefined && <span role="alert" className="block text-xs text-destructive-text">{policyError} — pick the option again to retry.</span>}
          </label>
          <CredentialEditor
            title="Instance credentials"
            names={instanceNames}
            onSave={async (n, v) => {
              await hub().call('save_instance_credential', { name: n, value: v });
              await refresh();
            }}
            onDelete={async (n) => {
              await hub().call('delete_instance_credential', { name: n });
              await refresh();
            }}
          />
          {instanceReason !== undefined && <p role="alert" className="text-xs text-destructive-text">{instanceReason}</p>}
          <PaidFallbackToggle
            label="When every subscription account is out, continue on the instance's paid API key (billed per token)"
            checked={paid.instance === true}
            onChange={async (enabled) => {
              await hub().call('set_instance_paid_fallback', { enabled });
              setPaid((p) => ({ ...p, instance: enabled }));
            }}
          />
        </>
      )}
      {status.enabled ? (
        <>
          <CredentialEditor
            title="Your credentials"
            names={status.names}
            onSave={async (n, v) => {
              await hub().call('save_user_credential', { name: n, value: v });
              await refresh();
            }}
            onDelete={async (n) => {
              await hub().call('delete_user_credential', { name: n });
              await refresh();
            }}
          />
          <PaidFallbackToggle
            label="When every subscription account is out, continue on your own paid API key (billed per token)"
            checked={paid.user}
            onChange={async (enabled) => {
              await hub().call('set_user_paid_fallback', { enabled });
              setPaid((p) => ({ ...p, user: enabled }));
            }}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Per-user credentials are off on this hub.</p>
      )}
    </div>
  );
}
