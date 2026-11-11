import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runEvals } from '../evals/run-evals.js';
import { llmJudge } from '../evals/judges.js';
import { decisionJudge } from '../evals/decision-judge.js';
import { decisionModelConfig, decisionModelMissing, isDecisionModelName } from '../core/decision-model.js';
import { corpus, CORPUS_HASH, JUDGE_MODEL, DEFAULT_PRODUCE_MODEL } from '../evals/corpus/index.js';
import { formatEvalReport } from '../evals/eval-report.js';
import { compareToBaseline, formatBaselineComparison } from '../evals/baseline.js';
import { saveEvalBaseline, readLatestEvalBaseline } from '../evals/eval-baseline-branch.js';
import { evalSuggestCommand } from './eval-suggest.js';
import type { Judge, EvalCase, EvalRunReport } from '../evals/types.js';
import type { BaselineComparison } from '../evals/baseline.js';
import type { Command } from './args.js';

type EvalCommand = Extract<Command, { kind: 'eval' }>;

/** Everything evalCommand reads off disk/network, injectable for tests (no real git, no real baseline file). */
export interface EvalCommandDeps {
  readBaselineFile?: (path: string) => Promise<string>;
  saveBaseline?: typeof saveEvalBaseline;
  readLatestBaseline?: typeof readLatestEvalBaseline;
}

/** What the model under test receives for a case whose input is empty (the CLI refuses an empty prompt). */
export const EMPTY_TASK_PROMPT = '(The task description is empty.)';

/** `claude` flags for every eval call: print mode with every built-in tool and every MCP server disabled. */
export const EVAL_CLAUDE_ARGS = ['--print', '--tools', '', '--strict-mcp-config'] as const;

/**
 * One model call normally answers in 5-15s. The tool-less CLI occasionally hangs with no output (about 1 call
 * in 10 on the "Improve performance." case, #735), so a call is cut off after this and retried.
 */
export const EVAL_CALL_TIMEOUT_MS = 2 * 60_000;

/** Attempts per model call; only a timeout is retried (a hang is not the model's answer). */
export const EVAL_CALL_ATTEMPTS = 3;

