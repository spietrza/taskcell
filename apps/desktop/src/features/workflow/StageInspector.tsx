import { useState, type ReactNode } from 'react';
import { Button, Input } from '@/ui';
import { Plus, Trash2 } from 'lucide-react';
import { formatPoolRows, isPoolValue, parsePoolRows, type PoolRow } from './modelPool';
import { EnumSelect } from '../inspector/EnumSelect';
import { providerLabel, selectableProviders } from '../settings/customProviders';
import type { StageDecl, StageOverrides } from '../../ipc';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Sentinel for "no override — inherit the library default" in the selects. */
const INHERIT = '';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Override editor for the selected stage (S5 §18). Every field maps 1:1 to a StageOverrides key
 * (empty = no override, the library default applies); `name` selects from the capabilities stage
 * palette — a name that is in neither the palette nor backed by a ref is shown as "(not in
 * library)" so a broken hand-authored flow can be FIXED here rather than being unopenable.
 */
export function StageInspector({
  stage,
  palette,
  providers,
  onSetName,
  onSetRef,
  onSetOverride,
  onRemove,
}: {
  stage: StageDecl;
  palette: string[];
  providers: string[];
  onSetName: (name: string) => void;
  onSetRef: (ref: string) => void;
  onSetOverride: <K extends keyof StageOverrides>(key: K, value: StageOverrides[K]) => void;
  onRemove: () => void;
}) {
  const nameOptions = [
    ...palette.map((s) => ({ value: s, label: s })),
    ...(palette.includes(stage.name) ? [] : [{ value: stage.name, label: `${stage.name} (not in library)` }]),
  ];
  const o = stage.overrides;
  // Draft for an in-progress invalid max_turns. The PARENT must key this component by the
  // selected index (WorkflowEditor does) so a lingering draft never displays on another stage.
  const [maxTurnsDraft, setMaxTurnsDraft] = useState<string | null>(null);
  // Model pool (entries + weights), stored in the flow as the stage's `model`: `claude/sonnet:3, codex/gpt-6-sol:1`.
  const [poolMode, setPoolMode] = useState(isPoolValue(o.model));
  const [poolRows, setPoolRows] = useState<PoolRow[]>(isPoolValue(o.model) ? parsePoolRows(o.model ?? '') : []);
  const setRows = (rows: PoolRow[]): void => {
    setPoolRows(rows);
    onSetOverride('model', formatPoolRows(rows));
  };
  const updateRow = (i: number, patch: Partial<PoolRow>): void => setRows(poolRows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const newRow = (model: string): PoolRow => ({ provider: providers[0] ?? 'claude', model, weight: 1 });

  return (
    <div className="space-y-3">
      <Field label="Stage">
        <EnumSelect value={stage.name} onValueChange={onSetName} options={nameOptions} />
      </Field>
      <Field label="ref (custom TS step, relpath#export under .taskcell/)">
        <Input
          value={stage.ref ?? ''}
          onChange={(e) => onSetRef(e.target.value)}
          placeholder="scripts/custom.ts#myStage"
          className="w-full font-mono text-xs"
        />
      </Field>
      <Field label="pool (weighted rotation across providers)">
        <EnumSelect
          value={poolMode ? 'pool' : 'single'}
          onValueChange={(v) => {
            const pool = v === 'pool';
            setPoolMode(pool);
            if (pool && !isPoolValue(o.model)) {
              setRows([newRow(o.model ?? '')]);
            } else if (!pool && isPoolValue(o.model)) {
              onSetOverride('model', undefined);
            }
          }}
          options={[{ value: 'single', label: 'off: one model' }, { value: 'pool', label: 'on: entries + weights' }]}
        />
      </Field>
      {poolMode ? (
          <div className="space-y-1" aria-label="model pool">
            {poolRows.map((row, i) => (
              <div key={i} className="flex items-center gap-1">
                <EnumSelect
                  value={row.provider}
                  onValueChange={(v) => updateRow(i, { provider: v })}
                  options={[...new Set([...selectableProviders(providers, row.provider), ...(row.provider !== '' ? [row.provider] : [])])].map((p) => ({ value: p, label: providerLabel(p) }))}
                />
                <Input aria-label={`pool entry ${i + 1} id`} value={row.model} onChange={(e) => updateRow(i, { model: e.target.value })} className="flex-1 font-mono text-xs" placeholder="id" />
                <Input aria-label={`pool weight ${i + 1}`} type="number" min={1} value={row.weight} onChange={(e) => updateRow(i, { weight: Math.max(1, Math.trunc(Number(e.target.value)) || 1) })} className="w-16" />
                <Button variant="text" color="secondary" aria-label={`remove pool entry ${i + 1}`} onClick={() => setRows(poolRows.filter((_, j) => j !== i))} startIcon={<Trash2 className="size-4" />} />
              </div>
            ))}
            <Button variant="text" color="secondary" onClick={() => setRows([...poolRows, newRow('')])} startIcon={<Plus className="size-4" />}>
              Add entry
            </Button>
            <span className="block text-xs text-muted-foreground">Each run picks one entry by weight from its card id; an entry out of quota is skipped until its reset.</span>
          </div>
      ) : (
        <Field label="model (empty = library default)">
          <Input value={o.model ?? ''} onChange={(e) => onSetOverride('model', e.target.value || undefined)} className="w-full" />
        </Field>
      )}
      <Field label="effort">
        <EnumSelect
          value={o.effort ?? INHERIT}
          onValueChange={(v) => onSetOverride('effort', v === INHERIT ? undefined : (v as StageOverrides['effort']))}
          options={[{ value: INHERIT, label: 'inherit' }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
        />
      </Field>
      <Field label="max_turns">
        <Input
          type="number"
          value={maxTurnsDraft ?? o.maxTurns ?? ''}
          onChange={(e) => {
            const text = e.target.value;
            const n = Number(text);
            if (text === '') {
              setMaxTurnsDraft(null);
              onSetOverride('maxTurns', undefined);
            } else if (Number.isInteger(n) && n > 0) {
              setMaxTurnsDraft(null);
              onSetOverride('maxTurns', n);
            } else {
              // Invalid input previously no-op'd — the field silently snapped back. Hold the
              // draft and say why instead (S8 item 3).
              setMaxTurnsDraft(text);
            }
          }}
          onBlur={() => setMaxTurnsDraft(null)}
          className="w-full"
        />
        {maxTurnsDraft !== null && (
          <span className="text-xs text-destructive-text">positive integer only</span>
        )}
      </Field>
      <Field label="provider">
        <EnumSelect
          value={o.provider ?? INHERIT}
          onValueChange={(v) => onSetOverride('provider', v === INHERIT ? undefined : v)}
          options={[{ value: INHERIT, label: 'inherit' }, ...selectableProviders(providers, o.provider).map((p) => ({ value: p, label: providerLabel(p) }))]}
        />
      </Field>
      <Field label="resume_previous">
        <EnumSelect
          value={o.resumePrevious === undefined ? INHERIT : String(o.resumePrevious)}
          onValueChange={(v) => onSetOverride('resumePrevious', v === INHERIT ? undefined : v === 'true')}
          options={[
            { value: INHERIT, label: 'inherit' },
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
        />
      </Field>
      <Button variant="text" color="secondary" onClick={onRemove} startIcon={<Trash2 className="size-4" />}>
        Remove stage
      </Button>
    </div>
  );
}
