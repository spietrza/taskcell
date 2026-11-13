import { diffFilesWithPatches, gateConfigPaths, gateConfigChangedBlock, loadGateConfigExtraGlobs } from '../context/gate-config.js';
import { clearStageMarker, writeStageMarker } from '../core/run-stage-marker.js';
import { reviewVerdictLine, reviewVerdictOf } from '../pipeline/review-verdict.js';
import { trustedSpecText, isTrustedComment } from '../tasks/comment-trust.js';
import { readFile } from 'node:fs/promises';
import { taskToVariables } from '../tasks/fetcher.js';
import { escapePromptTags } from '../context/escape.js';
import { DockerSandboxProvider, sandboxImage } from '../sandbox/docker.js';
import { pnpmStoreConfig, sandboxNetworkConfig } from '../sandbox/limits.js';
import { selectAgents, forcedProviderModel, providerKeyEnvNames } from '../agents/registry.js';
import { tokenProviderFor } from '../core/push-token.js';
import { hasLabel, labelValue } from '../core/labels.js';
import { resolveTargetBase } from '../core/base-branch.js';
import { prepareContext, disposeContext } from '../core/taskcell.js';
import { probeTaskDifficulty, decisionProbeConfig } from '../core/decision-probe.js';
import { decisionModelConfig, decisionEgressAllowed, decisionModelMissing, DECISION_MODEL_DEFAULT, type DecisionModelConfig } from '../core/decision-model.js';
import { TaskcellError } from '../core/errors.js';
import { decisionDiffScorer } from '../evals/decision-judge.js';
import { runStages, assembleReviewPipeline, withPrimaryFallback, sandboxComplete, withStageMaxTurns, withStageResumeUntilComplete, reviewFinalDiff, STAGE } from '../pipeline/pipeline.js';
import { FLOWS } from '../api/capabilities.js';
import { resolveRepoFlow, unknownFlowError } from '../flows/repo.js';
import { buildReviewerAttribution, hasBlockingFinding } from '../pipeline/review-publish.js';
import { stripReviewMarkers } from './review-prompt.js';
import { authSecrets } from '../agents/auth.js';
import { beginRun, persistDecisionProbe } from '../core/run-store.js';
import type { SecretBlock } from '../core/secret-scan.js';
import { injectedSecretValues, redactForPublish } from '../core/secret-scan.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { appendStepSummary } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback, proofBlock, verifySkippedBlock, baseRedBlock } from '../pipeline/verify.js';
import { resolveBaselineVerify } from '../pipeline/baseline-verify.js';

import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { reviewRequestBody } from './review-body.js';
import { repairUntilGreen } from '../pipeline/repair-gate.js';
import { deliverChange, conventionalPrTitle, scanOutgoingForSecrets } from './deliver-change.js';
import {
  parseSpecManifest,
  primaryModuleScope,
  checkConformance,
  renderConformanceFeedback,
  commitLeakWarningBlock,
  prBodyGapWarningBlock,
  PASSING_RESULT,
} from '../pipeline/conformance-gate.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { ConformanceResult } from '../pipeline/conformance-gate.js';
import type { VerificationResult } from '../pipeline/verify.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, CustomProviderEntry } from '../agents/registry.js';
import type { PipelineStage, StageOutcome } from '../pipeline/pipeline.js';
import type { GateResult, RepairGateOptions } from '../pipeline/repair-gate.js';
import type { RunResult } from '../core/types.js';
import type { RunEvent } from '../pipeline/events.js';
import { skillRegistryForRun } from '../context/skill-registry.js';

/** Issue label that skips the base-red check: the task is meant to fix the red base. */
export const BASE_RED_OK_LABEL = 'taskcell:base-red-ok';
/** A verify command that installs its dependencies before running anything (the auto-detected JS shape). */
const SELF_INSTALLING_VERIFY_RE = /^\s*(?:pnpm|yarn|npm) install --frozen-lockfile\s*&&/;

/** Agent-pipeline options shared by the `run` and `watch` commands, threaded verbatim into the *Deps. */
export interface RunOptions extends ProviderChoice {
  providerModel?: string;
  reviewModel?: string;
  /** Model for the implementer fallback provider (ProviderChoice.fallbackProvider); undefined = its default. */
  fallbackModel?: string;
  /** Model for gate repairs after the first failed one; undefined = keep the implementer model. */
  escalateModel?: string;
  /** How --fork variants are scored; 'decision' needs decision-model credentials (fails fast without). */
  forkScorer?: 'llm' | 'decision';
  noSimplify?: boolean;
  verifyCmd?: string;
  visualProofCmd?: string;
  /** When true, run the conformance stage (opt-in; default off). */
  conformance?: boolean;
  /** Model override for the conformance stage (e.g. 'opus'). */
  conformanceModel?: string;
  /** Git author for the commit (default: `Vanguard <vanguard@local>`). Set via --commit-author. */
  commitAuthor?: { name: string; email: string };
  /**
   * When true, run a dedicated planning stage first (opus, high effort) before implement/review — the
   * plan-implement-review pipeline — instead of the source's default implement-first stages. Set via --plan.
   */
  plan?: boolean;
  /**
   * Named flow key (a `FLOWS` registry entry, e.g. 'flow-b'). Set via `--flow`. `--plan` is the
   * back-compat alias for `flow: 'plan'`. When set, `FLOWS[flow].build()` supplies the base stages
   * instead of the adapter's — EXCEPT `'default'`, which means "the adapter's own stages" (an adapter
   * may customize them; Linear does). Validated at the CLI/sidecar boundary.
   */
  flow?: string;
  /** Base branch to branch off and target the PR at (default: `main`). Set via --base. */
  baseBranch?: string;
  /**
   * Override the implementer stage's turn cap (default: 30; base/fast stays 12). Opt-in, higher
   * token cost — lets one run finish a deliberately large, multi-file task. Set via --max-turns.
   */
  maxTurns?: number;
  /**
   * Override the conformance/verify repair loop-back cap (default: 2). Opt-in — gives the
   * manifest-driven loop-back more passes on large tasks. Set via --max-repair-iterations.
   */
  maxRepairIterations?: number;
  /**
   * Local spec file injected as a virtual issue comment: the implementer prompt ({{COMMENTS}}),
   * triage, and the conformance manifest read it exactly like a posted spec, but nothing is written
   * to the tracker. Pairs with `taskcell spec --out` for a no-trace client-repo flow. Set via --spec-file.
   */
  specFile?: string;
  feedbackAuthors?: string[];
  /**
   * Skills directory injected into the sandbox (Vanguard's bundled `skills/` in the factory), merged
   * with the target repo's own `.github/vanguard-skills/`. Set via --skills.
   */
  skillsDir?: string;
  /**
   * Opt-in persistent pnpm store (off by default): mounts `/pnpm-store` into the sandbox and sets
   * `npm_config_store_dir`, so the base-red install and the post-implement reinstall (#655) stop
   * re-downloading a repo's dependencies from scratch. One store per repo, never shared — see
   * `pnpmStoreConfig` in sandbox/limits.ts and docs/cli.md for the store-poisoning tradeoff. Set via
   * --pnpm-store / VANGUARD_PNPM_STORE.
   */
  pnpmStore?: boolean;
}

