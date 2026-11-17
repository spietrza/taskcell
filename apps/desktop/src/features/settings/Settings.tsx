import { Button, Input } from '@/ui';
import { gateProps } from '../../hooks';
import { combinationNote, effectiveRunLocation, legacySource, resolveTaskSource, RUN_LOCATIONS, runLocationOf, TASK_SOURCES, taskSourceOf } from '../../platform';
import { projectColor } from '../../color';
import type { CustomProviderSpec } from '../../wire';
import { errorClause } from '../../errors';
import { Field, SELECT_CLASS } from './fields';
import { useConfigForm } from './configForm';
import { ChatModelField } from './ChatModelField';

/** The open project's settings (`.taskcell/app.json`). The team's members and repositories are a separate section of the screen. */
export function Settings({ project }: { project: string }) {
  const { cfg, cfgStatus, dirty, saved, saveError, saveGate, lastSaved, set, customs, customErrors, rangeErrors, savable, save, discard } = useConfigForm(project);

  const setCustoms = (rows: CustomProviderSpec[]): void => set('customProviders', rows.length > 0 ? rows : undefined);
  const setRow = (i: number, patch: Partial<CustomProviderSpec>): void =>
    setCustoms(customs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Unset stays unset ("—"): the board needs an explicit source, so Settings must not display a default it never saves.
  const taskSource = resolveTaskSource(cfg);
  const note = combinationNote(taskSource, effectiveRunLocation(taskSource, cfg.runLocation));

  return (
    <div className="space-y-5">
      {/* Sticky: Save stays reachable however far the form scrolls. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-background py-1">
        <h2 className="text-xl font-semibold">Project settings</h2>
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
          <Field label="Card source" help="Where this project's cards come from. The Board lists them, and the factory takes its work from here.">
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
          <Field label="Runs on" help="Where a card's run happens: in your CI (GitHub Actions, GitLab CI), on a machine running taskcell watch, or in this hub on this computer.">
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
          <Field label="Parallel runs" hint="— how many cards run at once (1 or more)" error={rangeErrors.concurrency}>
            <Input
              type="number"
              min={1}
              step={1}
              value={cfg.concurrency ?? ''}
              onChange={(e) => set('concurrency', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full"
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
        <ChatModelField project={project} value={cfg.chatModel ?? ''} onChange={(v) => set('chatModel', v)} />

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Anthropic-compatible endpoints (proxy)</span>
            <span className="text-xs text-muted-foreground">
              — Anthropic-compatible endpoints run with <code>--provider &lt;name&gt;</code>
            </span>
            <Button
              variant="text"
              color="secondary"
              className="ml-auto"
              onClick={() => setCustoms([...customs, { name: '', baseUrl: '' }])}
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
                <Field label="API key variable" hint="— the name of the environment variable that holds the key, never the key itself; leave empty for a proxy that holds its own auth">
                  <Input
                    value={row.keyEnv ?? ''}
                    onChange={(e) => setRow(i, { keyEnv: e.target.value || undefined })}
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
            over any API; a hub also stores its own instance credentials (Settings → Team &amp; hub). A custom provider stores only the <em>name</em> of the environment variable holding
            its key (an endpoint that holds its own auth needs none).
          </p>
        </div>
      </div>
      )}
    </div>
  );
}
