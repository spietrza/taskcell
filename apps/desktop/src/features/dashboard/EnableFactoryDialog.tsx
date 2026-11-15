import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Chip, CodeBlock, useFocusTrap } from '@/ui';
import { enableFactoryApply, enableFactoryHost, enableFactoryPlan, enableFactoryStart, enableFactoryVerify, enableFactoryWatch, factoryRefresh, factoryState } from '../../ipc';
import { factoryStepLabel } from './factoryLabel';
import { ExternalLink } from '../../components/ExternalLink';
import { RUN_LOCATIONS } from '../../platform';
import { absTime, relTime } from '../../time';
import type { RunLocationId, WatchWorkerChecklist, FactoryHost, FactoryPlan, FactoryProviderId, FactoryState } from '../../wire';

/** GitHub Actions and GitLab CI have `enable_factory_*` adapters; Self-hosted (watch) has its own read-only checklist; the rest are listed as planned. */
const PROVIDER_OF: Partial<Record<RunLocationId, FactoryProviderId>> = { 'github-actions': 'github', 'gitlab-ci': 'gitlab' };

/** Why GitLab CI cannot be set up for a project whose remote is not on GitLab (one plain sentence). */
function gitlabUnavailable(host: FactoryHost | null): string {
  if (host === null) return 'Checking the remote…';
  if (host === 'none') return 'This project has no remote; add one that points at GitLab.';
  if (host === 'github') return 'This project\'s remote is on GitHub, not GitLab.';
  return 'Needs a remote on gitlab.com or the host named by GITLAB_HOST.';
}

type Busy = 'plan' | 'watch' | 'apply' | 'verify' | 'secret' | null;

/** How often the open checklist re-checks the PR merge and the doctor run. */
const POLL_MS = 5000;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="caption">{title}</div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

