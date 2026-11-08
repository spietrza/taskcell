import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, it, expect } from 'vitest';
import {
  computeRatchetedThresholds,
  extractActualMetrics,
  parseCurrentThresholds,
  proposeThreshold,
  updateThresholdsInSource,
  type CoverageMetrics,
} from './coverage-ratchet.js';

describe('proposeThreshold', () => {
  it('ratchets up when actual is higher: floor(actual) - 2', () => {
    expect(proposeThreshold(85.7, 78)).toBe(83);
  });

  it('holds steady when actual - 2 equals the current threshold', () => {
    expect(proposeThreshold(80.0, 78)).toBe(78);
  });

  it('never lowers the threshold when actual is lower than current + 2', () => {
    expect(proposeThreshold(79.0, 78)).toBe(78);
  });

  it('never lowers the threshold when actual dropped well below current', () => {
    expect(proposeThreshold(50.0, 78)).toBe(78);
  });
});

describe('computeRatchetedThresholds', () => {
  const current: CoverageMetrics = { statements: 78, branches: 66, functions: 73, lines: 80 };

  it('raises every metric that improved by at least 2 points', () => {
    const actual: CoverageMetrics = { statements: 90.1, branches: 80.9, functions: 95.0, lines: 92.3 };
    expect(computeRatchetedThresholds(actual, current)).toEqual({ statements: 88, branches: 78, functions: 93, lines: 90 });
  });

  it('is a no-op when actuals regressed below current', () => {
    const actual: CoverageMetrics = { statements: 10, branches: 10, functions: 10, lines: 10 };
    expect(computeRatchetedThresholds(actual, current)).toEqual(current);
  });

  it('mixes raised and held-steady metrics independently', () => {
    const actual: CoverageMetrics = { statements: 95, branches: 20, functions: 73, lines: 80 };
    expect(computeRatchetedThresholds(actual, current)).toEqual({ statements: 93, branches: 66, functions: 73, lines: 80 });
  });
});

describe('extractActualMetrics', () => {
  it('pulls the four pct fields off the total row', () => {
    const summary = {
      total: {
        statements: { pct: 91.23 },
        branches: { pct: 77.5 },
        functions: { pct: 88.0 },
        lines: { pct: 92.1 },
      },
    };
    expect(extractActualMetrics(summary)).toEqual({ statements: 91.23, branches: 77.5, functions: 88.0, lines: 92.1 });
  });
});

describe('parseCurrentThresholds / updateThresholdsInSource', () => {
  const source = [
    'export default defineConfig({',
    '  test: {',
    '    coverage: {',
    '      thresholds: { statements: 78, branches: 66, functions: 73, lines: 80 },',
    '    },',
    '  },',
    '});',
    '',
  ].join('\n');

  it('parses the existing thresholds block', () => {
    expect(parseCurrentThresholds(source)).toEqual({ statements: 78, branches: 66, functions: 73, lines: 80 });
  });

  it('throws when no thresholds block is present', () => {
    expect(() => parseCurrentThresholds('export default {}')).toThrow();
  });

  it('rewrites only the thresholds block, leaving the rest of the file intact', () => {
    const next: CoverageMetrics = { statements: 88, branches: 78, functions: 93, lines: 90 };
    const updated = updateThresholdsInSource(source, next);
    expect(updated).toContain('thresholds: { statements: 88, branches: 78, functions: 93, lines: 90 }');
    expect(parseCurrentThresholds(updated)).toEqual(next);
    expect(updated.replace(/thresholds:.*/, '')).toBe(source.replace(/thresholds:.*/, ''));
  });

  it('throws when asked to rewrite a file with no thresholds block', () => {
    expect(() => updateThresholdsInSource('export default {}', { statements: 1, branches: 1, functions: 1, lines: 1 })).toThrow();
  });
});

describe('coverage-ratchet runner', () => {
  it.each(['success', 'dry-run', 'failure', 'missing-summary'])('handles %s without trusting stale coverage', async (mode) => {
    const repo = await mkdtemp(join(tmpdir(), 'coverage-ratchet-'));
    const config = 'thresholds: { statements: 78, branches: 66, functions: 73, lines: 80 }';
    const summary = JSON.stringify({ total: Object.fromEntries(
      ['statements', 'branches', 'functions', 'lines'].map((metric) => [metric, { pct: 95 }]),
    ) });
    try {
      await mkdir(join(repo, 'coverage'));
      await writeFile(join(repo, 'vitest.config.ts'), config);
      await writeFile(join(repo, 'coverage', 'coverage-summary.json'), summary);
      await writeFile(join(repo, 'coverage', 'keep.txt'), 'existing report');
      await writeFile(join(repo, 'vitest'), `#!/usr/bin/env node
const fs = require('node:fs');
${mode !== 'missing-summary' ? `fs.writeFileSync('coverage/coverage-summary.json', ${JSON.stringify(summary)});` : ''}
process.exit(${mode === 'failure' ? 1 : 0});
`, { mode: 0o755 });
      const result = await execa(process.execPath, [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../../scripts/coverage-ratchet.ts', import.meta.url)),
        ...(mode === 'dry-run' ? [] : ['--write']),
      ], { cwd: repo, env: { PATH: `${repo}${delimiter}${process.env.PATH}` }, reject: false });
      const updated = await readFile(join(repo, 'vitest.config.ts'), 'utf8');
      if (mode === 'success') {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(parseCurrentThresholds(updated)).toEqual({ statements: 93, branches: 93, functions: 93, lines: 93 });
      } else if (mode === 'dry-run') {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(updated).toBe(config);
      } else {
        expect(result.exitCode).not.toBe(0);
        expect(updated).toBe(config);
      }
      expect(await readFile(join(repo, 'coverage', 'keep.txt'), 'utf8')).toBe('existing report');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
