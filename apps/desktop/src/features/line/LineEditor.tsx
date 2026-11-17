import { useEffect, useState, type ReactNode } from 'react';
import { Box, FileText, GitPullRequest, ListChecks, Lock, ScanEye, Tag, type LucideIcon } from 'lucide-react';
import { Button, CodeBlock, Input, cn } from '@/ui';
import { gateProps } from '../../hooks';
import { apiCapabilitiesCached, apiListFlows } from '../../ipc';
import { STATIONS, STATION_LABEL, STATION_SHORT, type Station } from '../../stations';
import { effectiveRunLocation, resolveTaskSource, runLocationLabel, taskSourceLabel } from '../../platform';
import { errorClause } from '../../errors';
import { appConfigRangeErrors } from '../../wire';
import { Field, Select } from '../settings/fields';
import { useConfigForm } from '../settings/configForm';
import { PROVIDERS } from '../settings/customProviders';
import { AutoMerge } from '../settings/AutoMerge';
import { WorkflowEditor } from '../workflow/WorkflowEditor';
import { asCode } from './asCode';
import { LineHistory } from './LineHistory';
import { stationSummary } from './stationSummary';

const ICON: Record<Station, LucideIcon> = { card: Tag, spec: FileText, cell: Box, gates: ListChecks, review: ScanEye, pr: GitPullRequest };