/**
 * Extract the shared RunOptions fields from a `run` or `watch` command (or any compatible shape).
 *
 * Booleans (`noSimplify`, `conformance`) are copied on `!== undefined`, relying on the parse-time
 * invariant that the CLI only ever emits `true` or omits them. A future caller passing an explicit
 * `false` will therefore propagate it — a conscious choice, not a dropped flag.
 */
export function pickRunOptions(cmd: Readonly<Partial<RunOptions>>): RunOptions {
  return {
    ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    ...(cmd.fallbackProvider !== undefined ? { fallbackProvider: cmd.fallbackProvider } : {}),
    ...(cmd.fallbackModel !== undefined ? { fallbackModel: cmd.fallbackModel } : {}),
    // Loaded repo customs must survive this copy or selectAgents sees a bare name (S6).
    ...(cmd.customProviders !== undefined ? { customProviders: cmd.customProviders } : {}),
    ...(cmd.providerModel !== undefined ? { providerModel: cmd.providerModel } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    ...(cmd.escalateModel !== undefined ? { escalateModel: cmd.escalateModel } : {}),
    ...(cmd.forkScorer !== undefined ? { forkScorer: cmd.forkScorer } : {}),
    ...(cmd.noSimplify !== undefined ? { noSimplify: cmd.noSimplify } : {}),
    ...(cmd.verifyCmd !== undefined ? { verifyCmd: cmd.verifyCmd } : {}),
    ...(cmd.visualProofCmd !== undefined ? { visualProofCmd: cmd.visualProofCmd } : {}),
    ...(cmd.conformance !== undefined ? { conformance: cmd.conformance } : {}),
    ...(cmd.conformanceModel !== undefined ? { conformanceModel: cmd.conformanceModel } : {}),
    ...(cmd.commitAuthor !== undefined ? { commitAuthor: cmd.commitAuthor } : {}),
    ...(cmd.plan !== undefined ? { plan: cmd.plan } : {}),
    ...(cmd.flow !== undefined ? { flow: cmd.flow } : {}),
    ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}),
    ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
    ...(cmd.maxRepairIterations !== undefined ? { maxRepairIterations: cmd.maxRepairIterations } : {}),
    ...(cmd.specFile !== undefined ? { specFile: cmd.specFile } : {}),
    ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
    ...(cmd.pnpmStore !== undefined ? { pnpmStore: cmd.pnpmStore } : {}),
  };
}

/** Shared dependencies for all source-backed issue runners. */
export interface RunIssueDeps extends RunOptions {
  /** Which kind of credential funded the run (hub per-user credentials); recorded on the run record, never the value. */
  credentialSource?: 'instance' | 'user';
  /** Env the provider keys are read from (default process.env): a hub run's resolved credential env. */
  providerEnv?: NodeJS.ProcessEnv;
  /** The hub login (or `token`) that started this run; stamped on its run records. */
  startedBy?: string;
  auth?: AgentAuth;
  repoPath: string;
  proxyUrl?: string;
  network?: string;
  llmProxy?: LlmProxyDep;
  reuse?: boolean;
  /** Keep a local base that is ahead of/diverged from origin (default: outside CI only). See resolveRemoteBaseRef. */
  keepLocalIfAhead?: boolean;
  forkN?: number;
  reviewGate?: boolean;
  /** When set, receives structured run events. Absent ⇒ no events (CLI path). Threaded to runStages + run-start/run-end. */
  onEvent?: (e: RunEvent) => void;
  /** When set, aborts the run — the sandbox is torn down via the caller's finally. Threaded into runStages. */
  signal?: AbortSignal;
}

/** Semantic kind of a PR/MR triage signal; adapters map it to a platform label string. */
export type ProofFailureKind = 'verify' | 'visual-proof' | 'gate-config';

/** Input to the per-source publishVerdict hook (platform-neutral subset of PublishReviewVerdictInput). */
export interface PublishVerdictInput {
  /** Full PR or MR URL returned by publishForReview. */
  prUrl: string;
  /** The commit SHA — also the dedupe marker embedded in the comment. */
  headSha: string;
  /** The 'reviewer' StageOutcome. Missing → hard error (no-silence guarantee). */
  reviewerOutcome?: StageOutcome | undefined;
  /** The 'conformance' StageOutcome. Optional; when present appends a ## Conformance section. */
  conformanceOutcome?: StageOutcome | undefined;
  /** Attribution string e.g. "codex" or "claude/sonnet". */
  attribution: string;
  /** When true, blocking (high/critical) findings gate the PR/MR. */
  gate?: boolean;
}

/** Per-source seam: fetch/prepare, extra secrets, id derivation, stage set, extra variables, PR link-back. */
export interface SourceAdapter {
  /** Fetch the task. Runs on the host. */
  prepare(issueRef: string): Promise<{ task: Task }>;
  /** Extra sandbox secrets merged in before agent secrets (e.g. LINEAR_API_KEY). */
  secrets?: Record<string, string>;
  /** Derive the worktree/task id from the fetched task. */
  taskId(task: Task): string;
  /** Base pipeline stages (canonical, or implementer-swapped for Linear). */
  stages(): PipelineStage[];
  /** Extra prompt variables (e.g. ISSUE for Linear). */
  variables?(issueRef: string, task: Task): Record<string, string>;
  /** Whether the review body should include source-control auto-close syntax for this task id. */
  closeIssueOnMerge?: boolean;
  /** CLI used to open the draft PR/MR for review. Default 'gh'. GitLab supplies 'glab'. */
  reviewCli?: 'gh' | 'glab';
  /** Post the reviewer verdict (+ optional conformance section) onto the opened PR/MR. */
  publishVerdict(input: PublishVerdictInput): Promise<void>;
  /** Add a proof-failure label to the opened PR/MR (best-effort; must never throw). */
  addFailureLabel(prUrl: string, kind: ProofFailureKind): Promise<void>;
  /**
   * Flag the opened PR/MR as touching gate config. Unlike addFailureLabel this is NOT best-effort:
   * the label IS the gate a human review keys off (GATE_CONFIG_REVIEW_INSTRUCTION in pr-review.ts /
   * mr-review.ts), so a failed flip must throw rather than hand back an unflagged PR. A no-op on a
   * source that has no labelable review surface.
   */
  addGateConfigLabel(prUrl: string): Promise<void>;
  /**
   * Surface a secret-scan block on the source issue (label + masked comment). Best-effort: must
   * never throw (mirrors addFailureLabel). Called for BOTH the findings block and the scan-error
   * precautionary block.
   */
  signalSecretBlock(issueRef: string, task: Task, block: SecretBlock): Promise<void>;
  /**
   * Surface a "base branch is red" notice (pre-rendered by the caller via `baseRedBlock`) on the
   * source issue: the baseline verify command already failed on the base commit, before the
   * implementer ran, so no implement run was started. A plain comment/note, no label: a red base is
   * not a held issue, and the body itself asks for the trigger label to be re-applied once the base
   * is green. Best-effort: must never throw (mirrors signalSecretBlock).
   */
  signalBaseRed(issueRef: string, task: Task, body: string): Promise<void>;
  /** Write the PR link back onto the source issue. */
  linkPr(issueRef: string, task: Task, prUrl: string): Promise<void>;
}

