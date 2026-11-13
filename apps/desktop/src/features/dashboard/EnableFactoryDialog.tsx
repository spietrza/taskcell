import { useEffect, useState, type ReactNode } from 'react';
import { Button, Chip, CodeBlock } from '@/ui';
import { enableFactoryApply, enableFactoryPlan, enableFactorySecret, enableFactoryVerify } from '../../ipc';
import { ExternalLink } from '../../components/ExternalLink';
import { RUN_LOCATIONS } from '../../platform';
import type { FactoryApplyResult, RunLocationId, FactoryPlan, FactoryProviderId, FactorySecretStep, FactoryVerifyResult } from '../../wire';

/** Only GitHub Actions has an `enable_factory_*` adapter; every other run location is listed as planned. */
const PROVIDER_OF: Partial<Record<RunLocationId, FactoryProviderId>> = { 'github-actions': 'github' };

type Busy = 'plan' | 'apply' | 'verify' | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="caption">{title}</div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Hub-only "Enable factory" flow over the `enable_factory_*` RPCs: pick a platform, review the plan
 * (callers, labels, the secret command), confirm to open the PR, then dispatch the doctor workflow.
 * The secret is only ever shown as a command for the user to run — this dialog never takes a token.
 */
export function EnableFactoryDialog({ project, onClose }: { project: { path: string; name: string }; onClose: () => void }) {
  const [plan, setPlan] = useState<FactoryPlan | null>(null);
  const [secret, setSecret] = useState<FactorySecretStep | null>(null);
  const [applied, setApplied] = useState<FactoryApplyResult | null>(null);
  const [verify, setVerify] = useState<FactoryVerifyResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && busy === null) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const step = async (kind: Exclude<Busy, null>, fn: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const loadPlan = (provider: FactoryProviderId): Promise<void> =>
    step('plan', async () => {
      const p = await enableFactoryPlan(project.path, provider);
      setSecret(await enableFactorySecret(project.path, p));
      setPlan(p);
    });
  const existingFiles = new Set(plan?.existingCallerFiles ?? []);
  // A caller counts as present under its legacy `vanguard-` name too (the hub adds no `taskcell-` twin).
  const existing = { has: (f: string): boolean => existingFiles.has(f) || existingFiles.has(f.replace('/taskcell-', '/vanguard-')) };
  // Every caller already on the default branch: apply would have nothing to commit, so skip straight to verify.
  const nothingToAdd = plan !== null && plan.callerFiles.every((f) => existing.has(f));
  const apply = (p: FactoryPlan): Promise<void> => step('apply', async () => setApplied(await enableFactoryApply(project.path, p)));
  const runVerify = (p: FactoryPlan): Promise<void> => step('verify', async () => setVerify(await enableFactoryVerify(project.path, p)));

  return (
    // Top-anchored, not centered: the plan is taller than the platform picker, so a centered dialog jumps when it loads.
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]" onClick={() => busy === null && onClose()}>
      <div
        role="dialog"
        aria-label="Enable factory"
        className="max-h-[80vh] w-[34rem] overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold">Enable factory on {project.name}</h2>

        {plan === null ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">Pick where the factory runs. Nothing is written until you confirm.</p>
            <div className="mt-3 space-y-2">
              {RUN_LOCATIONS.map((p) => {
                const provider = PROVIDER_OF[p.id];
                return p.implemented && provider ? (
                <button
                  key={p.id}
                  disabled={busy !== null}
                  onClick={() => void loadPlan(provider)}
                  className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="font-medium">{p.label}</span>
                  <span className="text-xs text-muted-foreground">{busy === 'plan' ? 'Reading repo…' : 'Plan →'}</span>
                </button>
                ) : (
                  <div key={p.id} className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-sm opacity-80">
                    <span className="font-medium">{p.label}</span>
                    <span className="flex items-center gap-2">
                      <Chip color="secondary" variant="outlined">planned</Chip>
                      <ExternalLink href={p.trackingUrl}>Tracking issue</ExternalLink>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <dl className="mt-3 space-y-1 text-sm">
              {(
                [
                  ['Repo', plan.repoSlug],
                  ['Base', plan.defaultBranch],
                  ['Author', plan.login],
                  ['Verify', plan.verifyCommand ?? `${plan.packageManager} (no verify command detected)`],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="truncate font-medium" title={v}>{v}</dd>
                </div>
              ))}
            </dl>
            <Section title={nothingToAdd ? 'Caller workflows (already on the default branch)' : 'Caller workflows (added in a PR)'}>
              <ul className="font-mono text-xs">
                {plan.callerFiles.map((f) => (
                  <li key={f}>
                    {f}
                    {existing.has(f) && <span className="font-sans text-muted-foreground"> — already exists, left as is</span>}
                  </li>
                ))}
              </ul>
              {nothingToAdd && (
                <p className="mt-1 text-xs text-muted-foreground">
                  This repo already has every caller workflow, so there is no PR to open. Set the secret, then run verify.
                </p>
              )}
            </Section>
            <Section title="Labels">
              <div className="flex flex-wrap gap-1">
                {plan.labels.map((l) => <Chip key={l} color="secondary" variant="outlined">{l}</Chip>)}
              </div>
            </Section>
            {secret && (
              <Section title="Secret — run this yourself">
                <p className="text-xs text-muted-foreground">
                  Sets <code>{secret.secretName}</code>; <code>gh</code> prompts for the value. The hub never sees it.
                </p>
                <p className="text-xs text-muted-foreground">
                  Optional — use a GitHub App: the generated revise caller already lists <code>YOUR_APP_SLUG[bot]</code> as a PR author (replace it with your App's slug).
                  The rest of the App path needs a maintainer's workflow edits; see docs/onboarding-another-repo.md (&quot;Alternative: the taskcell GitHub App&quot;).
                </p>
                <CodeBlock code={secret.command} lang="bash" />
              </Section>
            )}
            {applied && (
              <Section title="Pull request">
                <a href={applied.prUrl} target="_blank" rel="noreferrer" className="text-primary-text underline">
                  {applied.prUrl}
                </a>
                <p className="mt-1 text-xs text-muted-foreground">
                  Merge it and set the secret, then run verify to dispatch the doctor workflow.
                </p>
              </Section>
            )}
            {verify && (
              <Section title="Verify">
                {verify.run ? (
                  <a href={verify.run.url} target="_blank" rel="noreferrer" className="text-primary-text underline">
                    Doctor run: {verify.run.conclusion || verify.run.status}
                  </a>
                ) : (
                  <span className="text-muted-foreground">Doctor workflow dispatched; the run has not shown up yet — check Actions.</span>
                )}
              </Section>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="text" color="secondary" onClick={onClose} disabled={busy !== null}>
            {applied ? 'Close' : 'Cancel'}
          </Button>
          {plan && !applied && !nothingToAdd && (
            <Button onClick={() => void apply(plan)} loading={busy === 'apply'} disabled={busy !== null}>
              Open PR
            </Button>
          )}
          {plan && (applied || nothingToAdd) && (
            <Button onClick={() => void runVerify(plan)} loading={busy === 'verify'} disabled={busy !== null}>
              Run verify
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
