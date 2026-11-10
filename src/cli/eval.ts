import { readFile } from 'node:fs/promises';
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

/** Thin host-side completion: runs `claude --print --model <model>` with the prompt on stdin. */
export function makeCliComplete(model: string): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const result = await execa('claude', ['--print', '--model', model], { input: prompt });
    return result.stdout;
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
  const produce = (testCase: EvalCase) => produceComplete(testCase.input);

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