/** The CLI's message when the API stops a reply on safety grounds; it exits non-zero but this is the model's answer. */
export const API_REFUSAL_RE = /API Error: .*(?:can't help with this|safeguards flagged this message)/;

/** Thin host-side completion: runs `claude --print --model <model>` with the prompt on stdin, tool-less, in a throwaway directory. */
export function makeCliComplete(model: string): (prompt: string) => Promise<string> {
  return async (prompt) => {
    // No tools, no MCP servers, and an empty working directory: the eval scores a reply, and the model
    // under test must never act on the host (a "clean up the repo" case once deleted local branches).
    const cwd = await mkdtemp(join(tmpdir(), 'taskcell-eval-'));
    try {
      const call = () => execa('claude', [...EVAL_CLAUDE_ARGS, '--model', model], { input: prompt, cwd, reject: false, timeout: EVAL_CALL_TIMEOUT_MS });
      let result = await call();
      for (let attempt = 2; result.timedOut && attempt <= EVAL_CALL_ATTEMPTS; attempt++) result = await call();
      if (result.timedOut) throw new Error(`claude --print --model ${model} timed out ${EVAL_CALL_ATTEMPTS}x after ${EVAL_CALL_TIMEOUT_MS / 1000}s: ${((result.stderr || result.stdout) || '(no output)').trim().slice(0, 500)}`);
      if (result.exitCode === 0) return result.stdout;
      // A safety stop is the model's answer (and the right one for a refusal case), not an infra failure.
      if (API_REFUSAL_RE.test(result.stdout)) return result.stdout;
      throw new Error(`claude --print --model ${model} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

/** Parse a `--baseline <file>` payload, naming the file when it does not hold a JSON report. */
function parseBaselineFile(path: string, text: string): EvalRunReport {
  try {
    return JSON.parse(text) as EvalRunReport;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--baseline ${path}: not a valid eval report (${message})`);
  }
}

/** A decision model as the judge: calibrated P(acceptable) instead of an LLM's self-rated JSON. */
export function makeDecisionJudge(model: string, env: NodeJS.ProcessEnv = process.env): Judge {
  const config = decisionModelConfig(env, model);
  if (config === undefined) throw new Error(`--judge-model ${model}: ${decisionModelMissing(model, env)}`);
  return decisionJudge(config);
}

/**
 * Run the committed eval corpus and print a per-kind pass-rate report. With `--baseline <file|main>`
 * it also gates the run against a saved baseline (see baseline.ts); with `--save-baseline` it pushes
 * this run's report to the metrics branch, keyed by the current commit, after any comparison.
 * makeComplete/makeDecision/deps are injectable for testing (no real `claude` CLI, no real git).
 */
export async function evalCommand(
  cmd: EvalCommand,
  makeComplete: (model: string) => (prompt: string) => Promise<string> = makeCliComplete,
  makeDecision: (model: string) => Judge = makeDecisionJudge,
  deps: EvalCommandDeps = {},
): Promise<void> {
  if (cmd.suggest) {
    await evalSuggestCommand(cmd);
    return;
  }

  const judgeModel = cmd.judgeModel ?? JUDGE_MODEL;
  const produceModel = cmd.produceModel ?? DEFAULT_PRODUCE_MODEL;

  const produceComplete = makeComplete(produceModel);

  const judge = isDecisionModelName(judgeModel) ? makeDecision(judgeModel) : llmJudge(makeComplete(judgeModel));
  // `claude --print` rejects an empty prompt, so the empty-input edge case sends a stand-in that says so.
  const produce = (testCase: EvalCase) =>
    produceComplete(testCase.input.trim() === '' ? EMPTY_TASK_PROMPT : testCase.input);

  const report = await runEvals({ cases: corpus, produce, judge });
  const runReport: EvalRunReport = { ...report, judgeModel, produceModel, corpusHash: CORPUS_HASH };

  const readBaselineFile = deps.readBaselineFile ?? ((path: string) => readFile(path, 'utf8'));
  const save = deps.saveBaseline ?? saveEvalBaseline;
  const readLatest = deps.readLatestBaseline ?? readLatestEvalBaseline;
  const branchOpts = cmd.branch !== undefined ? { branch: cmd.branch } : {};

  // Compare before saving: with both flags, saving first would publish this run and then compare it
  // against itself (`--baseline main` reads the most recent record), which can never fail.
  let comparison: BaselineComparison | undefined;
  if (cmd.baseline !== undefined) {
    const baselineReport =
      cmd.baseline === 'main'
        ? await readLatest(cmd.repoPath, branchOpts)
        : parseBaselineFile(cmd.baseline, await readBaselineFile(cmd.baseline));
    if (baselineReport === undefined) {
      console.error(`vanguard eval: no baseline found for "${cmd.baseline}"`);
      process.exitCode = 1;
    } else {
      comparison = compareToBaseline(runReport, baselineReport, {
        ...(cmd.maxDrop !== undefined ? { maxDropPoints: cmd.maxDrop } : {}),
        allowCorpusChange: cmd.allowCorpusChange === true,
      });
      if (!comparison.ok) process.exitCode = 1;
    }
  }

  if (cmd.saveBaseline === true) {
    const saved = await save(cmd.repoPath, runReport, branchOpts);
    console.log(`vanguard eval: saved baseline for ${saved.commit.slice(0, 7)}`);
  }

  if (cmd.json) {
    console.log(JSON.stringify(comparison !== undefined ? { ...runReport, baseline: comparison } : runReport, null, 2));
    return;
  }
  console.log(formatEvalReport(runReport));
  if (comparison !== undefined) console.log(formatBaselineComparison(comparison));
}
