import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { agentAuthFromEnv } from '../agents/auth.js';
import { isProviderName } from '../agents/registry.js';
import { estimatedCostUsd } from '../core/run-metric.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { openAgentSession } from '../runners/agent-session.js';
import {
  AACR_DATASET, AACR_DEFAULT_SAMPLE, AACR_VERSION, datasetHash, findingsOfReply, formatBenchReport, parseAacrDataset,
  runReviewerBench, samplePrs,
} from '../evals/reviewer-bench.js';
import type { BenchPr, BenchReport, CloseCallJudge, ReviewRun } from '../evals/reviewer-bench.js';
import type { ProviderName } from '../agents/registry.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { SummaryOutcome } from '../core/run-summary.js';
import type { PullRequestForReview } from '../runners/pr-review.js';
import { runDefaultReviewer } from './review-pr.js';
import { makeCliComplete } from './eval.js';
import type { Command } from './args.js';

type EvalCommand = Extract<Command, { kind: 'eval' }>;

/** Dataset file pinned to the `data/v2` directory; override with --bench-dataset (a local path or URL). */
export const AACR_DEFAULT_URL = `https://huggingface.co/datasets/${AACR_DATASET}/resolve/main/${AACR_VERSION}/data.jsonl`;

export interface ReviewerBenchDeps {
  readDataset?: (source: string) => Promise<string>;
  /** Review one PR on one `provider/model`; default runs the real read-only reviewer in a sandbox. */
  review?: (model: string, pr: BenchPr) => Promise<ReviewRun>;
  judge?: CloseCallJudge;
}

async function readDatasetSource(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return readFile(source, 'utf8');
  const res = await fetch(source);
  if (!res.ok) throw new Error(`reviewer-bench: fetching ${source} failed: HTTP ${res.status}`);
  return res.text();
}

/** `provider/model` (e.g. `codex/gpt-6-sol`); a bare provider uses its default model. */
export function parseBenchModel(spec: string): { provider: ProviderName; model?: string } {
  const [provider = '', ...rest] = spec.split('/');
  if (!isProviderName(provider)) throw new Error(`reviewer-bench: unknown provider in "${spec}" (use provider/model, e.g. codex/gpt-6-sol)`);
  return { provider, ...(rest.length > 0 ? { model: rest.join('/') } : {}) };
}

/** LLM judge for close calls: same file, lines too far apart (or unstated) to match mechanically. */
export function makeCloseCallJudge(complete: (prompt: string) => Promise<string>): CloseCallJudge {
  return async (finding, issue) => {
    const reply = await complete(
      [
        'Does the code-review finding below report the same defect as the annotated issue? Answer YES or NO only.',
        `Annotated issue (${issue.file}:${issue.startLine}-${issue.endLine}): ${issue.text}`,
        `Finding (${finding.severity}): ${finding.title}\n${finding.evidence}`,
      ].join('\n\n'),
    );
    return /^\s*YES\b/i.test(reply);
  };
}

/**
 * An empty git repo with one empty commit on `main`: the tree the reviewer reads. The benchmark PR's own
 * repo is not checked out, so the reviewer must not see this checkout's files or its CLAUDE.md severity
 * rules; it reviews the diff alone.
 */
export async function makeScratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taskcell-reviewer-bench-'));
  const git = (...args: string[]) => execa('git', ['-C', dir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...args]);
  await git('init', '-q', '-b', 'main');
  await git('commit', '-q', '--allow-empty', '-m', 'empty');
  return dir;
}

function synthPr(pr: BenchPr): PullRequestForReview {
  return {
    repoSlug: pr.repo, number: 0, title: pr.title, body: pr.body, url: '', author: 'bench', headRefName: 'bench-head',
    headRefOid: 'bench', baseRefName: 'main', isCrossRepository: false, headRepositoryOwner: '', diff: pr.diff, labels: [],
  };
}

