import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Tooltip } from '@/ui';
import { Info } from 'lucide-react';
import { Members, type TeamScreen } from './Members';
import { apiCapabilitiesCached, apiListFlows, writeAppConfig } from '../../ipc';
import { gateProps, useAppConfig, useCallerCapabilities } from '../../hooks';
import { useDiscardGuard } from '../../navGuard';
import { CredentialsPanel } from './CredentialsPanel';
import { AutoMerge } from './AutoMerge';
import { combinationNote, effectiveRunLocation, legacySource, resolveTaskSource, RUN_LOCATIONS, runLocationOf, TASK_SOURCES, taskSourceOf } from '../../platform';
import { projectColor } from '../../color';
import { customProviderRowError, customProviderRows, PROVIDERS } from './customProviders';
import type { AppConfig } from '../../taskcell-output';
import { appConfigRangeErrors, type CustomProviderSpec } from '../../wire';
import { errorClause, errorMessage } from '../../errors';

/** `help`: what the setting does, behind an info icon next to the label (hover or focus). */
function Field({ label, hint, help, error, children }: { label: string; hint?: string; help?: string; error?: string | undefined; children: ReactNode }) {
  const field = (
    <label className="block space-y-1">
      <span className="text-sm">
        {label}
        {help && <Help text={help} />}
        {hint && <span className="ml-1 text-xs text-muted-foreground">{hint}</span>}
      </span>
      {children}
      {error !== undefined && <span role="alert" className="block text-xs text-destructive-text">{error}</span>}
    </label>
  );
  if (!help) return field;
  // Screen readers get the help as text after the field: inside the <label> it would join the field's name.
  return (
    <div>
      {field}
      <span className="sr-only">{help}</span>
    </div>
  );
}

/** The hover popup for sighted users; Field repeats the text for screen readers. */
function Help({ text }: { text: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          // Inside the field's <label>: a click must not move focus to the input.
          <span aria-hidden data-testid="field-help" onClick={(e) => e.preventDefault()} className="ml-1 inline-flex size-4 translate-y-0.5 cursor-help items-center justify-center text-muted-foreground hover:text-foreground" />
        }
      >
        <Info className="size-3.5" aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6}>
          <Tooltip.Popup className="z-50 max-w-xs rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed text-foreground shadow-md">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const SELECT_CLASS = 'h-9 w-full rounded border border-border bg-background px-2 text-sm';

