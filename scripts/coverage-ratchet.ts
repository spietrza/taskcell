#!/usr/bin/env tsx
// Runs the full coverage suite, then proposes (or writes) raised vitest.config.ts thresholds.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  computeRatchetedThresholds,
  extractActualMetrics,
  formatRatchetReport,
  parseCurrentThresholds,
  updateThresholdsInSource,
  type CoverageSummaryJson,
} from '../src/core/coverage-ratchet.js';

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const repo = process.cwd();
  const configPath = join(repo, 'vitest.config.ts');
  const summaryPath = join(repo, 'coverage', 'coverage-summary.json');

  await rm(summaryPath, { force: true });

  console.log('coverage-ratchet: running the suite with coverage (this takes a while)...');
  await execa(
    'vitest',
    ['run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=text-summary'],
    { cwd: repo, stdio: 'inherit' },
  );

  const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as CoverageSummaryJson;
  const actual = extractActualMetrics(summary);

  const configSource = await readFile(configPath, 'utf8');
  const current = parseCurrentThresholds(configSource);
  const proposed = computeRatchetedThresholds(actual, current);

  console.log(formatRatchetReport(current, actual, proposed));

  if (write) {
    await writeFile(configPath, updateThresholdsInSource(configSource, proposed));
    console.log('\ncoverage-ratchet: wrote proposed thresholds to vitest.config.ts');
  } else {
    console.log('\ncoverage-ratchet: dry run, pass --write to update vitest.config.ts');
  }
}

await main();