/** A read-only line in a station editor: a fact the hub cannot change here (`locked`: nothing can change it). */
function FactRow({ label, value, note, locked }: { label: string; value: string; note?: string; locked?: boolean }) {
  return (
    <div className="space-y-1 p-4">
      <div className="caption flex items-center gap-1.5">
        {locked && <Lock className="size-3" aria-hidden />}
        {label}
      </div>
      <div className="font-mono text-sm">{value}</div>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** The cell that holds one editor field of a station. */
const Cell = ({ children }: { children: ReactNode }) => <div className="p-4">{children}</div>;

/**
 * Settings → Line: the factory as six stations. Each station edits the app.json fields it owns; Publish is
 * the same save as General (it writes `.taskcell/app.json`, it does not commit it).
 */
export function LineEditor({ project }: { project: string }) {
  const form = useConfigForm(project);
  const { cfg, cfgStatus, dirty, saved, saveError, saveGate, lastSaved, set, customs, customErrors, customsValid, rangeErrors, savable, save, discard } = form;
  const [station, setStation] = useState<Station>('gates');
  const [flowNames, setFlowNames] = useState<string[]>([]);
  const [published, setPublished] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [caps, repo] = await Promise.all([apiCapabilitiesCached(), apiListFlows(project)]);
        const names = [...caps.flows.map((f) => f.name), ...repo.flows.flatMap((f) => (f.name !== undefined && f.error === undefined ? [f.name] : []))];
        if (live) setFlowNames([...new Set(names)]);
      } catch {
        /* keep the empty list: the picker still shows the stored value */
      }
    })();
    return () => { live = false; };
  }, [project]);

  const publish = async (): Promise<void> => {
    await save();
    setPublished((n) => n + 1);
  };

  const healthyCustomNames = customs.filter((_, i) => customErrors[i] === undefined).map((r) => r.name);
  const providerOptions = [...PROVIDERS, ...healthyCustomNames];
  const taskSource = resolveTaskSource(cfg);
  const runner = runLocationLabel(effectiveRunLocation(taskSource, cfg.runLocation));
  // Errors in fields only General edits still block Publish: say where to fix them.
  const generalErrors = [
    ...(customsValid ? [] : ['custom providers']),
    ...(['concurrency', 'usageCapPct'] as const).filter((k) => appConfigRangeErrors(cfg)[k] !== undefined),
  ];

  const editor: ReactNode = (() => {
    switch (station) {
      case 'card':
        return (
          <>
            <Cell>
              <Field label="Trigger label" help="The label that hands an issue to the factory. The Board lists only issues that carry it, New Task adds it, and a hub that runs tasks itself starts the ones that get it. Empty: the Board lists every issue and the hub starts on the ready for agent label.">
                <Input value={cfg.label ?? ''} onChange={(e) => set('label', e.target.value || undefined)} className="w-full" placeholder="ready for agent" />
              </Field>
            </Cell>
            <FactRow label="Task source" value={taskSource === undefined ? 'not chosen' : taskSourceLabel(taskSource)} note="Chosen in General." />
          </>
        );
      case 'spec':
        return (
          <>
            <FactRow label="Planner model" value="set by the CLI flag --spec-model" note="The hub has no setting for it yet." />
            <FactRow label="Runs with flow" value={cfg.flow || 'the source default'} note="Pick the flow under Custom flows." />
          </>
        );
      case 'cell':
        return (
          <>
            <Cell>
              <Field label="Engine" hint="— which model service runs the stages">
                <Select value={cfg.provider ?? ''} onChange={(v) => set('provider', v || undefined)} options={providerOptions} danglingLabel={(v) => `${v} (not configured)`} />
              </Field>
            </Cell>
            <Cell>
              <Field label="Budget cap per run" error={rangeErrors.budgetUsd}>
                <Input type="number" min={0} value={cfg.budgetUsd ?? ''} onChange={(e) => set('budgetUsd', e.target.value ? Number(e.target.value) : undefined)} className="w-full" placeholder="2.50" />
              </Field>
            </Cell>
            <FactRow label="Runner" value={runner} note="Chosen in General (Runs on)." />
          </>
        );
      case 'gates':
        return (
          <>
            <Cell>
              <Field label="Verify command" hint="— the Proof of Work; runs inside the cell, exit 0 is green">
                <Input value={cfg.verifyCmd ?? ''} onChange={(e) => set('verifyCmd', e.target.value || undefined)} className="w-full font-mono text-xs" placeholder="pnpm typecheck && pnpm test" />
              </Field>
            </Cell>
            <FactRow label="Repairs on a red gate" value="2 rounds, set by --max-repair-iterations" note="The hub has no setting for it yet." />
            <FactRow label="Second repair runs on" value="set by the CLI flag --escalate-model" note="Unset: it stays on the implementer model." />
            <FactRow label="Secret scan" value="always on · host side" note="A hit pushes nothing. Can't be turned off." locked />
            <FactRow label="CI config edits" value="dropped" note="Changes under the CI config paths never leave the cell. Can't be turned off." locked />
          </>
        );
      case 'review':
        return (
          <>
            <Cell>
              <Field label="Review engine" hint="— optional; a different built-in provider reviews the work (custom providers cannot review)">
                <Select value={cfg.reviewProvider ?? ''} onChange={(v) => set('reviewProvider', v || undefined)} options={PROVIDERS} danglingLabel={(v) => `${v} (not supported)`} />
              </Field>
            </Cell>
            <FactRow label="Review model" value="set by the CLI flag --review-model" note="The hub has no setting for it yet." />
          </>
        );
      case 'pr':
        return (
          <Cell>
            <Field label="Default target branch" hint="— where pull requests go when a card names none (default main)">
              <Input value={cfg.baseBranch ?? ''} onChange={(e) => set('baseBranch', e.target.value || undefined)} className="w-full font-mono text-xs" placeholder="main" />
            </Field>
          </Cell>
        );
    }
  })();

  const canEdit = dirty && lastSaved !== null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="min-w-0 space-y-5">
        {/* Sticky: Publish stays reachable however far the page scrolls. */}
        <header className="sticky top-0 z-10 flex flex-wrap items-end gap-3 bg-background py-1">
          <div className="min-w-0">
            <div className="caption">.taskcell/app.json</div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your line, station by station.</h2>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {canEdit && (
              <Button variant="text" color="secondary" onClick={discard}>
                Discard
              </Button>
            )}
            <Button {...gateProps(saveGate)} onClick={publish} disabled={!savable || saveGate?.allowed === false}>
              {saved ? 'Published' : 'Publish'}
            </Button>
          </div>
        </header>
        {saveError !== null && (
          <p role="alert" className="text-sm text-destructive-text">
            Settings were not saved: {errorClause(saveError)}. Fix it and publish again.
          </p>
        )}
        {dirty && generalErrors.length > 0 && (
          <p role="alert" className="text-sm text-destructive-text">
            Publish is blocked: fix {generalErrors.join(' and ')} in General.
          </p>
        )}
        {cfgStatus === 'error' && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-muted-foreground">
            <span className="font-semibold text-destructive-text">.taskcell/app.json is unreadable</span> — fix its JSON by hand before editing here; publishing now would replace the whole file.
          </div>
        )}

        {cfgStatus === 'loading' ? (
          <div className="rounded-lg border border-border p-5 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div role="group" aria-label="Stations" className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {STATIONS.map((key, i) => {
                const Icon = ICON[key];
                const on = station === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setStation(key)}
                    className={cn(
                      'min-w-0 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                      on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <span className="flex items-center justify-between text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                      <span className="text-xs tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                    </span>
                    <span className="mt-2 block font-semibold">{STATION_SHORT[key]}</span>
                    <span className="mt-1 block space-y-0.5 text-xs text-muted-foreground">
                      {stationSummary(key, cfg).map((l) => (
                        <span key={l} className="block truncate">· {l}</span>
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>

            <section aria-label={`${STATION_LABEL[station]} settings`} className="overflow-hidden rounded-lg border border-border">
              <div className="caption border-b border-border px-4 py-3">
                {STATION_LABEL[station]} <span className="font-normal">· {String(STATIONS.indexOf(station) + 1).padStart(2, '0')}</span>
              </div>
              <div
                className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:[&>*:nth-child(even)]:border-l sm:[&>*:nth-child(even)]:border-border [&>*]:min-w-0"
                // Enter in a single-line field publishes, as General's form does; a select or a button keeps its own Enter.
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement) || !savable) return;
                  e.preventDefault();
                  void publish();
                }}
              >
                {editor}
              </div>
              {station === 'pr' && (
                <div className="border-t border-border p-4">
                  <p className="mb-2 text-xs text-muted-foreground">Auto-merge has its own save: changing the mode opens a pull request, separate from Publish.</p>
                  <AutoMerge project={project} />
                </div>
              )}
            </section>

            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Custom flows (advanced)</summary>
              <div className="space-y-3 border-t border-border p-4">
                <Field label="Runs with flow" hint="— runs the Hub starts for this project use it, so the models set below apply; — = the source default">
                  <Select value={cfg.flow ?? ''} onChange={(v) => set('flow', v || undefined)} options={flowNames} danglingLabel={(v) => `${v} (not found)`} />
                </Field>
                <div className="h-[40rem] overflow-x-auto">
                  <WorkflowEditor project={project} />
                </div>
              </div>
            </details>
          </>
        )}
      </div>
      <aside className="min-w-0 space-y-5">
        <LineHistory project={project} version={published} />
        <section aria-label="What Publish writes" className="rounded-lg border border-dashed border-border">
          <h3 className="caption border-b border-dashed border-border px-4 py-3">
            What Publish writes {dirty && <span className="ml-1 font-normal normal-case">· draft, not published</span>}
          </h3>
          <div className="px-3">
            <CodeBlock code={asCode(cfg)} lang="json" />
          </div>
        </section>
      </aside>
    </div>
  );
}
