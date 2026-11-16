/** One row of a stage's model pool in the Workflow editor: `provider/model:weight`. */
export interface PoolRow {
  provider: string;
  model: string;
  weight: number;
}

/** Same rule as the CLI (src/core/model-pool.ts): a comma or a `:<weight>` suffix makes a pool; anything else is one model. */
export function isPoolValue(value: string | undefined): boolean {
  return value !== undefined && (value.includes(',') || /:\d+\s*$/.test(value));
}

/** Rows of a pool value; an entry that does not parse keeps its text in `model` so nothing is lost while editing. */
export function parsePoolRows(value: string): PoolRow[] {
  return value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((part) => {
      const w = /:(\d+)\s*$/.exec(part);
      const body = w !== null ? part.slice(0, w.index) : part;
      const slash = body.indexOf('/');
      return {
        provider: slash > 0 ? body.slice(0, slash) : '',
        model: slash > 0 ? body.slice(slash + 1) : body,
        weight: w !== null ? Number(w[1]) : 1,
      };
    });
}

/** The `model` value for the flow file; rows without a provider or model are dropped. Always carries weights, so even one row stays a pool. */
export function formatPoolRows(rows: readonly PoolRow[]): string | undefined {
  const kept = rows.filter((r) => r.provider !== '' && r.model.trim() !== '');
  if (kept.length === 0) return undefined;
  return kept.map((r) => `${r.provider}/${r.model.trim()}:${Math.max(1, Math.trunc(r.weight) || 1)}`).join(', ');
}