function Select({
  value,
  onChange,
  options,
  danglingLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  /** Render a stored value missing from options as a flagged entry so display matches storage. */
  danglingLabel?: (v: string) => string;
}) {
  const dangling = value !== '' && !options.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">—</option>
      {dangling && (
        <option value={value}>{danglingLabel ? danglingLabel(value) : value}</option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function Settings({ project, teamScreen }: { project: string; teamScreen?: TeamScreen }) {
  // Inspector is keyed by project, so this component remounts on project switch —
  // config loads once and `dirty`/`saved` start clean without a reset effect.
  const [cfg, setCfg, cfgStatus] = useAppConfig(project);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveGate = useCallerCapabilities(project)?.project?.canChangeSettings;
  // The config as last read or saved: Discard goes back to it.
  const [lastSaved, setLastSaved] = useState<AppConfig | null>(null);
  useEffect(() => {
    if (cfgStatus === 'ready') setLastSaved((prev) => prev ?? cfg);
  }, [cfgStatus, cfg]);

  // Shell navigation unmounts this screen — see useDiscardGuard (S8 seam, #339 follow-up).
  useDiscardGuard(dirty, () => window.confirm('Discard unsaved changes to .taskcell/app.json?'));

  // Built-in flows (capabilities) + this repo's `.taskcell/flows/*.hcl`; a load failure just leaves the picker with the stored value.
  const [flowNames, setFlowNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [caps, repo] = await Promise.all([apiCapabilitiesCached(), apiListFlows(project)]);
        const names = [...caps.flows.map((f) => f.name), ...repo.flows.flatMap((f) => (f.name !== undefined && f.error === undefined ? [f.name] : []))];
        if (live) setFlowNames([...new Set(names)]);
      } catch {
        /* keep the empty list */
      }
    })();
    return () => { live = false; };
  }, [project]);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  };

  const customs: CustomProviderSpec[] = customProviderRows(cfg);
  const customErrors = customs.map((row, i) => customProviderRowError(row, i, customs));
  const customsValid = customErrors.every((e) => e === undefined);
  const healthyCustomNames = customs.filter((_, i) => customErrors[i] === undefined).map((r) => r.name);
  const providerOptions = [...PROVIDERS, ...healthyCustomNames];

  const setCustoms = (rows: CustomProviderSpec[]): void => set('customProviders', rows.length > 0 ? rows : undefined);
  const setRow = (i: number, patch: Partial<CustomProviderSpec>): void =>
    setCustoms(customs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Save gating (S6 §8 guards): before the config read resolves, a save would write the {} seed
  // over the file; after a FAILED read ('error' = the file exists but does not parse), a save
  // would replace the user's hand-edited JSON with defaults. Invalid custom rows also block.
  const rangeErrors = appConfigRangeErrors(cfg);
  const savable = dirty && cfgStatus === 'ready' && customsValid && Object.keys(rangeErrors).length === 0;

  // Latest cfg, readable after an await (the save closure's `cfg` is the render's snapshot).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const save = async (): Promise<void> => {
    const shipped = cfg; // the exact object written — dirty clears only if it is still current
    try {
      await writeAppConfig(project, shipped);
    } catch (e) {
      // The form keeps the user's input and stays dirty: they correct the named field and save again.
      setSaveError(errorMessage(e));
      return;
    }
    // An edit made while the write was in flight lives in cfg but NOT on disk. Clearing dirty would
    // disable Save and disarm the guard above, letting the next navigation discard it silently —
    // the same rule flowEditorReducer's saveOk follows. Every `set` builds a new object, so
    // reference identity is exactly "unchanged since save".
    setLastSaved(shipped);
    if (cfgRef.current !== shipped) return;
    setDirty(false);
    setSaved(true);
  };

  const discard = (): void => {
    if (lastSaved === null) return;
    setCfg(lastSaved);
    setDirty(false);
    setSaveError(null);
  };

  // Unset stays unset ("—"): the board needs an explicit source, so Settings must not display a default it never saves.
  const taskSource = resolveTaskSource(cfg);
  const note = combinationNote(taskSource, effectiveRunLocation(taskSource, cfg.runLocation));

  return (
    <div className="space-y-5">
      {/* Sticky: Save stays reachable however far the form scrolls. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-background py-1">
        <h2 className="text-xl font-semibold">Settings</h2>
        <code className="text-xs text-muted-foreground">.taskcell/app.json</code>
        {dirty && lastSaved !== null && (
          <Button className="ml-auto" variant="text" color="secondary" onClick={discard}>
            Discard changes
          </Button>
        )}
        <Button className={dirty && lastSaved !== null ? '' : 'ml-auto'} {...gateProps(saveGate)} onClick={save} disabled={!savable || saveGate?.allowed === false}>
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>
      {saveError !== null && (
        <p role="alert" className="text-sm text-destructive-text">
          Settings were not saved: {errorClause(saveError)}. Fix it and save again.
        </p>
      )}

      {teamScreen && <Members {...teamScreen} />}

      <AutoMerge project={project} />

      {cfgStatus === 'error' && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-muted-foreground">
          <span className="font-semibold text-destructive-text">.taskcell/app.json is unreadable</span> — fix
          its JSON by hand before editing here; saving now would replace the whole file.
        </div>
      )}

      {/* The form renders only once the read resolves: fields shown from the {} seed would accept
          edits that the resolving setCfg then silently discards — while dirty stays true, so the
          next Save persists the loaded config WITHOUT the user's edit (review #341 r3 obs 1; the
          local-file read resolves in ms, so the blank frame is invisible). */}
      {cfgStatus === 'loading' ? (
        <div className="rounded-lg border border-border p-5 text-sm text-muted-foreground">Loading…</div>
      ) : (
      <div
        className="space-y-4 rounded-lg border border-border p-5"
        // Enter in a single-line field saves, as a form would; a select or a button keeps its own Enter.
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement) || e.target.type === 'color' || !savable) return;
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Repository path">
          <Input value={project} readOnly className="w-full" />
        </Field>
        {/* Not a <Field> (which is a <label>) — a label would forward clicks on the readout/reset to
            the color input, opening the OS picker unexpectedly. Plain div; the input carries its own label. */}
        <div className="space-y-1">
          <span className="text-sm">
            Project color
            <span className="ml-1 text-xs text-muted-foreground">— context accent (top bar + dashboard card)</span>
          </span>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={projectColor({ path: project, color: cfg.color })}
              onChange={(e) => set('color', e.target.value)}
              aria-label="Project color"
              className="size-9 shrink-0 cursor-pointer rounded border border-border bg-background"
            />
            <code className="text-sm tabular-nums">{projectColor({ path: project, color: cfg.color })}</code>
            <span className="text-xs text-muted-foreground">{cfg.color ? 'custom' : 'auto from path'}</span>
            {cfg.color && (
              <Button variant="text" color="secondary" className="ml-auto" onClick={() => set('color', undefined)}>
                Reset to auto
              </Button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Task source" help="Where this project's tasks come from. The Board lists them, and the factory takes its work from here.">
            <select
              value={taskSource ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : taskSourceOf(e.target.value);
                set('taskSource', v);
                // `source` keeps feeding the board/transport/CLI; sources it does not read clear it.
                set('source', v && legacySource(v));
              }}
              className={SELECT_CLASS}
            >
              <option value="">—</option>
              {TASK_SOURCES.map((s) => (
                // A planned source cannot be picked; one already stored still shows as what it is.
                <option key={s.id} value={s.id} disabled={s.planned === true}>
                  {s.planned ? `${s.label} (planned)` : s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Runs on" help="Where a task's run happens: in your CI (GitHub Actions, GitLab CI), on a machine running taskcell watch, or in this hub on this computer.">
            <select
              value={effectiveRunLocation(taskSource, cfg.runLocation)}
              onChange={(e) => set('runLocation', runLocationOf(e.target.value))}
              className={SELECT_CLASS}
            >
              {RUN_LOCATIONS.map((r) => (
                // Still selectable: these run when set up by hand; only the hub's Enable factory cannot do it yet.
                <option key={r.id} value={r.id}>
                  {r.implemented ? r.label : `${r.label} (hub setup planned)`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {note && (
          <p role="note" className="text-xs text-muted-foreground">
            {note}
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Trigger label" help="The label that hands an issue to the factory. The Board lists only issues that carry it, New Task adds it, and a hub that runs tasks itself (Runs on: Local hub) starts the ones that get it. Empty: the Board lists every issue and the hub starts on the ready for agent label.">
            <Input
              value={cfg.label ?? ''}
              onChange={(e) => set('label', e.target.value || undefined)}
              className="w-full"
              placeholder="ready for agent"
            />
          </Field>
        </div>
        {taskSource === 'linear' && (
          <Field label="Linear team key" hint="— selects the board's team (e.g. DEV)">
            <Input
              value={cfg.team ?? ''}
              onChange={(e) => set('team', e.target.value.toUpperCase() || undefined)}
              className="w-full"
              placeholder="DEV"
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="AI provider" hint="— which model service runs the stages">
            {/* Built-ins + this repo's healthy customs; a stored name that no longer resolves shows
                flagged instead of silently rendering the em-dash while the value persists. */}
            <Select
              value={cfg.provider ?? ''}
              onChange={(v) => set('provider', v || undefined)}
              options={providerOptions}
              danglingLabel={(v) => `${v} (not configured)`}
            />
          </Field>
          <Field label="Review provider" hint="— optional; a different built-in provider to review the work (custom providers cannot review)">
            <Select
              value={cfg.reviewProvider ?? ''}
              onChange={(v) => set('reviewProvider', v || undefined)}
              options={PROVIDERS}
              danglingLabel={(v) => `${v} (not supported)`}
            />
          </Field>
        </div>
        <Field label="Flow" hint="— runs the Hub starts for this project use it, so the models set in the Workflow editor apply; — = the source default">
          <Select
            value={cfg.flow ?? ''}
            onChange={(v) => set('flow', v || undefined)}
            options={flowNames}
            danglingLabel={(v) => `${v} (not found)`}
          />
        </Field>
        <Field label="Verify command override" hint="— the Proof of Work">
          <Input
            value={cfg.verifyCmd ?? ''}
            onChange={(e) => set('verifyCmd', e.target.value || undefined)}
            className="w-full font-mono text-xs"
            placeholder="pnpm typecheck && pnpm test"
          />
        </Field>
        <Field label="Default target branch" hint="— where pull requests go when a card names none (default main)">
          <Input
            value={cfg.baseBranch ?? ''}
            onChange={(e) => set('baseBranch', e.target.value || undefined)}
            className="w-full font-mono text-xs"
            placeholder="main"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Parallel runs" hint="— how many tasks run at once (1 or more)" error={rangeErrors.concurrency}>
            <Input
              type="number"
              min={1}
              step={1}
              value={cfg.concurrency ?? ''}
              onChange={(e) => set('concurrency', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full"
            />
          </Field>
          <Field label="Budget cap per Run" error={rangeErrors.budgetUsd}>
            <Input
              type="number"
              min={0}
              value={cfg.budgetUsd ?? ''}
              onChange={(e) => set('budgetUsd', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full"
              placeholder="2.50"
            />
          </Field>
        </div>
        <Field label="Usage cap %" hint="— the factory stops starting work at this % of your plan window, leaving the rest as your reserve (1–100; empty = no cap)" error={rangeErrors.usageCapPct}>
          <Input
            type="number"
            min={1}
            max={100}
            value={cfg.usageCapPct ?? ''}
            onChange={(e) => set('usageCapPct', e.target.value ? Number(e.target.value) : undefined)}
            className="w-full"
            placeholder="80"
          />
        </Field>
        <Field label="Doc chat model" hint="— the Docs editor chat (uses your Claude auth from the environment)">
          <Input
            value={cfg.chatModel ?? ''}
            onChange={(e) => set('chatModel', e.target.value || undefined)}
            className="w-full font-mono text-xs"
            placeholder="claude-sonnet-5"
          />
        </Field>

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Custom providers</span>
            <span className="text-xs text-muted-foreground">
              — Anthropic-compatible endpoints run with <code>--provider &lt;name&gt;</code>
            </span>
            <Button
              variant="text"
              color="secondary"
              className="ml-auto"
              onClick={() => setCustoms([...customs, { name: '', baseUrl: '', keyEnv: '' }])}
            >
              Add
            </Button>
          </div>
          {customs.map((row, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provider name" hint="— lowercase, e.g. my-proxy">
                  <Input value={row.name} onChange={(e) => setRow(i, { name: e.target.value })} className="w-full font-mono text-xs" />
                </Field>
                <Field label="API key variable" hint="— the name of the environment variable that holds the key, never the key itself">
                  <Input
                    value={row.keyEnv}
                    onChange={(e) => setRow(i, { keyEnv: e.target.value })}
                    className="w-full font-mono text-xs"
                    placeholder="MY_PROXY_API_KEY"
                  />
                </Field>
              </div>
              <Field label="Endpoint URL" hint="— an Anthropic-compatible API endpoint">
                <Input
                  value={row.baseUrl}
                  onChange={(e) => setRow(i, { baseUrl: e.target.value })}
                  className="w-full font-mono text-xs"
                  placeholder="https://llm.example.com/api"
                />
              </Field>
              <div className="flex items-end gap-3">
                <Field label="Model" hint="— optional; the model to use when the endpoint does not serve Claude's">
                  <Input
                    value={row.model ?? ''}
                    onChange={(e) => setRow(i, { model: e.target.value || undefined })}
                    className="w-40 font-mono text-xs"
                    placeholder="glm-5.2"
                  />
                </Field>
                <Button
                  variant="text"
                  color="secondary"
                  className="ml-auto"
                  onClick={() => setCustoms(customs.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
              {customErrors[i] !== undefined && (
                <div className="text-xs text-destructive-text">{customErrors[i]}</div>
              )}
            </div>
          ))}
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="caption">
            Credentials
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            LLM credentials are inherited from your environment / keychain. Here they are never stored or sent
            over any API; a hub also stores its own instance credentials (see below). A custom provider stores only the <em>name</em> of the environment variable holding
            its key.
          </p>
        </div>
      </div>
      )}
      <CredentialsPanel />
    </div>
  );
}
