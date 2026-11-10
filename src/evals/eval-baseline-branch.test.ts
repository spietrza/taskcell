import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { saveEvalBaseline, readLatestEvalBaseline, currentCommit, EVAL_BASELINES_FILE } from './eval-baseline-branch.js';
import { METRICS_BRANCH_DEFAULT } from '../core/metrics-branch.js';
import type { EvalRunReport } from './types.js';

let root: string;
let origin: string;
let repo: string;

async function clone(name: string): Promise<string> {
  const path = join(root, name);
  await execa('git', ['clone', '--quiet', origin, path]);
  await execa('git', ['-C', path, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', path, 'config', 'user.name', 't']);
  return path;
}

function reportFor(passRate: number): EvalRunReport {
  return {
    total: 10,
    passed: Math.round(passRate * 10),
    failed: 10 - Math.round(passRate * 10),
    passRate,
    byKind: {
      control: { total: 4, passed: 4 },
      edge: { total: 3, passed: 3 },
      refusal: { total: 3, passed: 3 },
    },
    results: [],
    judgeModel: 'claude-haiku-4-5-20251001',
    produceModel: 'claude-sonnet-5-5',
    corpusHash: 'sha256:fixed',
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-eval-baseline-'));
  origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  await execa('git', ['init', '--quiet', '-b', 'main', seed]);
  await execa('git', ['-C', seed, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', seed, 'config', 'user.name', 't']);
  await execa('git', ['-C', seed, 'commit', '--quiet', '--allow-empty', '-m', 'seed']);
  await execa('git', ['-C', seed, 'push', '--quiet', origin, 'main']);
  repo = await clone('repo');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('saveEvalBaseline / readLatestEvalBaseline', () => {
  it('round-trips a report through the metrics branch, keyed by commit', async () => {
    const sha = await currentCommit(repo);
    const saved = await saveEvalBaseline(repo, reportFor(0.9), { commit: sha, timestamp: '2026-11-10T00:00:00.000Z' });
    expect(saved.commit).toBe(sha);

    const read = await readLatestEvalBaseline(repo);
    expect(read).toEqual(reportFor(0.9));

    const tree = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree.trim()).toBe(EVAL_BASELINES_FILE);
  });

  it('returns undefined when no baseline has been pushed yet', async () => {
    expect(await readLatestEvalBaseline(repo)).toBeUndefined();
  });

  it('reads the most recently pushed baseline when more than one commit was saved', async () => {
    await saveEvalBaseline(repo, reportFor(0.8), { commit: 'sha1' });
    await saveEvalBaseline(repo, reportFor(0.95), { commit: 'sha2' });
    const read = await readLatestEvalBaseline(repo);
    expect(read).toEqual(reportFor(0.95));
  });

  it('is a no-op for a re-save on the same commit', async () => {
    await saveEvalBaseline(repo, reportFor(0.8), { commit: 'sha1' });
    await saveEvalBaseline(repo, reportFor(0.99), { commit: 'sha1' });
    const read = await readLatestEvalBaseline(repo);
    // The first push for a commit wins; a later save under the same key is dropped, same as metrics-branch dedupe.
    expect(read).toEqual(reportFor(0.8));
  });

  it('honours a custom branch name', async () => {
    await saveEvalBaseline(repo, reportFor(0.8), { commit: 'sha1', branch: 'team-metrics' });
    expect(await readLatestEvalBaseline(repo, { branch: 'team-metrics' })).toEqual(reportFor(0.8));
    expect(await readLatestEvalBaseline(repo)).toBeUndefined();
  });

  it('appends a second checkout on top of the existing tip without clobbering it', async () => {
    await saveEvalBaseline(repo, reportFor(0.8), { commit: 'sha1' });
    const other = await clone('other');
    await saveEvalBaseline(other, reportFor(0.9), { commit: 'sha2' });
    expect(await readLatestEvalBaseline(repo)).toEqual(reportFor(0.9));
  });
});
