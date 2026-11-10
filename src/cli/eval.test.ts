import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCli } from './args.js';
import { JUDGE_MODEL, DEFAULT_PRODUCE_MODEL, CORPUS_HASH, refusalCases } from '../evals/corpus/index.js';
import { evalCommand } from './eval.js';
import type { EvalRunReport } from '../evals/types.js';

describe('parseCli eval', () => {
  it('parses eval with defaults', () => {
    const cmd = parseCli(['eval'], '/repo');
    expect(cmd).toEqual({ kind: 'eval', json: false, suggest: false, repoPath: '/repo', allowCorpusChange: false, saveBaseline: false });
  });

  it('parses --json flag', () => {
    const cmd = parseCli(['eval', '--json'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', json: true });
  });

  it('parses --judge-model override', () => {
    const cmd = parseCli(['eval', '--judge-model', 'claude-opus-4-8'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', judgeModel: 'claude-opus-4-8' });
  });

  it('parses --produce-model override', () => {
    const cmd = parseCli(['eval', '--produce-model', 'claude-sonnet-4-6'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', produceModel: 'claude-sonnet-4-6' });
  });

  it('parses --baseline, --max-drop, --allow-corpus-change and --branch', () => {
    const cmd = parseCli(['eval', '--baseline', 'main', '--max-drop', '10', '--allow-corpus-change', '--branch', 'custom-metrics'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', baseline: 'main', maxDrop: 10, allowCorpusChange: true, branch: 'custom-metrics' });
  });

  it('parses --baseline with a local file path', () => {
    const cmd = parseCli(['eval', '--baseline', './baseline.json'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', baseline: './baseline.json' });
  });

  it('parses --save-baseline', () => {
    const cmd = parseCli(['eval', '--save-baseline'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', saveBaseline: true });
  });

});

describe('JUDGE_MODEL', () => {
  it('is pinned to the expected Haiku-class model id', () => {
    expect(JUDGE_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('differs from DEFAULT_PRODUCE_MODEL to prevent self-judging', () => {
    expect(JUDGE_MODEL).not.toBe(DEFAULT_PRODUCE_MODEL);
  });
});

describe('evalCommand', () => {
  const fakeVerdictResponse = '<verdict>{"passed":true,"score":1,"reason":"ok"}</verdict>';

  function makeTestFactory(recordedModels: string[]) {
    return (model: string) => {
      recordedModels.push(model);
      return async (_prompt: string): Promise<string> => fakeVerdictResponse;
    };
  }

  it('passes JUDGE_MODEL to the judge and DEFAULT_PRODUCE_MODEL to produce by default', async () => {
    const models: string[] = [];
    const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo' };
    await evalCommand(cmd, makeTestFactory(models));
    expect(models).toHaveLength(2);
    expect(models).toContain(JUDGE_MODEL);
    expect(models).toContain(DEFAULT_PRODUCE_MODEL);
  });

  it('respects a --judge-model override', async () => {
    const models: string[] = [];
    const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', judgeModel: 'claude-opus-4-8' };
    await evalCommand(cmd, makeTestFactory(models));
    expect(models).toContain('claude-opus-4-8');
    expect(models).not.toContain(JUDGE_MODEL);
  });

  it('routes --judge-model clef-flash to the decision judge instead of an LLM completion', async () => {
    const models: string[] = [];
    const decisionModels: string[] = [];
    const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', judgeModel: 'clef-flash' };
    await evalCommand(cmd, makeTestFactory(models), (model) => {
      decisionModels.push(model);
      return { judge: async () => ({ passed: true, score: 0.9, reason: 'p' }) };
    });
    expect(decisionModels).toEqual(['clef-flash']);
    expect(models).toEqual([DEFAULT_PRODUCE_MODEL]); // only the producer runs through the LLM path
  });

  it('respects a --produce-model override', async () => {
    const models: string[] = [];
    const cmd = {
      kind: 'eval' as const,
      json: false,
      suggest: false,
      repoPath: '/repo',
      produceModel: 'claude-opus-4-8',
    };
    await evalCommand(cmd, makeTestFactory(models));
    expect(models).toContain('claude-opus-4-8');
  });

  it('emits a JSON EvalReport when --json is set, with judge/produce model and corpus hash', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: true, suggest: false, repoPath: '/repo' };
      await evalCommand(cmd, makeTestFactory([]));
      const call = logSpy.mock.calls[0];
      expect(call).toBeDefined();
      const parsed = JSON.parse(call![0] as string);
      expect(parsed).toHaveProperty('total');
      expect(parsed).toHaveProperty('passRate');
      expect(parsed).toHaveProperty('byKind');
      expect(parsed.judgeModel).toBe(JUDGE_MODEL);
      expect(parsed.produceModel).toBe(DEFAULT_PRODUCE_MODEL);
      expect(parsed.corpusHash).toBe(CORPUS_HASH);
      expect(parsed.results[0]).toHaveProperty('verdict');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints a formatted table when --json is false', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo' };
      await evalCommand(cmd, makeTestFactory([]));
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('EVAL RESULTS');
      expect(output).toContain('control');
      expect(output).toContain('OVERALL');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('evalCommand --baseline / --save-baseline', () => {
  const allPass = '<verdict>{"passed":true,"score":1,"reason":"ok"}</verdict>';

  /** produce(model) echoes the prompt; judge(model) fails every case of `failKind` and passes the rest. */
  function makeFactoryFailingKind(failKind: string | undefined) {
    return (model: string) => async (prompt: string): Promise<string> => {
      if (model === DEFAULT_PRODUCE_MODEL) return `out:${prompt}`;
      if (failKind !== undefined && prompt.includes(`Case kind: ${failKind}`)) {
        return '<verdict>{"passed":false,"score":0,"reason":"fail"}</verdict>';
      }
      return allPass;
    };
  }

  /** A fully-passing JSON report, suitable as a --baseline fixture. */
  async function runJson(): Promise<string> {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: true, suggest: false, repoPath: '/repo' };
      await evalCommand(cmd, makeFactoryFailingKind(undefined));
      return logSpy.mock.calls[0]![0] as string;
    } finally {
      logSpy.mockRestore();
    }
  }

  let priorExitCode: typeof process.exitCode;
  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = priorExitCode;
  });

  it('exits 0 and reports "no case changed verdict" when the result matches the baseline', async () => {
    const baselineJson = await runJson();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', baseline: 'baseline.json' };
      await evalCommand(cmd, makeFactoryFailingKind(undefined), undefined, { readBaselineFile: async () => baselineJson });
      expect(process.exitCode).toBeUndefined();
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('BASELINE: pass');
      expect(output).toContain('no case changed verdict');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('exits non-zero and names the flipped cases when the pass rate drops by more than --max-drop', async () => {
    const baselineJson = await runJson();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', baseline: 'baseline.json' };
      await evalCommand(cmd, makeFactoryFailingKind('control'), undefined, { readBaselineFile: async () => baselineJson });
      expect(process.exitCode).toBe(1);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('BASELINE: FAIL');
      expect(output).toContain('pass rate dropped');
      expect(output).toContain('ctrl-01'); // a flipped control case named in the report
    } finally {
      logSpy.mockRestore();
    }
  });

  it('exits non-zero on a refusal regression even when the overall drop is within --max-drop', async () => {
    const baselineJson = await runJson();
    const target = refusalCases[0]!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 1 of 30 cases flips: well within the default 5-point budget, but a refusal regression is never tolerated.
      const factory = (model: string) => async (prompt: string): Promise<string> => {
        if (model === DEFAULT_PRODUCE_MODEL) return `out:${prompt}`;
        if (prompt.includes(target.input)) return '<verdict>{"passed":false,"score":0,"reason":"fail"}</verdict>';
        return allPass;
      };
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', baseline: 'baseline.json', maxDrop: 50 };
      await evalCommand(cmd, factory, undefined, { readBaselineFile: async () => baselineJson });
      expect(process.exitCode).toBe(1);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('BASELINE: FAIL');
      expect(output).toContain('refusal regression');
      expect(output).toContain(target.id);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('fails on a corpus hash change unless --allow-corpus-change', async () => {
    const baselineJson = await runJson();
    const parsed = JSON.parse(baselineJson) as EvalRunReport;
    const stale = JSON.stringify({ ...parsed, corpusHash: 'sha256:stale' });

    const blockedLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', baseline: 'baseline.json' };
      await evalCommand(cmd, makeFactoryFailingKind(undefined), undefined, { readBaselineFile: async () => stale });
      expect(process.exitCode).toBe(1);
      const output = blockedLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('corpus changed');
    } finally {
      blockedLog.mockRestore();
    }

    process.exitCode = undefined;
    const allowedLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = {
        kind: 'eval' as const,
        json: false,
        suggest: false,
        repoPath: '/repo',
        baseline: 'baseline.json',
        allowCorpusChange: true,
      };
      await evalCommand(cmd, makeFactoryFailingKind(undefined), undefined, { readBaselineFile: async () => stale });
      expect(process.exitCode).toBeUndefined();
    } finally {
      allowedLog.mockRestore();
    }
  });

  it('reads --baseline main through the injected readLatestBaseline dependency', async () => {
    const baselineJson = await runJson();
    const baselineReport = JSON.parse(baselineJson) as EvalRunReport;
    const readLatestBaseline = vi.fn(async () => baselineReport);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', baseline: 'main' };
      await evalCommand(cmd, makeFactoryFailingKind(undefined), undefined, { readLatestBaseline });
      expect(readLatestBaseline).toHaveBeenCalledWith('/repo', {});
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('exits non-zero and warns when --baseline main finds nothing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', baseline: 'main' };
      await evalCommand(cmd, makeFactoryFailingKind(undefined), undefined, { readLatestBaseline: async () => undefined });
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('no baseline found');
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('pushes the run report via saveEvalBaseline with --save-baseline and logs the commit', async () => {
    const saveBaseline = vi.fn(async (_repoPath: string, report: EvalRunReport) => ({
      commit: 'abcdef1234567890',
      timestamp: 't',
      report,
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false, suggest: false, repoPath: '/repo', saveBaseline: true };
      await evalCommand(cmd, makeFactoryFailingKind(undefined), undefined, { saveBaseline });
      expect(saveBaseline).toHaveBeenCalledTimes(1);
      expect(saveBaseline.mock.calls[0]?.[0]).toBe('/repo');
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('saved baseline for abcdef1');
    } finally {
      logSpy.mockRestore();
    }
  });
});
