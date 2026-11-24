import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '@/ui';
import { callerCapabilities } from '../../ipc';
import { hub } from '../../transport';
import type { AccountType, CredentialAccountView, CredentialPolicy } from '../../wire';

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

/** The per-variable editor leaves the Claude variables to the accounts section. */
const EDITOR_NAMES = NAMES.filter((n) => !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(n));

const POLICY_LABELS: Record<CredentialPolicy, string> = {
  off: 'Off — every run uses the instance credential',
  'user-first': 'User first, instance fallback',
  'user-only': 'User only — runs need the starter’s own credential',
};

export const MAX_ACCOUNTS = 20;
const TYPE_LABELS: Record<AccountType, string> = { subscription: 'Subscription token', 'api-key': 'API key', 'auth-token': 'Auth token (gateway)' };
const TERMS_CAVEAT =
  'Anthropic’s Claude Code terms say plan limits “assume ordinary, individual usage”. Rotating several subscription accounts to get past limits may breach the Consumer Terms; API keys are fine.';

/** Several Anthropic accounts, tried in list order; a limited one cools until its reset. Secrets are write-only. */
function AccountsSection({
  title,
  accounts,
  instance,
  termsWarning,
  onSave,
  onDelete,
  onReorder,
}: {
  title: string;
  accounts: CredentialAccountView[];
  instance: boolean;
  termsWarning?: string | undefined;
  onSave: (args: { id?: string; name: string; type: AccountType; value?: string; enabled?: boolean; acknowledgeTerms?: boolean }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReorder: (ids: string[]) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('api-key');
  const [value, setValue] = useState('');
  const [ack, setAck] = useState(false);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, { name: string; secret: string }>>({});
  const [error, setError] = useState<string | undefined>();
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  const atCap = accounts.length >= MAX_ACCOUNTS;
  const secondSubscription = instance && type === 'subscription' && accounts.some((a) => a.type === 'subscription' && a.enabled);
  const move = (i: number, by: -1 | 1): string[] => {
    const ids = accounts.map((a) => a.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id!);
    return ids;
  };
  return (
    <div className="space-y-2">
      <div className="caption">{title}</div>
      <p className="text-xs text-muted-foreground">A run uses the first switched-on account that has quota; one that hits a limit cools until its reset. {accounts.length} of {MAX_ACCOUNTS}.</p>
      {termsWarning !== undefined && <p role="alert" className="text-xs text-warning-text">{termsWarning}</p>}
      {accounts.length === 0 && <p className="text-sm text-muted-foreground">None saved.</p>}
      {accounts.map((a, i) => {
        // Re-enabling a second subscription token on the instance needs the same acknowledgement as adding one.
        const needsAck = instance && a.type === 'subscription' && !a.enabled && accounts.some((o) => o.id !== a.id && o.type === 'subscription' && o.enabled);
        const rowAck = acks[a.id] === true;
        return (
          <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={`${a.name} on`}
              checked={a.enabled}
              disabled={needsAck && !rowAck}
              onChange={(e) => void run(() => onSave({ id: a.id, name: a.name, type: a.type, enabled: e.target.checked, ...(needsAck ? { acknowledgeTerms: rowAck } : {}) }))}
            />
            <Input
              aria-label={`Name of ${a.name}`}
              value={edits[a.id]?.name ?? a.name}
              onChange={(e) => setEdits({ ...edits, [a.id]: { name: e.target.value, secret: edits[a.id]?.secret ?? '' } })}
            />
            <Button
              disabled={(edits[a.id]?.name ?? a.name).trim() === '' || (edits[a.id]?.name ?? a.name) === a.name}
              aria-label={`Rename ${a.name}`}
              onClick={() => void run(async () => {
                await onSave({ id: a.id, name: edits[a.id]!.name, type: a.type });
                setEdits(({ [a.id]: _done, ...rest }) => rest);
              })}
            >
              Rename
            </Button>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`Replace secret of ${a.name}`}
              placeholder="Replace secret"
              value={edits[a.id]?.secret ?? ''}
              onChange={(e) => setEdits({ ...edits, [a.id]: { name: edits[a.id]?.name ?? a.name, secret: e.target.value } })}
            />
            <Button
              disabled={(edits[a.id]?.secret ?? '').trim() === ''}
              aria-label={`Replace secret for ${a.name}`}
              onClick={() => void run(async () => {
                await onSave({ id: a.id, name: a.name, type: a.type, value: edits[a.id]!.secret });
                setEdits(({ [a.id]: _done, ...rest }) => rest);
              })}
            >
              Replace
            </Button>
            <span className="text-muted-foreground">{TYPE_LABELS[a.type]}</span>
            {needsAck && (
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" aria-label={`Acknowledge terms for ${a.name}`} checked={rowAck} onChange={(e) => setAcks({ ...acks, [a.id]: e.target.checked })} />
                <span>I understand the terms caveat</span>
              </label>
            )}
            {a.coolingUntil !== undefined && <span className="text-muted-foreground">cooling until {new Date(a.coolingUntil).toLocaleString()}</span>}
            <Button disabled={i === 0} aria-label={`Move ${a.name} up`} onClick={() => void run(() => onReorder(move(i, -1)))}>↑</Button>
            <Button disabled={i === accounts.length - 1} aria-label={`Move ${a.name} down`} onClick={() => void run(() => onReorder(move(i, 1)))}>↓</Button>
            <Button className="ml-auto" aria-label={`Remove ${a.name}`} onClick={() => void run(() => onDelete(a.id))}>Remove</Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={`${title} name`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label={`${title} type`} value={type} onChange={(e) => setType(e.target.value as AccountType)}>
          {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
        <Input type="password" autoComplete="off" aria-label={`${title} secret`} placeholder="write-only" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button
          disabled={atCap || name.trim() === '' || value.trim() === '' || (secondSubscription && !ack)}
          onClick={() =>
            void run(async () => {
              await onSave({ name, type, value, ...(secondSubscription ? { acknowledgeTerms: ack } : {}) });
              setName('');
              setValue('');
              setAck(false);
            })
          }
        >
          {atCap ? `${MAX_ACCOUNTS} of ${MAX_ACCOUNTS}` : 'Add account'}
        </Button>
      </div>
      {type === 'subscription' && <p className="text-xs text-muted-foreground">{TERMS_CAVEAT}</p>}
      {secondSubscription && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I understand the terms caveat for a second subscription token</span>
        </label>
      )}
      {error !== undefined && <div className="text-xs text-destructive-text">{error}</div>}
    </div>
  );
}

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
  // Claude variables are managed as accounts above (an account's name need not match its variable), so they are not listed here.
  const shown = names.filter((n) => EDITOR_NAMES.includes(n));
  const [name, setName] = useState(EDITOR_NAMES[0]!);
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
      {shown.length === 0 && <p className="text-sm text-muted-foreground">None saved.</p>}
      {shown.map((n) => (
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
          {EDITOR_NAMES.map((n) => (
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

/** Hub-only. The one credentials panel. A user sees their own credentials once the hub owner or an admin turns
 * per-user credentials on; the switch and the instance credentials render only for the owner or an admin (the hub 403s anyone else). */
export function CredentialsPanel() {
  const [status, setStatus] = useState<{ enabled: boolean; admin: boolean; names: string[]; accounts?: CredentialAccountView[] } | undefined>();
  const [policy, setPolicy] = useState<CredentialPolicy>('off');
  const [instanceNames, setInstanceNames] = useState<string[]>([]);
  const [instanceAccounts, setInstanceAccounts] = useState<CredentialAccountView[]>([]);
  const [termsWarning, setTermsWarning] = useState<string | undefined>();
  const [instanceReason, setInstanceReason] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  // A failed policy change keeps the panel (and its retry) on screen; a failed load or refresh replaces it.
  const [policyError, setPolicyError] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // An unreadable caller_capabilities falls back to the status's own admin flag rather than taking the panel down.
      const [s, caps] = await Promise.all([hub().call('user_credentials_status'), callerCapabilities().catch(() => null)]);
      const admin = caps?.admin ?? s.admin;
      setStatus({ ...s, admin });
      if (admin) {
        setPolicy((await hub().call('get_credential_policy')).policy);
        const instance = await hub().call('instance_credentials_status');
        setInstanceNames(instance.names);
        setInstanceAccounts(instance.accounts ?? []);
        setTermsWarning(instance.termsWarning);
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
          <AccountsSection
            title="Instance Anthropic accounts"
            instance
            accounts={instanceAccounts}
            termsWarning={termsWarning}
            onSave={async (a) => {
              await hub().call('save_instance_account', { provider: 'claude', ...a });
              await refresh();
            }}
            onDelete={async (id) => {
              await hub().call('delete_instance_account', { id });
              await refresh();
            }}
            onReorder={async (ids) => {
              await hub().call('reorder_instance_accounts', { ids });
              await refresh();
            }}
          />
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
        </>
      )}
      {status.enabled && (
        <AccountsSection
          title="Your Anthropic accounts"
          instance={false}
          accounts={status.accounts ?? []}
          onSave={async ({ acknowledgeTerms: _ack, ...a }) => {
            await hub().call('save_user_account', { provider: 'claude', ...a });
            await refresh();
          }}
          onDelete={async (id) => {
            await hub().call('delete_user_account', { id });
            await refresh();
          }}
          onReorder={async (ids) => {
            await hub().call('reorder_user_accounts', { ids });
            await refresh();
          }}
        />
      )}
      {status.enabled ? (
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
      ) : (
        <p className="text-sm text-muted-foreground">Per-user credentials are off on this hub.</p>
      )}
    </div>
  );
}
