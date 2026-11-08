/** The four metrics vitest's v8 coverage provider reports and gates on. */
export interface CoverageMetrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/** Subset of istanbul's `coverage-summary.json` shape we read (the `total` row). */
export interface CoverageSummaryJson {
  total: {
    statements: { pct: number };
    branches: { pct: number };
    functions: { pct: number };
    lines: { pct: number };
  };
}

/** The four metrics, in report/CLI order. */
const METRICS: (keyof CoverageMetrics)[] = ['statements', 'branches', 'functions', 'lines'];

/** Pure. Extract the four summary percentages from a parsed coverage-summary.json. */
export function extractActualMetrics(summary: CoverageSummaryJson): CoverageMetrics {
  return {
    statements: summary.total.statements.pct,
    branches: summary.total.branches.pct,
    functions: summary.total.functions.pct,
    lines: summary.total.lines.pct,
  };
}

/** Pure. Ratchet a single metric: floor(actual) - 2, but never below the current threshold. */
export function proposeThreshold(actualPct: number, currentThreshold: number): number {
  return Math.max(currentThreshold, Math.floor(actualPct) - 2);
}

/** Pure. Ratchet all four metrics; never lowers any of them below `current`. */
export function computeRatchetedThresholds(actual: CoverageMetrics, current: CoverageMetrics): CoverageMetrics {
  return {
    statements: proposeThreshold(actual.statements, current.statements),
    branches: proposeThreshold(actual.branches, current.branches),
    functions: proposeThreshold(actual.functions, current.functions),
    lines: proposeThreshold(actual.lines, current.lines),
  };
}

const THRESHOLDS_RE =
  /thresholds:\s*\{\s*statements:\s*(\d+),\s*branches:\s*(\d+),\s*functions:\s*(\d+),\s*lines:\s*(\d+)\s*\}/;

/** Pure. Read the `thresholds: { ... }` line out of a vitest.config.ts source string. */
export function parseCurrentThresholds(source: string): CoverageMetrics {
  const match = THRESHOLDS_RE.exec(source);
  if (match === null) {
    throw new Error('coverage-ratchet: could not find a `thresholds: { statements, branches, functions, lines }` block in vitest.config.ts');
  }
  const [, statements, branches, functions, lines] = match;
  return { statements: Number(statements), branches: Number(branches), functions: Number(functions), lines: Number(lines) };
}

/** Pure. Rewrite the `thresholds: { ... }` line in a vitest.config.ts source string to `next`. */
export function updateThresholdsInSource(source: string, next: CoverageMetrics): string {
  if (!THRESHOLDS_RE.test(source)) {
    throw new Error('coverage-ratchet: could not find a `thresholds: { statements, branches, functions, lines }` block in vitest.config.ts');
  }
  const replacement = `thresholds: { statements: ${next.statements}, branches: ${next.branches}, functions: ${next.functions}, lines: ${next.lines} }`;
  return source.replace(THRESHOLDS_RE, replacement);
}

/** Format a before/after report for the CLI. */
export function formatRatchetReport(current: CoverageMetrics, actual: CoverageMetrics, proposed: CoverageMetrics): string {
  const lines = ['metric       actual   current -> proposed'];
  for (const m of METRICS) {
    const name = m.padEnd(12);
    const actualStr = actual[m].toFixed(2).padStart(6);
    lines.push(`${name} ${actualStr}   ${current[m]} -> ${proposed[m]}`);
  }
  return lines.join('\n');
}