/**
 * `eval --reviewer-bench`: run the PR reviewer (the review-pr agent path, read-only) over a sample of
 * AACR-Bench PRs per `provider/model` and print precision/recall/F1, cost and time. Never touches GitHub.
 */
export async function reviewerBenchCommand(cmd: EvalCommand, deps: ReviewerBenchDeps = {}): Promise<void> {
  const specs = (cmd.benchModels ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (specs.length === 0) throw new Error('reviewer-bench: pass --bench-models provider/model[,provider/model…] (e.g. codex/gpt-6-sol,claude/claude-opus-5-5)');
  const parsed = new Map(specs.map((s) => [s, parseBenchModel(s)]));

  const text = await (deps.readDataset ?? readDatasetSource)(cmd.benchDataset ?? AACR_DEFAULT_URL);
  const sample = samplePrs(parseAacrDataset(text), cmd.benchSample ?? AACR_DEFAULT_SAMPLE);
  if (sample.length === 0) throw new Error('reviewer-bench: the dataset yielded no usable PRs (schema mismatch?)');

  let review = deps.review;
  let cleanup: (() => Promise<void>) | undefined;
  let scratchRepo: string | undefined;
  if (review === undefined) {
    scratchRepo = await makeScratchRepo();
    const repoPath = scratchRepo;
    // One sandbox per provider (its auth), started on first use and torn down at the end.
    const sandboxes = new Map<string, Promise<SandboxContext>>();
    const sandboxFor = (provider: ProviderName): Promise<SandboxContext> => {
      const existing = sandboxes.get(provider);
      if (existing !== undefined) return existing;
      const auth = agentAuthFromEnv({ provider });
      const started = startSandboxContext({ egress: false, llmProxy: false, skipPrimarySidecar: false, ...(auth !== undefined ? { auth } : {}), provider });
      sandboxes.set(provider, started);
      return started;
    };
    cleanup = async () => {
      for (const s of sandboxes.values()) await (await s).destroy();
    };
    review = async (spec, pr): Promise<ReviewRun> => {
      const { provider, model } = parsed.get(spec)!;
      const reviewCmd = { kind: 'review-pr' as const, prRef: pr.id, repoPath, egress: false, provider, ...(model !== undefined ? { reviewModel: model } : {}) };
      const outcomes: SummaryOutcome[] = [];
      const started = Date.now();
      // The default-branch lookup is stubbed: the bench PR's repo is not the checkout under review.
      const gh = async (): Promise<string> => JSON.stringify({ defaultBranchRef: { name: 'main' } });
      const outcome = await runDefaultReviewer(synthPr(pr), reviewCmd, agentAuthFromEnv({ provider }), await sandboxFor(provider), { isRetry: false }, outcomes, gh, openAgentSession);
      const result = outcomes.at(-1)?.result;
      const cost = result?.costUsd ?? (result !== undefined ? estimatedCostUsd(result) : undefined);
      return {
        findings: findingsOfReply(outcome.text),
        completed: outcome.completed,
        tokens: (result?.usage?.inputTokens ?? 0) + (result?.usage?.outputTokens ?? 0),
        ...(cost !== undefined ? { costUsd: cost } : {}),
        durationMs: result?.durationMs ?? Date.now() - started,
      };
    };
  }
  try {
    const judge = deps.judge ?? makeCloseCallJudge(makeCliComplete(cmd.judgeModel ?? 'claude-haiku-5-5'));
    const models = await runReviewerBench({ prs: sample, models: specs, review, judge, log: (l) => process.stderr.write(`${l}\n`) });
    const report: BenchReport = { dataset: AACR_DATASET, version: AACR_VERSION, datasetHash: datasetHash(text), sampleSize: sample.length, models };
    console.log(cmd.json ? JSON.stringify(report, null, 2) : formatBenchReport(report));
  } finally {
    await cleanup?.();
    if (scratchRepo !== undefined) await rm(scratchRepo, { recursive: true, force: true });
  }
}
