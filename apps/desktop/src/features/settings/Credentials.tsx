import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Button, Input } from '@/ui';
import { deleteCredential, getCredentials, setCredential } from '../../ipc';
import type { CredentialProvider, CredentialsSummary } from '../../wire';

const LABELS: Record<CredentialProvider, string> = {
  claude: 'Claude (CLAUDE_CODE_OAUTH_TOKEN)',
  codex: 'Codex / OpenAI (OPENAI_API_KEY)',
  zai: 'z.ai (ZAI_API_KEY)',
  openrouter: 'OpenRouter (OPENROUTER_API_KEY)',
};

/** Hub-only: instance provider credentials, write-only (the hub never returns a value). */
export function Credentials(): ReactElement {
  const [summary, setSummary] = useState<CredentialsSummary>();
  const [error, setError] = useState<string>();
  const [drafts, setDrafts] = useState<Partial<Record<CredentialProvider, string>>>({});

  useEffect(() => {
    getCredentials().then(setSummary, (e: unknown) => setError(String(e)));
  }, []);

  const run = (action: Promise<CredentialsSummary>, provider: CredentialProvider): void => {
    setError(undefined);
    action.then(
      (s) => {
        setSummary(s);
        setDrafts((d) => ({ ...d, [provider]: '' }));
      },
      (e: unknown) => setError(String(e)),
    );
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-5">
      <h3 className="text-sm font-semibold">Provider credentials</h3>
      {error !== undefined && <div role="alert" className="text-sm text-destructive-text">{error}</div>}
      {summary === undefined ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {summary.reason !== undefined && (
            <p className="text-sm text-muted-foreground">
              {summary.enabled ? summary.reason : `Credential store disabled: ${summary.reason}`}
            </p>
          )}
          {summary.providers.map((p) => (
            <div key={p.provider} className="space-y-1">
              <div className="text-sm">
                {LABELS[p.provider]}{' '}
                <span className="text-xs text-muted-foreground">
                  {p.last4 !== undefined ? `set (…${p.last4})` : p.set ? 'set' : p.env ? 'from environment' : 'not set'}
                </span>
              </div>
              {summary.enabled && (
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    aria-label={`${p.provider} credential`}
                    placeholder={p.set ? 'Replace…' : 'Paste a key'}
                    value={drafts[p.provider] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [p.provider]: e.target.value }))}
                    className="w-full"
                  />
                  <Button
                    disabled={(drafts[p.provider] ?? '').trim() === ''}
                    onClick={() => run(setCredential(p.provider, drafts[p.provider] ?? ''), p.provider)}
                  >
                    Save
                  </Button>
                  {p.set && <Button onClick={() => run(deleteCredential(p.provider), p.provider)}>Delete</Button>}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