/** `2026-11-14 12:00 (11h ago)`: when the newest watch run record was written. */
function seenAt(iso: string | undefined): string {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? `${absTime(ms)} (${relTime(ms)})` : 'an unknown time';
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const [plan, setPlan] = useState<FactoryPlan | null>(null);
  // The persisted checklist (survives closing the dialog and a hub restart); null until first read.
  const [checklist, setChecklist] = useState<FactoryState | null>(null);
  // Where origin points; null until read. GitLab CI is offered only for a GitLab remote.
  const [host, setHost] = useState<FactoryHost | null>(null);
  // Self-hosted (watch): read-only checklist; the hub starts nothing on another machine.
  const [watch, setWatch] = useState<WatchWorkerChecklist | null>(null);
  // The text whose Copy button was just pressed, so only that button says "Copied".
  const [copied, setCopied] = useState<string | null>(null);
  const [doctorConfirmed, setDoctorConfirmed] = useState(false);
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

  // Load the persisted checklist on open, then poll it while it is in progress: the hub detects the
  // merge and follows the doctor run, so the dialog advances on its own.
  const inProgress = checklist?.state === 'setting-up';
  useEffect(() => {
    let alive = true;
    void factoryState(project.path).then(
      (s) => alive && setChecklist(s),
      // Without the saved state, fall back to the picker so the user can still start (or retry) from there.
      (err) => {
        if (alive) setError(errorText(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [project.path]);
  useEffect(() => {
    let alive = true;
    void enableFactoryHost(project.path).then((r) => alive && setHost(r.host), () => alive && setHost('other'));
    return () => {
      alive = false;
    };
  }, [project.path]);
  useEffect(() => {
    if (!inProgress) return;
    let alive = true;
    const timer = setInterval(() => {
      factoryRefresh(project.path).then((s) => alive && setChecklist(s), () => undefined);
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [inProgress, project.path]);

  const loadPlan = (provider: FactoryProviderId): Promise<void> =>
    step('plan', async () => {
      setPlan(await enableFactoryPlan(project.path, provider));
    });
  const loadWatch = (): Promise<void> =>
    step('watch', async () => {
      setWatch(await enableFactoryWatch(project.path));
    });
  const existingFiles = new Set(plan?.existingCallerFiles ?? []);
  // A caller counts as present under its legacy `vanguard-` name too (the hub adds no `taskcell-` twin).
  const existing = { has: (f: string): boolean => existingFiles.has(f) || existingFiles.has(f.replace('/taskcell-', '/vanguard-')) };
  // Every caller already on the default branch: apply would have nothing to commit, so skip straight to verify.
  const nothingToAdd = plan !== null && plan.callerFiles.every((f) => existing.has(f));
  // GitLab: the jobs file is on the default branch but the hub cannot wire it in, so there is no MR to open — only a line to add by hand.
  const manualOnly = plan?.gitlabManualInclude === true && existing.has('.gitlab/taskcell.yml');
  const apply = (p: FactoryPlan): Promise<void> =>
    step('apply', async () => {
      await enableFactoryApply(project.path, p);
      setChecklist(await factoryRefresh(project.path));
    });
  // Callers already on the base: no PR, the checklist starts at the secret.
  const start = (p: FactoryPlan): Promise<void> => step('apply', async () => setChecklist(await enableFactoryStart(project.path, p)));
  const runVerify = (p: FactoryPlan): Promise<void> =>
    step('verify', async () => {
      await enableFactoryVerify(project.path, p);
      setDoctorConfirmed(false);
      setChecklist(await factoryRefresh(project.path));
    });
  const checkSecret = (): Promise<void> => step('secret', async () => setChecklist(await factoryRefresh(project.path)));
  const copy = (text: string): void => {
    if (!navigator.clipboard) {
      setError('Copying is not available here; select the command and copy it by hand.');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(text);
        setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
      },
      () => setError('Could not copy; select the command and copy it by hand.'),
    );
  };
  const checklistPlan = checklist?.plan ?? null;
  const showChecklist = checklist !== null && checklist.state !== 'none' && checklistPlan !== null;
  // The code host's own words: a GitLab project has a merge request, a `glab` variable and a pipeline.
  const gitlab = (checklistPlan ?? plan)?.provider === 'gitlab';
  const mr = gitlab ? 'MR' : 'PR';
  const unruledJobs = gitlab ? checklistPlan?.gitlabUnruledJobs ?? [] : [];
  const needsDoctorConfirmation = unruledJobs.length > 0 && !doctorConfirmed;
  const status = (id: string): string | undefined => checklist?.steps.find((x) => x.id === id)?.status;

  return (
    // Top-anchored, not centered: the plan is taller than the platform picker, so a centered dialog jumps when it loads.
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]" onClick={() => busy === null && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Enable factory"
        className="max-h-[80vh] w-[34rem] overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold">Enable factory on {project.name}</h2>

        {showChecklist ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">{checklistPlan.repoSlug} — progress is saved; you can close this and come back.</p>
            <ol className="mt-3 space-y-3 text-sm">
              {checklist.steps.map((s, i) => (
                <li key={s.id} data-step={s.id} data-status={s.status}>
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="w-4 text-center">{s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : i + 1}</span>
                    <span className={s.status === 'pending' ? 'text-muted-foreground' : 'font-medium'}>{factoryStepLabel(s.id, checklistPlan.provider)}</span>
                  </div>
                  {s.id === 'pr' && checklist.prUrl && (
                    <div className="ml-6 text-xs">
                      <a href={checklist.prUrl} target="_blank" rel="noreferrer" className="text-primary-text underline">{checklist.prUrl}</a>
                    </div>
                  )}
                  {s.id === 'secret' && s.status !== 'done' && checklist.secret && (
                    <div className="ml-6 mt-1">
                      <p className="text-xs text-muted-foreground">
                        {gitlab ? <>Run this yourself in a terminal; it asks for the token without echoing it and creates or updates a masked, protected CI/CD variable through <code>glab</code>.</> : <>Run this yourself; <code>gh</code> prompts for the value.</>} The hub only checks that {gitlab ? 'the CI/CD variable' : ''} <code>{checklist.secret.secretName}</code> exists, never its value.
                      </p>
                      <CodeBlock code={checklist.secret.command} lang="bash" />
                      <div className="mt-1 flex gap-2">
                        <Button variant="outlined" color="secondary" className="h-7 px-2 text-xs" onClick={() => copy(checklist.secret!.command)}>
                          {copied === checklist.secret.command ? 'Copied' : 'Copy'}
                        </Button>
                        <Button variant="outlined" color="secondary" className="h-7 px-2 text-xs" onClick={() => void checkSecret()} loading={busy === 'secret'} disabled={busy !== null}>
                          Check again
                        </Button>
                      </div>
                    </div>
                  )}
                  {s.id === 'merged' && s.status !== 'done' && checklist.prUrl && (
                    <p className="ml-6 text-xs text-muted-foreground">
                      {s.status === 'failed' ? checklist.reason : 'Waiting for the merge — this page notices on its own.'}{' '}
                      <a href={checklist.prUrl} target="_blank" rel="noreferrer" className="text-primary-text underline">Open the {mr}</a>
                    </p>
                  )}
                  {s.id === 'doctor' && (
                    <div className="ml-6 text-xs">
                      {checklist.doctor ? (
                        <a href={checklist.doctor.url} target="_blank" rel="noreferrer" className="text-primary-text underline">
                          Doctor run: {checklist.doctor.conclusion || checklist.doctor.status}
                        </a>
                      ) : checklist.doctorPending ? (
                        <span className="text-muted-foreground">Doctor workflow dispatched; the run has not shown up yet — check {gitlab ? 'the pipelines page' : 'Actions'}.</span>
                      ) : (
                        s.status !== 'done' && <span className="text-muted-foreground">Merge the {mr}, then run the doctor.{gitlab ? ' It starts a pipeline on the default branch; your own jobs without rules run in it too. It also needs a GITLAB_TOKEN CI/CD variable.' : ''}</span>
                      )}
                      {gitlab && doctorConfirmed && unruledJobs.length > 0 && (
                        <p role="alert" className="mt-1 text-warning-text">
                          This also runs {unruledJobs.join(', ')} because {unruledJobs.length === 1 ? 'it has' : 'they have'} no <code>rules:</code>. Confirm with “Run doctor anyway”.
                        </p>
                      )}
                      {s.status === 'failed' && <p className="text-destructive-text">{checklist.reason}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : watch !== null ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              {watch.repoSlug || project.name} — you run the worker yourself, on your own machine. The hub starts and installs nothing there.
            </p>
            <Section title="1. Credentials the worker needs (names only)">
              <div className="flex flex-wrap gap-1">
                {watch.credentials.map((c) => <Chip key={c} color="secondary" variant="outlined">{c}</Chip>)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Put their values in a <code>.env</code> next to the compose file, or export them where you run the command. The hub never sees them.</p>
            </Section>
            <Section title="2. Compose snippet">
              <CodeBlock code={watch.compose} lang="yaml" />
              <Button variant="outlined" color="secondary" className="mt-1 h-7 px-2 text-xs" onClick={() => copy(watch.compose)}>{copied === watch.compose ? 'Copied' : 'Copy'}</Button>
            </Section>
            <Section title="Or run it directly">
              <CodeBlock code={watch.command} lang="bash" />
              {watch.source === 'linear' && (
                <p className="mt-1 text-xs text-muted-foreground">Outside the runner image, also set <code>SKILLS_DIR</code> to the linear-cli skills (a clone of schpet/linear-cli&apos;s <code>skills/</code>); the image sets it.</p>
              )}
              <Button variant="outlined" color="secondary" className="mt-1 h-7 px-2 text-xs" onClick={() => copy(watch.command)}>{copied === watch.command ? 'Copied' : 'Copy'}</Button>
            </Section>
            <Section title="3. Worker seen">
              <p data-seen={watch.seen}>
                {watch.seen === 'recent'
                  ? `Yes: a watch worker last recorded a run for this repository ${seenAt(watch.lastRunAt)}.`
                  : watch.seen === 'stale'
                    ? `Not recently: the newest watch run record the hub can read is from ${seenAt(watch.lastRunAt)}.`
                    : 'Cannot tell: the hub reads no run records from a watch worker for this repository. A worker on another machine shows up only if its records reach this hub.'}
              </p>
              <Button variant="outlined" color="secondary" className="mt-1 h-7 px-2 text-xs" onClick={() => void loadWatch()} loading={busy === 'watch'} disabled={busy !== null}>
                Check again
              </Button>
            </Section>
          </>
        ) : plan === null ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">Pick where the factory runs. Nothing is written until you confirm.</p>
            <div className="mt-3 space-y-2">
              {RUN_LOCATIONS.map((p) => {
                const provider = PROVIDER_OF[p.id];
                if (p.id === 'watch' && host === 'none') {
                  return (
                    <div key={p.id} className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm opacity-80">
                      <span className="font-medium">{p.label}</span>
                      <span className="text-xs text-muted-foreground">This project has no remote; add one first.</span>
                    </div>
                  );
                }
                if (p.id === 'watch') {
                  return (
                    <button
                      key={p.id}
                      disabled={busy !== null}
                      onClick={() => void loadWatch()}
                      className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="font-medium">{p.label}</span>
                      <span className="text-xs text-muted-foreground">{busy === 'watch' ? 'Reading repo…' : 'Checklist →'}</span>
                    </button>
                  );
                }
                if (provider === 'gitlab' && host !== 'gitlab') {
                  return (
                    <div key={p.id} className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm opacity-80">
                      <span className="font-medium">{p.label}</span>
                      <span className="text-xs text-muted-foreground">{gitlabUnavailable(host)}</span>
                    </div>
                  );
                }
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
            <Section title={`${gitlab ? 'CI files' : 'Caller workflows'} (${nothingToAdd ? 'already on the default branch' : `added in a ${gitlab ? 'merge request' : 'PR'}`})`}>
              <ul className="font-mono text-xs">
                {plan.callerFiles.map((f) => (
                  <li key={f}>
                    {f}
                    {existing.has(f) && <span className="font-sans text-muted-foreground"> — already exists, left as is</span>}
                    {gitlab && plan.gitlabManualInclude && f === plan.gitlabCiPath && <span className="font-sans text-muted-foreground"> — not edited automatically</span>}
                  </li>
                ))}
              </ul>
              {gitlab && plan.gitlabManualInclude && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The hub cannot edit <code>{plan.gitlabCiPath ?? '.gitlab-ci.yml'}</code> automatically. {manualOnly ? 'The jobs file is already on the default branch, so there is no merge request to open: add' : 'Before merging the merge request, add'} this line under its top-level <code>include:</code>{manualOnly ? ', then open Enable factory again' : ''}: <code>- local: .gitlab/taskcell.yml</code>
                </p>
              )}
              {nothingToAdd && (
                <p className="mt-1 text-xs text-muted-foreground">
                  This repo already has every {gitlab ? 'factory CI file' : 'caller workflow'}, so there is no {mr} to open. Start the checklist to set the secret and run the doctor.
                </p>
              )}
            </Section>
            <Section title="Labels">
              <div className="flex flex-wrap gap-1">
                {plan.labels.map((l) => <Chip key={l} color="secondary" variant="outlined">{l}</Chip>)}
              </div>
            </Section>
            <p className="mt-3 text-xs text-muted-foreground">
              {gitlab ? 'The hub never edits CI config itself: it opens a merge request for you to merge.' : <>Optional — use a GitHub App: the generated revise caller already lists <code>YOUR_APP_SLUG[bot]</code> as a PR author (replace it with your App's slug).
              The rest of the App path needs a maintainer's workflow edits; see docs/onboarding-another-repo.md (&quot;Alternative: the taskcell GitHub App&quot;).</>}
            </p>
          </>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="text" color="secondary" onClick={onClose} disabled={busy !== null}>
            {showChecklist || watch !== null ? 'Close' : 'Cancel'}
          </Button>
          {!showChecklist && watch !== null && (
            <Button variant="outlined" color="secondary" onClick={() => setWatch(null)} disabled={busy !== null}>
              Back
            </Button>
          )}
          {showChecklist && status('merged') === 'failed' && (
            <Button onClick={() => void apply(checklistPlan)} loading={busy === 'apply'} disabled={busy !== null}>
              Open {mr} again
            </Button>
          )}
          {showChecklist && status('merged') === 'done' && status('doctor') !== 'done' && (
            <Button
              onClick={() => needsDoctorConfirmation ? setDoctorConfirmed(true) : void runVerify(checklistPlan)}
              loading={busy === 'verify'}
              disabled={busy !== null || checklist.doctor?.status === 'queued' || checklist.doctor?.status === 'in_progress'}
            >
              {doctorConfirmed ? 'Run doctor anyway' : checklist.doctor ? 'Run doctor again' : 'Run doctor'}
            </Button>
          )}
          {!showChecklist && plan && (
            <Button onClick={() => void (nothingToAdd ? start(plan) : apply(plan))} loading={busy === 'apply'} disabled={busy !== null || manualOnly}>
              {nothingToAdd ? 'Start checklist' : gitlab ? 'Open merge request' : 'Open PR'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
