import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdir, rm } from 'node:fs/promises';
import { execa } from 'execa';
import { makeScratchRepo, makeCloseCallJudge, parseBenchModel, reviewerBenchCommand } from './eval-reviewer-bench.js';
import { parseCli } from './args.js';

const dataset = JSON.stringify([{ id: 'p1', repo: 'o/r', diff: 'd', comments: [{ path: 'a.ts', line: 3, text: 'bug' }] }]);
const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '.', reviewerBench: true, benchModels: 'codex/gpt-6-sol' };

afterEach(() => vi.restoreAllMocks());

describe('reviewerBenchCommand', () => {
  it('prints the dataset hash and per-model metrics using the injected reviewer', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await reviewerBenchCommand(cmd, {
      readDataset: async () => dataset,
      review: async () => ({ findings: [{ severity: 'high', kind: 'correctness', title: 't', evidence: 'a.ts:3' }], completed: true, tokens: 5, durationMs: 1000 }),
    });
    const out = String(log.mock.calls[0]?.[0]);
    expect(out).toContain('data/v2');
    expect(out).toMatch(/sha256:[0-9a-f]{64}/);
    expect(out).toContain('precision 100.0%');
  });
  it('requires --bench-models', async () => {
    await expect(reviewerBenchCommand({ kind: 'eval', json: false, suggest: false, repoPath: '.', reviewerBench: true }, { readDataset: async () => dataset })).rejects.toThrow(/bench-models/);
  });
});

describe('helpers', () => {
  it('parses provider/model and rejects unknown providers', () => {
    expect(parseBenchModel('codex/gpt-6-sol')).toEqual({ provider: 'codex', model: 'gpt-6-sol' });
    expect(parseBenchModel('claude')).toEqual({ provider: 'claude' });
    expect(() => parseBenchModel('nope/x')).toThrow(/unknown provider/);
  });
  it('judge says yes only for a YES reply', async () => {
    const f = { severity: 'low' as const, kind: 'style' as const, title: 't', evidence: 'e' };
    const i = { file: 'a', startLine: 1, endLine: 1, text: 'x' };
    expect(await makeCloseCallJudge(async () => 'YES')(f, i)).toBe(true);
    expect(await makeCloseCallJudge(async () => 'NO, YES')(f, i)).toBe(false);
  });
  it('parses the eval bench flags', () => {
    expect(parseCli(['eval', '--reviewer-bench', '--bench-sample', '7', '--bench-models', 'a/b'], '/repo')).toMatchObject({ kind: 'eval', reviewerBench: true, benchSample: 7, benchModels: 'a/b' });
  });
});

describe('makeScratchRepo', () => {
  it('is an empty git repo on main, not the working checkout', async () => {
    const dir = await makeScratchRepo();
    try {
      expect((await execa('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout).toBe('main');
      expect((await readdir(dir)).filter((f) => f !== '.git')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