/** Shared result shape for all source-backed issue runners. */
export interface RunIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
  /** True when a PR was withheld because the secret scan flagged the outgoing diff — NOT "no changes". */
  secretBlocked?: boolean;
  /** True when the run stopped before implementing because the base branch is already red — NOT "no changes". */
  baseRed?: boolean;
}

/** Cap on implement-session resumes triggered by a failing conformance/verify gate, before falling back to a declared-partial PR. */
const MAX_REPAIR_ITERATIONS = 2;

/** Secret-scan failure as repair feedback: file and pattern names only, never the matched text. */
function renderSecretFeedback(block: Extract<SecretBlock, { reason: 'findings' }>): string {
  const where = [...block.findings.map((f) => `${f.file} [${f.patternName}]`), ...(block.injected ?? []).map((f) => f.file)].join(', ');
  return `The secret scan found credentials in your change (${where}). Remove them from the diff (read them from the environment instead) and make sure none is committed.`;
}

/**
 * The report-only reviewer's blocking findings, as repair feedback for the implementer (#673): the
 * structured `<findings>` block when it parses, else the reply's prose with the review markers
 * stripped (the reviewer can quote a dedupe/revision marker out of the diff; as everywhere the bot
 * forwards verdict text, it must not ride along). The text is agent-written and reaches the resumed
 * session through `literalPrompt` (see repairUntilGreen).
 */
function reviewRepairFeedback(verdictText: string): string {
  const { findings } = reviewVerdictOf(verdictText);
  const body = findings.length > 0
    ? findings.map((f) => `- [${f.severity}] (${f.kind}) ${f.title}\n  ${f.evidence}`).join('\n')
    : stripReviewMarkers(verdictText).trim();
  return `An independent reviewer read your change and found blocking issues. Fix every one of them in the repo:\n\n${body}`;
}

/** Read the local --spec-file eagerly with a clear error — an ENOENT deep inside a run is not actionable. */
async function readSpecFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`--spec-file: cannot read ${path}: ${String(cause)}`);
  }
}

/**
 * White-label branch id: the trailing issue number (e.g. `gh-…-904` → `904`), else a
 * Conventional-Branch-safe slug of the taskId. Used for `feat/<id>-<hash>` branches in white-label mode.
 */
function branchIdFromTaskId(taskId: string): string {
  const trailingNumber = /(\d+)$/.exec(taskId)?.[1];
  if (trailingNumber !== undefined) return trailingNumber;
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug === '' ? 'task' : slug;
}

/** Issue label that pins the implementer-tier model for ONE task: `taskcell:model=<model>`. */
export const MODEL_LABEL_PREFIX = 'taskcell:model=';

/**
 * Model ids/aliases/slugs as every supported provider spells them (`opus`, `claude-sonnet-5`,
 * `anthropic/claude-sonnet-4.6`, `gpt-5.6-sol`, `glm-5.2`). Labels are a lower-trust input than a CLI
 * flag — anyone with triage permission can set one — so the value is allowlisted by shape before it
 * becomes a `--model` argument, even though the arg is shell-quoted downstream.
 */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * Per-task model override from the issue's labels. A human judging "this one is hard" beats any
 * pre-run heuristic, so the label wins over the fleet-wide --provider-model. Last well-formed
 * matching label wins; an empty or malformed value is ignored (and reported via `onInvalid`).
 */
export function modelFromLabels(labels: ReadonlyArray<string>, onInvalid?: (label: string) => void): string | undefined {
  let model: string | undefined;
  for (const label of labels) {
    const raw = labelValue(label, MODEL_LABEL_PREFIX);
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value === '') continue;
    if (!MODEL_NAME_RE.test(value)) {
      onInvalid?.(label);
      continue;
    }
    model = value;
  }
  return model;
}

/**
 * Conventional-Commits-safe commit message for white-label mode: `<type>(<scope>)?: <lower-case
 * subject> (#<issue>)` with a header ≤100 chars. Reuses `conventionalPrTitle` so a title that already
 * carries a type (e.g. `refactor(hub): …`) keeps it instead of getting a second `feat: ` prefix.
 * Lower-casing the whole subject is the reliable way to pass commitlint's `subject-case` (never
 * sentence/start/pascal/upper-case); the trailing `#<n>` satisfies task-number rules.
 */
export function conventionalCommitMessage(title: string, taskId: string, opts: { bugLabel?: boolean } = {}): string {
  const prefixed = conventionalPrTitle(title, opts);
  const suffix = ` (#${branchIdFromTaskId(taskId)})`;
  const subject = prefixed.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
  const room = 100 - suffix.length;
  const clipped = subject.length > room ? subject.slice(0, room).trimEnd() : subject;
  return `${clipped}${suffix}`;
}

/**
 * Resolve a flow name to its base stage array. 'default' (and no flow at all) means "this
 * adapter's own stages", NOT FLOWS.default.build. They are not the same: the Linear adapter's
 * stages() swaps in an implementer that reads the issue via the linear-cli skill, while
 * FLOWS.default.build is the generic implementReviewSimplifyStages. Selecting 'default' by name —
 * the natural thing for a name-driven UI — must not silently downgrade a Linear run to an
 * implementer that never reads the issue. Non-built-in names resolve from the repo's
 * `.taskcell/flows/*.hcl` (S5); unknown names throw listing both sets.
 */
async function resolveBaseStages(
  flow: string | undefined,
  repoPath: string,
  adapter: SourceAdapter,
  customProviders?: readonly CustomProviderEntry[],
): Promise<PipelineStage[]> {
  if (flow === undefined || flow === 'default') return adapter.stages();
  if (Object.hasOwn(FLOWS, flow)) return FLOWS[flow]!.build();
  const stages = await resolveRepoFlow(flow, repoPath, customProviders);
  if (stages === undefined) throw await unknownFlowError(flow, repoPath);
  return stages;
}

/**
 * Credentials and consent for `--fork-scorer decision`. Checked by the CLI before anything runs and
 * again here as a backstop. A white-label run ships the CLIENT's diff to the decision model, so it
 * needs the same explicit consent as the difficulty probe (VANGUARD_DECISION_PROBE=all).
 */
export function resolveForkScorerConfig(whiteLabel: boolean, env: NodeJS.ProcessEnv = process.env): DecisionModelConfig {
  if (!decisionEgressAllowed(whiteLabel, env)) {
    throw new TaskcellError(
      '--fork-scorer decision on a white-label run (--commit-author) sends the client diff to the decision model; set VANGUARD_DECISION_PROBE=all to allow that.',
    );
  }
  const config = decisionModelConfig(env);
  if (config === undefined) {
    throw new TaskcellError(`--fork-scorer decision: ${decisionModelMissing(env['VANGUARD_DECISION_MODEL'] ?? DECISION_MODEL_DEFAULT, env)}`);
  }
  return config;
}

/** Shared pipeline body for GitHub and Linear issue runners, parameterised by a SourceAdapter. */
export async function runSourcedIssue(
  issueRef: string,
  deps: RunIssueDeps,
  adapter: SourceAdapter,
): Promise<RunIssueResult> {
  // Named-flow dispatch, resolved FIRST: a flow typo must fail before the tracker fetch, the
  // provider proxies, and the sandbox spin-up (the CLI mirror of the sidecar fail-fast, S5 D6).
  // `--flow <name>` selects a FLOWS builder or a repo `.taskcell/flows/*.hcl` flow; `--plan` is
  // the back-compat alias for flow 'plan'.
  const flow = deps.flow ?? (deps.plan === true ? 'plan' : undefined);
  const baseStages = await resolveBaseStages(flow, deps.repoPath, adapter, deps.customProviders);

  // Every source gets the same skills: the --skills dir plus the repo's own .github/vanguard-skills/.
  const [{ task: fetchedTask }, skills] = await Promise.all([adapter.prepare(issueRef), skillRegistryForRun(deps.skillsDir, deps.repoPath)]);
  // --spec-file: layer the local spec onto the fetched task as a virtual comment — the implementer
  // prompt ({{COMMENTS}}), triage, and the conformance manifest read it exactly like a posted spec,
  // with nothing written to the tracker. Copy, don't mutate: the fetched object may be shared.
  const task =
    deps.specFile === undefined
      ? fetchedTask
      : {
          ...fetchedTask,
          comments: [...fetchedTask.comments, { author: 'spec-file', authorAssociation: 'OWNER', body: await readSpecFile(deps.specFile) }],
        };

  // White-label mode (triggered by --commit-author): the PR is delivered as a plain, human-looking PR.
  // Branch becomes `feat/<issue-number>-<hash>`, the "by Vanguard" attribution and the Vanguard review
  // comment / issue link-back are suppressed. Off by default — everything stays branded as Vanguard.
  const whiteLabel = deps.commitAuthor !== undefined;

  // A hub run reads every provider key (agents, fork scorer, difficulty probe) from its resolved
  // credential env, so a `user` run never spends the host's key.
  const providerEnv = deps.providerEnv ?? process.env;
  const agents = selectAgents(deps, providerEnv, { proxyMode: deps.llmProxy !== undefined });

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox. Created
  // before prepareContext so the finally below tears them down even if context provisioning throws.
  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    // The target branch: --base, else the card's `taskcell:base=` label, else app.json's default. An unsafe
    // value is refused here, before the sandbox, so nothing runs against the wrong branch.
    const baseBranch = await resolveTargetBase(deps.repoPath, task.labels, deps.baseBranch);
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies);
    // Keyed on the local repo path: every source (github/linear/gitlab) has one, and it is already
    // the one thing that pins "this target repo" regardless of tracker.
    const pnpmStore = pnpmStoreConfig(deps.repoPath, deps.pnpmStore);
    const sandbox = new DockerSandboxProvider({
      image: sandboxImage(),
      // In llm-proxy mode the real Claude secret stays in the sidecar — the sandbox gets only the nonce.
      secrets: {
        ...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth ? authSecrets(deps.auth) : {}),
        ...(adapter.secrets ?? {}),
        ...agents.secrets,
      },
      ...(env !== undefined ? { env } : {}),
      ...(pnpmStore !== undefined ? { pnpmStore } : {}),
      ...sandboxNetworkConfig(deps.network),
    });

    // A decision-model fork scorer needs credentials; resolve them BEFORE the sandbox is built so a
    // missing key fails in a second, not after a full implementer run.
    const forkScore =
      deps.forkN !== undefined && deps.forkScorer === 'decision' ? decisionDiffScorer(resolveForkScorerConfig(whiteLabel, providerEnv), deps.signal !== undefined ? { signal: deps.signal } : {}) : undefined;
    const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath, { taskText: `${task.title}\n${task.description}` });
    // Log-only difficulty probe (decision model, opt-in via env): kicked off here so its round trip
    // hides under sandbox + worktree provisioning; awaited once the pipeline is assembled. Recorded
    // next to the run so stats can later tell whether it predicts repairs/escalation. Never routes.
    const labelModel = modelFromLabels(task.labels, (label) =>
      console.warn(`taskcell: ${task.id} ignoring malformed model label ${JSON.stringify(label)}`),
    );
    const probePromise = probeTaskDifficulty(task, labelModel ?? deps.providerModel, {
      config: decisionProbeConfig(providerEnv, { whiteLabel }),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const ctx = await prepareContext(
      {
        taskId: adapter.taskId(task),
        localRepoPath: deps.repoPath,
        sandbox,
        agentName: agents.agent.name,
        ...(agents.reviewAgent !== undefined ? { reviewAgentName: agents.reviewAgent.name } : {}),
        ...(agents.fallbackAgent !== undefined ? { fallbackAgentName: agents.fallbackAgent.name } : {}),
        // Cut from origin's copy of the base when it is ahead of the local one (on Actions the checkout is
        // the event SHA and main may already have moved), so the sandbox, verification and review see the
        // tree the PR will land on (#423). A reused branch keeps its own history.
        baseBranch,
        start: deps.reuse === true ? 'reuse' : 'base',
        ...(deps.keepLocalIfAhead !== undefined ? { keepLocalIfAhead: deps.keepLocalIfAhead } : {}),
        ...(whiteLabel ? { branchPrefix: 'feat/', branchId: branchIdFromTaskId(adapter.taskId(task)) } : {}),
      },
      { skills },
    );
    let outcomes: StageOutcome[] = [];
    // On Actions each run leaves one block in the job's Summary tab, built from the same outcomes as
    // the run record + metrics.jsonl so the two never disagree. No GITHUB_STEP_SUMMARY ⇒ no-op.
    const stepSummary = (exit: StepSummaryExit, extra: Pick<StepSummary, 'prUrl' | 'error'> = {}): Promise<void> => {
      const model = outcomes.find((o) => o.name === STAGE.IMPLEMENTER)?.result.model ?? labelModel ?? deps.providerModel;
      return appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
        taskId: task.id,
        flow: flow ?? 'default',
        provider: agents.agent.name,
        ...(model !== undefined ? { model } : {}),
        outcomes,
        exit,
        ...extra,
      });
    };
    let markerWrites = Promise.resolve();
    try {
      const turnScoped = deps.maxTurns !== undefined ? withStageMaxTurns(baseStages, deps.maxTurns) : baseStages;
      // --max-repair-iterations also drives auto-resume of an incomplete implementer (not just the gate
      // loop): an under-budget stage that stopped without <promise>COMPLETE</promise> gets nudged to finish.
      const scopedStages =
        deps.maxRepairIterations !== undefined
          ? withStageResumeUntilComplete(turnScoped, deps.maxRepairIterations)
          : turnScoped;
      const providerForcedModel = forcedProviderModel(deps.provider ?? 'claude', deps.customProviders);
      if (labelModel !== undefined) {
        console.log(`taskcell: ${task.id} pins the implementer model to ${labelModel} via label (overrides --provider-model)`);
      }
      let pipeline = assembleReviewPipeline(scopedStages, agents, {
        ...deps,
        ...(labelModel !== undefined ? { providerModel: labelModel } : {}),
        ...(providerForcedModel !== undefined ? { providerForcedModel } : {}),
      });
      // Implementer fallback: on an AgentError from the primary provider (outage, usage limit, revoked
      // credential) runStages retries the stage once on this provider — same as the reviewer's fallback.
      // Every stage on the primary gets it (simplifier, planner…): the provider that failed the
      // implementer fails them too, and a rescued implementer whose simplifier dies still loses the PR.
      if (agents.fallbackAgent !== undefined) {
        pipeline = withPrimaryFallback(
          pipeline,
          { provider: agents.fallbackAgent, ...(deps.fallbackModel !== undefined ? { model: deps.fallbackModel } : {}) },
        );
      }
      const probe = await probePromise;
      if (probe !== undefined && deps.signal?.aborted !== true) {
        await persistDecisionProbe(deps.repoPath, adapter.taskId(task), probe).catch(() => undefined);
        console.log(
          `taskcell: ${task.id} difficulty probe (${probe.model}, ${probe.latencyMs}ms): first-try ${probe.completesFirstTry.toFixed(2)}, difficulty ${probe.difficulty.toFixed(2)}/4, spec clear ${probe.specClear.toFixed(2)}`,
        );
      }
      // A conformance stage's narrative rides on the reviewer verdict comment (publishReviewVerdict
      // appends it as a `## Conformance` section). `--conformance` appends the stage to ANY flow, so on
      // a reviewer-less one (flow-b: adversary+repairer) it would run, cost money, and publish nothing.
      // Fail at assembly rather than surface nothing the user explicitly asked for. Giving conformance
      // its own standalone comment would need its own body format + dedupe marker; this error is that TODO.
      if (pipeline.some((s) => s.name === STAGE.CONFORMANCE) && !pipeline.some((s) => s.name === STAGE.REVIEWER)) {
        throw new Error(
          `--conformance needs a flow with a reviewer stage (its verdict rides on the review comment); flow "${flow ?? 'default'}" has none`,
        );
      }
      const imageDigest = await ctx.sandbox.imageDigest?.();
      const runMeta = {
        flow: flow ?? 'default',
        provider: agents.agent.name,
        baseBranch,
        ...(imageDigest !== undefined ? { imageDigest } : {}),
        ...(deps.credentialSource !== undefined ? { credentialSource: deps.credentialSource } : {}),
      };
      // One RunWriter for the whole run: it owns the timestamp, so proof.json, visual-proof.json and
      // every stage record share one prefix and the hub/desktop readers can match a run's proof to
      // its stage records by name.
      const writer = beginRun(deps.repoPath, adapter.taskId(task), undefined, {
        secretEnvVars: providerKeyEnvNames(deps),
        ...(deps.startedBy !== undefined ? { startedBy: deps.startedBy } : {}),
      });
      const onEvent = (event: RunEvent): void => {
        markerWrites = markerWrites.then(async () => {
          if (event.type === 'stage-start') {
            await writeStageMarker(deps.repoPath, {
              taskId: adapter.taskId(task), stage: event.name, index: event.index, of: event.of,
              updatedAt: new Date().toISOString(),
            });
          } else if (event.type === 'run-end' || event.type === 'run-error' || event.type === 'run-cancelled') {
            await clearStageMarker(deps.repoPath, adapter.taskId(task));
          }
        }).catch(() => undefined);
        deps.onEvent?.(event);
      };
      onEvent({
        type: 'run-start',
        taskId: adapter.taskId(task),
        ...runMeta,
        stages: pipeline.map((s) => s.name),
      });
      // Before implementing: check the base tree's verify command against the base commit (cached by
      // SHA). A gate that is already red there is not this task's fault — starting a repair loop against
      // it would just burn turns on pre-existing failures, so stop here instead (#2024). Skipped on a
      // reused branch: its worktree holds the branch's own prior work, not the base commit, so neither
      // the command nor the verdict would be about the base.
      const verifyOpts = deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {};
      // Only a command that installs its own dependencies first: the base worktree is a fresh copy with
      // no node_modules, so an operator-supplied `pnpm typecheck && pnpm test` (or a bare `pytest`)
      // would fail there on a perfectly green base and stop every task.
      // `taskcell:base-red-ok` on the issue is the escape hatch for tasks whose job IS fixing the red base.
      const skipBaseline = deps.reuse === true || hasLabel(task.labels, BASE_RED_OK_LABEL);
      const resolvedBase = skipBaseline ? undefined : await resolveVerifyCommand(ctx.worktreePath, verifyOpts);
      const baselineCmd = resolvedBase !== undefined && SELF_INSTALLING_VERIFY_RE.test(resolvedBase) ? resolvedBase : undefined;
      if (baselineCmd !== undefined) {
        const verifyCmd = baselineCmd;
        const baselineVerify = await resolveBaselineVerify(deps.repoPath, ctx.startRef, ctx.sandbox, verifyCmd, deps.signal, injectedSecretValues(process.env, providerKeyEnvNames(deps)));
        if (!baselineVerify.passed) {
          console.log(
            `taskcell: ${task.id} base branch is red — \`${verifyCmd}\` already fails on ${ctx.baseBranch}@${ctx.startRef.slice(0, 7)} (exit ${baselineVerify.exitCode}); stopping before implementing instead of starting a repair loop.`,
          );
          console.log(redactForPublish(renderVerificationFeedback(baselineVerify)));
          if (!whiteLabel) await adapter.signalBaseRed(issueRef, task, baseRedBlock(ctx.baseBranch, ctx.startRef, baselineVerify));
          await writer.writeProof(baselineVerify, { baseRed: true });
          await stepSummary('base-red', {});
          onEvent({ type: 'run-end' });
          return { task, baseRed: true };
        }
      }
      // One set of prompt variables for the whole run: the final-diff re-review below renders the same
      // reviewer prompt, so it must see the same task.
      const variables = {
        ...taskToVariables(task, { allowedAuthors: deps.feedbackAuthors }),
        ...(adapter.variables?.(issueRef, task) ?? {}),
        RETROSPECTIVE_MEMORY: escapePromptTags(retrospectiveMemory),
      };
      // Deterministic spec-manifest vs diff conformance gate, joined with the verify command and a
      // secret scan into a single shared-cap repair loop: any gate failing resumes the implementer's own
      // session with a combined gap report (bounded, budget/turn caps already apply to the resumed
      // stage) — "iterate the implement loop", not "open PR and hope". It runs on the implementer's
      // output BEFORE the reviewer, so the review is never spent on code a repair round would change
      // (runStages' `gateBeforeReview`). Exhausting the cap (or having no resumable session) skips the
      // reviewer and falls through to a declared-partial PR (reviewRequestBody below), never a silent
      // `Closes` with any gate red.
      const trust = { allowedAuthors: deps.feedbackAuthors, issueAuthor: task.author };
      const specText = trustedSpecText(task, trust);
      const manifest = parseSpecManifest(specText);
      // A *parseable* manifest only: prose that merely names the tag must not downgrade delivery.
      const untrustedManifestDropped = manifest === undefined && task.comments.some(
        (c) => !isTrustedComment(c, trust) && parseSpecManifest(c.body) !== undefined,
      );
      if (untrustedManifestDropped) console.log(`taskcell: ${task.id} ignoring <spec_manifest> from untrusted comment author(s) — declaring partial scope (Part of)`);

      let conformance: ConformanceResult = PASSING_RESULT;
      // The diff the last gate run checked — reused at delivery so the published verdict is derived
      // from exactly what the gate judged, without a second `wm.diff` round-trip.
      let gateDiff = '';
      // The outgoing diff the last gate run checked: a tree that still matches it needs no second gate.
      let gatedTree = '';
      let verification: VerificationResult | undefined;
      // Re-resolved on every gate run: a task that adds the `test`/`verify` script must still be gated
      // by it, even though the base tree had none.
      let verifyCmd: string | undefined;
      let implementerDone = false;
      let gatePassed = false;
      // Repairs after the reviewer ran: only those make its verdict stale (the gate-first repairs
      // happened before it saw the diff).
      let repairsAfterReview = 0;
      // A re-review that never produced a verdict: published as an incomplete review on a draft PR
      // rather than losing the (already gate-green) work.
      let reviewUnavailable = false;
      const gate = async (): Promise<GateResult> => {
        verifyCmd = await resolveVerifyCommand(ctx.worktreePath, verifyOpts);
        // Only touch the worktree diff when there is a manifest to check against — a legacy/no-manifest
        // spec skips the conformance half of the gate entirely.
        gateDiff = manifest !== undefined ? await ctx.wm.diff(ctx.worktreePath) : '';
        conformance = checkConformance(manifest, gateDiff);
        gatedTree = await ctx.wm.outgoingDiff(ctx.worktreePath);
        const secretBlock = scanOutgoingForSecrets(gatedTree, task.id, 'pre-review gate', providerKeyEnvNames(deps));
        // A scan that itself errored is not something the implementer can repair: delivery blocks on it.
        const secrets = secretBlock?.reason === 'findings' ? secretBlock : undefined;
        verification = verifyCmd !== undefined ? await runVerification(ctx.sandbox, verifyCmd) : undefined;
        // Completion is part of the gate (dogfood #352): an implementer that hit its turn cap or timeout
        // mid-task can leave residue that still typechecks and tests green. Gate on `completed`, NOT on
        // exitReason === 'maxTurns': the SDK counts internal steps as turns while vanguard counts real
        // ones. A provider that finishes but never emits <promise>COMPLETE</promise> is re-nudged and,
        // if it still won't signal, downgraded to a Part-of PR — an unverifiable "done" must not
        // auto-close the issue.
        const implementerIdx = outcomes.findIndex((o) => o.name === STAGE.IMPLEMENTER);
        implementerDone = implementerIdx === -1 || outcomes[implementerIdx]?.result.completed === true;
        const pass = conformance.pass && (verification === undefined || verification.passed) && implementerDone && secrets === undefined;
        const feedback = [
          !implementerDone
            ? 'The previous session ended before the task was finished (turn cap or timeout). Continue and complete the remaining work.'
            : undefined,
          !conformance.pass ? renderConformanceFeedback(conformance) : undefined,
          verification !== undefined && !verification.passed ? renderVerificationFeedback(verification) : undefined,
          secrets !== undefined ? renderSecretFeedback(secrets) : undefined,
        ].filter((part): part is string => part !== undefined).join('\n\n');
        return { pass, feedback };
      };
      // Shared by the gate loop and the review-findings round below, so the caps, the escalation rule
      // and the provider the implementer's session belongs to cannot drift between them.
      const repairOpts = (spentIterations = 0): Omit<RepairGateOptions<GateResult>, 'gate'> => {
        const implementerIdx = outcomes.findIndex((o) => o.name === STAGE.IMPLEMENTER);
        const fallbackHolder = agents.fallbackAgent !== undefined && outcomes[implementerIdx]?.providerName === agents.fallbackAgent.name ? agents.fallbackAgent : undefined;
        return {
          label: task.id,
          // Resume on the provider that actually ran the stage: after a fallback the session belongs to it.
          agent: fallbackHolder ?? agents.agent,
          outcomes,
          pipeline,
          // One cap for the whole run: later gate runs get what the pre-review gate left over.
          // NOTE: with an explicit --max-repair-iterations N, an incomplete implementer can be resumed up
          // to ~2N times total — N in-stage (resumeUntilComplete inside runStages) plus N here.
          maxIterations: Math.max(0, (deps.maxRepairIterations ?? MAX_REPAIR_ITERATIONS) - spentIterations),
          // --escalate-model names a model of the implementer's provider; handed to the fallback CLI it is
          // an AgentError, so the fallback repairs on its own model only.
          ...(deps.escalateModel !== undefined && fallbackHolder === undefined ? { escalateModel: deps.escalateModel } : {}),
          // A per-task label is the human's own escalation call; the fleet-wide --escalate-model does not
          // override it (it could even downgrade).
          modelPinned: labelModel !== undefined,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        };
      };
      const reviewerStage = pipeline.find((s) => s.name === STAGE.REVIEWER);
      let gatedBeforeReview = false;
      let gateIterations = 0;
      // try/finally so the per-stage cost table is printed even when a repair call throws or the run
      // is cancelled mid-loop — and, on the happy path, after the loop so repairs show up in it.
      try {
        outcomes = await runStages(ctx, pipeline, {
          agent: agents.agent,
          variables,
          ...(deps.forkN !== undefined
            ? { fork: { n: deps.forkN, complete: sandboxComplete(ctx, agents.agent), ...(forkScore !== undefined ? { score: forkScore } : {}) } }
            : {}),
          onEvent,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          gateBeforeReview: async (outs) => {
            outcomes = outs;
            gatedBeforeReview = true;
            const repair = await repairUntilGreen(ctx, { ...repairOpts(), gate });
            gatePassed = repair.passed;
            gateIterations = repair.iterations;
            return {
              pass: repair.passed,
              // A repair changed the tree: the reviewer must see the repaired diff, not the implementer's.
              ...(repair.iterations > 0 ? { diff: await ctx.wm.diff(ctx.worktreePath) } : {}),
            };
          },
        });
        if (!gatedBeforeReview) {
          // No reviewer stage: nothing to run the gate ahead of, so it runs on the final tree.
          gatePassed = (await repairUntilGreen(ctx, { ...repairOpts(), gate })).passed;
        } else if (await ctx.wm.outgoingDiff(ctx.worktreePath) !== gatedTree) {
          // Reviewer fixes or the simplifier changed files after the first pass: verify the final tree,
          // so the proof stamped into the PR body is the one for what ships.
          const final = await repairUntilGreen(ctx, { ...repairOpts(gateIterations), gate });
          gatePassed = final.passed;
          repairsAfterReview += final.iterations;
        }
        // The reviewer is report-only (#673), so nobody acts on its findings unless they are handed
        // back here: one repair round on the implementer's own session, through the same loop, so the
        // conformance/verify gate still has to be green after the fix. Only once the gate is green —
        // a gate that is still red already exhausted the cap, and a partial PR declares the gap.
        const firstReview = outcomes.find((o) => o.name === STAGE.REVIEWER);
        if (gatePassed && firstReview !== undefined && hasBlockingFinding(firstReview.result.finalText)) {
          const feedback = reviewRepairFeedback(firstReview.result.finalText);
          let reported = false;
          const reviewRepair = await repairUntilGreen(ctx, {
            ...repairOpts(),
            gate: async () => {
              if (!reported) {
                reported = true;
                return { pass: false, feedback };
              }
              return gate();
            },
            maxIterations: 1,
          });
          gatePassed = reviewRepair.passed;
          repairsAfterReview += reviewRepair.iterations;
        }
      } finally {
        console.log(summarizeOutcomes(outcomes));
      }
      console.log(`taskcell: gate ${gatePassed ? 'PASSED' : 'FAILED — declaring partial scope'} for ${task.id}`);

      // The reviewer ran once, after the first gate. When a later repair actually resumed the implementer
      // (repairsAfterReview > 0), the diff it reviewed no longer matches what ships (#665) — re-review the
      // final diff so the published verdict is never stale. No repairs ⇒ the original verdict stands.
      if (reviewerStage !== undefined && repairsAfterReview > 0) {
        let rereviewed: RunResult;
        try {
          rereviewed = await reviewFinalDiff(ctx, reviewerStage, {
            agent: agents.agent,
            variables,
            ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          });
        } catch (error) {
          // A provider limit or a timeout in the re-review must not sink work that already passed the
          // gate: record it as an unavailable (⇒ `incomplete`, never a pass) verdict and still publish,
          // as a draft — a change that ships without a verdict is not ready for review.
          console.error(`taskcell: re-review of the final diff failed for ${task.id} — publishing as a draft with an incomplete review: ${redactForPublish(String(error))}`);
          reviewUnavailable = true;
          rereviewed = {
            taskId: task.id,
            completed: false,
            exitReason: 'incomplete',
            turns: 0,
            worktreePath: ctx.worktreePath,
            worktreePreserved: true,
            finalText: `Review unavailable: ${redactForPublish(String(error))}`,
          };
        }
        // Appended, never swapped in over the first review: both reviews' cost and turns stay in the
        // stats table, and the published verdict reads the LAST reviewer outcome (reviewerOutcome below).
        outcomes.push({
          name: STAGE.REVIEWER,
          result: rereviewed,
          providerName: (reviewerStage.provider ?? agents.agent).name,
          ...(reviewerStage.model !== undefined ? { model: reviewerStage.model } : {}),
        });
      }

      const visualProof = await resolveAndRunVisualProof(
        ctx.sandbox,
        ctx.worktreePath,
        deps.visualProofCmd !== undefined ? { cmd: deps.visualProofCmd } : {},
      );

      await Promise.all([
        verification !== undefined ? writer.writeProof(verification) : undefined,
        visualProof !== undefined ? writer.writeVisualProof(visualProof) : undefined,
      ]);

      // Verification participates in the Closes/Part-of decision alongside conformance: a red result
      // forces the declared-partial path even when conformance itself passed.
      const verificationFailed = verification !== undefined && !verification.passed;
      const visualProofFailed = visualProof !== undefined && !visualProof.passed;
      // `prBody` items name content the diff cannot carry (CI workflow YAML — copy-back drops it) and the
      // factory has no channel to write: no human-authored body text exists yet, so a required item is
      // a gap at delivery — partial scope (`Part of` + draft) — and only the composed body's delimited
      // block, never its generated text, is where a human supplies it. One verdict from the manifest,
      // the diff the gate already checked (`gateDiff`, the final one — the loop re-runs the gate after
      // every repair) and the real PR body — '' is accurate here, not a placeholder: no PR exists yet,
      // so there is genuinely no human-authored body text to check prBody items against.
      const delivered: ConformanceResult = checkConformance(manifest, gateDiff, '');
      const prBodyGapBlock = prBodyGapWarningBlock(delivered.missingPrBody);
      const partial = !gatePassed || untrustedManifestDropped || !delivered.pass;
      const baseBody = reviewRequestBody(task.id, {
        closeIssueOnMerge: !!adapter.closeIssueOnMerge,
        ...(untrustedManifestDropped ? { untrustedManifest: true } : {}),
        ...(manifest !== undefined ? { conformance: delivered, manifest } : {}),
        ...(verificationFailed ? { verificationFailed: true } : {}),
        ...(!implementerDone ? { implementerIncomplete: true } : {}),
        ...(whiteLabel ? { hideAttribution: true } : {}),
      });
      // deliverChange owns the order: secret scan → commit → closing-keyword scan → rebase/push → PR.
      // The body is built after the commit so a partial result can carry commit-level `Closes #N`
      // leaks as a blocking warning. Gate-config disclosure is included in white-label mode too.
      const extraGlobs = await loadGateConfigExtraGlobs(deps.repoPath, baseBranch);
      const scope = primaryModuleScope(manifest);
      const bugLabel = task.labels.includes('bug');
      // The LAST reviewer outcome: after a re-review the first review is kept for the cost table only —
      // its verdict describes a diff that no longer ships.
      // Not `findLast`: that needs lib ES2023, and apps/desktop compiles this file against ES2022.
      const reviewerOutcome = outcomes.filter((o) => o.name === STAGE.REVIEWER).at(-1);
      const delivery = await deliverChange(ctx, {
        taskId: task.id,
        // Default and white-label share the same type/scope logic as the PR title (conventionalPrTitle):
        // no second prefix when the title already has one, `fix:` for a `bug` label, `feat:` otherwise.
        // White-label additionally lower-cases the subject and caps the header at 100 chars so a target
        // repo's commitlint passes.
        commitMessage: whiteLabel
          ? conventionalCommitMessage(task.title, adapter.taskId(task), { bugLabel })
          : `${conventionalPrTitle(task.title, { bugLabel, ...(scope !== undefined ? { scope } : {}) })} (${task.id})`,
        ...(deps.commitAuthor !== undefined ? { commitAuthor: deps.commitAuthor } : {}),
        ...(partial ? { closingKeywordScan: true } : {}),
        // A custom provider's key env var is repo-configured: the secret gate cannot know its name.
        secretEnvVars: providerKeyEnvNames(deps),
        target: {
          kind: 'new-pr',
          title: `${task.title} (${task.id})`,
          bugLabel,
          ...(scope !== undefined ? { scope } : {}),
          // Ready for review only after verification, every configured proof and the review verdict
          // landed: an unavailable re-review ships as a draft too.
          draft: partial || verifyCmd === undefined || visualProofFailed || reviewUnavailable,
          ...(adapter.reviewCli !== undefined ? { cli: adapter.reviewCli } : {}),
          // Same PAT revise pushes with: a PR it opens fires the repo's pull_request workflows (CI).
          // Minted (App) or read (PAT) at each use, never cached: an App token lives 1 h, a run up to 180 min.
          tokenProvider: tokenProviderFor(deps.repoPath),
          body: ({ commitLeaks, outgoingDiff }) => {
            const diffFiles = diffFilesWithPatches(outgoingDiff);
            const configPaths = gateConfigPaths(diffFiles, extraGlobs);
            const configBlock = gateConfigChangedBlock(diffFiles.filter((file) => configPaths.includes(file.path)));
            // The PR-body gap block carries no branding, so white-label keeps it like the gate-config block.
            return whiteLabel
              ? [baseBody, configBlock, prBodyGapBlock].filter(Boolean).join('\n\n')
              : [
                configBlock,
                baseBody,
                commitLeaks.length > 0 ? commitLeakWarningBlock(commitLeaks) : undefined,
                prBodyGapBlock,
                verification !== undefined ? proofBlock(verification) : verifySkippedBlock(),
                visualProof !== undefined ? visualProofBlock(visualProof) : undefined,
                reviewerOutcome !== undefined ? reviewVerdictLine(reviewVerdictOf(reviewerOutcome.result.finalText)) : undefined,
              ].filter((s): s is string => s !== undefined && s !== '').join('\n\n');
          },
        },
      });
      if (delivery.kind === 'secret-blocked') {
        // The blocked diff holds the secret the scan caught: keep it (and the bundle) off disk.
        await writer.writeStages(outcomes, { ...runMeta, omitDiff: true });
        await stepSummary('secret-blocked');
        // White-label runs keep the automation invisible in the client repo: no secret-blocked label,
        // no branded comment. The operator still gets the masked findings on stderr + run record.
        if (!whiteLabel) await adapter.signalSecretBlock(issueRef, task, delivery.block);
        onEvent({ type: 'run-end', secretBlocked: true });
        return { task, secretBlocked: true };
      }
      if (delivery.kind === 'no-changes') {
        await writer.writeStages(outcomes, runMeta);
        await stepSummary('no-changes');
        onEvent({ type: 'run-end' });
        return { task };
      }
      if (delivery.kind !== 'delivered-pr') throw new TaskcellError(`unexpected delivery outcome ${delivery.kind} for a new-pr target`);
      const pr = { prUrl: delivery.prUrl, headSha: delivery.headSha };
      // Read back from the delivered diff, not a binding the `body` callback above would have to mutate
      // as a side effect: a future reorder or target kind can never leave this silently empty.
      const configPaths = gateConfigPaths(diffFilesWithPatches(delivery.outgoingDiff), extraGlobs);
      // White-label mode delivers a plain PR: no Vanguard review comment and no issue link-back comment.
      // A flow without a `reviewer` stage (e.g. flow-b: adversary+repairer) has no verdict to surface,
      // so skip the verdict comment entirely. A red pre-review gate skips the reviewer, so there is no
      // outcome to publish (the partial draft PR carries the failed proof instead); once a reviewer ran,
      // publishReviewVerdict still throws on a missing outcome. (A
      // conformance stage can only reach here alongside a reviewer — the assembly check above rejects
      // conformance on a reviewer-less flow — so this skip can never swallow a conformance narrative.)
      const pipelineHasReviewer = pipeline.some((s) => s.name === STAGE.REVIEWER);
      if (!whiteLabel && pipelineHasReviewer && reviewerOutcome !== undefined) {
        const conformanceOutcome = outcomes.find((o) => o.name === STAGE.CONFORMANCE);
        await adapter.publishVerdict({
          prUrl: pr.prUrl,
          // The pre-push rebase may have rewritten the commit; the marker names the pushed head.
          headSha: pr.headSha,
          reviewerOutcome,
          conformanceOutcome,
          attribution: buildReviewerAttribution(reviewerOutcome, agents.agent.name),
          ...(deps.reviewGate === true ? { gate: true } : {}),
        });
      }
      await writer.writeStages(outcomes, { ...runMeta, prUrl: pr.prUrl });
      await stepSummary(verificationFailed ? 'verify-failed' : 'completed', { prUrl: pr.prUrl });
      if (verification !== undefined && !verification.passed) await adapter.addFailureLabel(pr.prUrl, 'verify');
      if (visualProofFailed) await adapter.addFailureLabel(pr.prUrl, 'visual-proof');
      // Unlike addFailureLabel (best-effort), this must not be swallowed: the label IS the gate a
      // human review relies on (GATE_CONFIG_REVIEW_INSTRUCTION keys off it), so a failed flip is
      // reported rather than handing back an unflagged PR for review.
      if (configPaths.length > 0) await adapter.addGateConfigLabel(pr.prUrl);
      if (!whiteLabel) await adapter.linkPr(issueRef, task, pr.prUrl);
      onEvent({ type: 'run-end', prUrl: pr.prUrl });
      return { task, prUrl: pr.prUrl };
    } catch (error) {
      await stepSummary('error', { error: String(error) });
      throw error;
    } finally {
      await refreshRetrospectiveMemory(deps.repoPath).catch((err: unknown) => {
        console.error('retrospective memory refresh failed (non-fatal):', err);
      });
      await markerWrites;
      await clearStageMarker(deps.repoPath, adapter.taskId(task)).catch(() => undefined);
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
