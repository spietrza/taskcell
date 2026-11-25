import { readFile } from 'node:fs/promises';
import { openAgentSession } from './agent-session.js';
import type { CredentialDeps } from './agent-session.js';
import { readCooldowns } from '../core/model-pool.js';
import { skillRegistryForRun } from '../context/skill-registry.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { DeliveryTarget } from './deliver-change.js';
import type { SandboxWiring } from '../sandbox/sandbox-context.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { PipelineStage, StageOutcome } from '../pipeline/pipeline.js';
import type { RunEvent } from '../pipeline/events.js';
import { flowOf, planIssueRun, resolveBaseStages } from './run-plan.js';
import { tokenRotationFor } from '../agents/token-rotation.js';
import { CredentialLimited, executeIssueRun, PoolEntryLimited } from './run-execution.js';

// The decisions and the execution moved out; these names stay importable from here.
export { MODEL_LABEL_PREFIX, modelFromLabels, resolveForkScorerConfig } from './run-plan.js';
export { BASE_RED_OK_LABEL, conventionalCommitMessage, stagePicks } from './run-execution.js';

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
  /** Git author for the commit (default: `Taskcell <vanguard@local>`). Set via --commit-author. */
  commitAuthor?: { name: string; email: string };
  /**
   * When true, run a dedicated planning stage first (opus, high effort) before implement/review — the
   * plan-implement-review pipeline — instead of the source's default implement-first stages. Set via --plan.
   */
  plan?: boolean;
  /**
   * Named flow key (a `FLOWS` registry entry, e.g. 'flow-b'). Set via `--flow`. `--plan` is the
   * back-compat alias for `flow: 'plan'`. When set, `FLOWS[flow].build()` supplies the base stages
   * instead of the tracker's — EXCEPT `'default'`, which means "the tracker's own stages" (a tracker
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
   * Skills directory injected into the sandbox (Taskcell's bundled `skills/` in the factory), merged
   * with the target repo's own `.github/vanguard-skills/`. Set via --skills.
   */
  skillsDir?: string;
  /**
   * Skills the run must load, named by hand (`--skill`, repeatable); merged with the task body's
   * `Skills:` line. An id that is not installed fails the run before any model call.
   */
  namedSkills?: string[];
  /**
   * Opt-in persistent pnpm store (off by default): mounts `/pnpm-store` into the sandbox and sets
   * `npm_config_store_dir`, so the base-red install and the post-implement reinstall (#655) stop
   * re-downloading a repo's dependencies from scratch. One store per repo, never shared — see
   * `pnpmStoreConfig` in sandbox/limits.ts and docs/cli.md for the store-poisoning tradeoff. Set via
   * --pnpm-store / TASKCELL_PNPM_STORE.
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
    ...(cmd.namedSkills !== undefined ? { namedSkills: cmd.namedSkills } : {}),
    ...(cmd.pnpmStore !== undefined ? { pnpmStore: cmd.pnpmStore } : {}),
  };
}

/** Shared dependencies for all source-backed issue runners. */
export interface RunIssueDeps extends RunOptions, CredentialDeps {
  /** The hub login (or `token`) that started this run; stamped on its run records. */
  startedBy?: string;
  /** `namedSkills` is the whole hand-picked list (the hub form, which preselects the card's skills): the body's `Skills:` line is not merged in. */
  namedSkillsOnly?: boolean;
  auth?: AgentAuth;
  repoPath: string;
  /** Egress enclave + llm-proxy wiring from `startSandboxContext`; absent = direct mode. */
  sandboxContext?: SandboxWiring;
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

/** Semantic kind of a PR/MR triage signal; trackers map it to a platform label string. */
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

/** What a run decides about its new PR/MR; the host adds the CLI and push credential. */
export type NewPrTarget = Omit<Extract<DeliveryTarget, { kind: 'new-pr' }>, 'kind' | 'cli' | 'tokenProvider'>;

/** The review surface a run delivers to: opens/labels/annotates the PR or MR. Written once per host, picked by the caller. */
export interface ReviewHost {
  /** `gh`/`glab`: the CLI that opens the draft PR/MR. `local`: the result stays a local branch — nothing is pushed and no PR/MR is opened (a hub-board task in a repository with no GitHub origin). */
  kind: 'gh' | 'glab' | 'local';
  /** Where a new change goes: this host's PR/MR (CLI and push credential included), or a local branch. */
  newPrTarget(pr: NewPrTarget): DeliveryTarget;
  /** Post the reviewer verdict (+ optional conformance section) onto the opened PR/MR. */
  publishVerdict(input: PublishVerdictInput): Promise<void>;
  /** Add a proof-failure label to the opened PR/MR (best-effort; must never throw). */
  addFailureLabel(prUrl: string, kind: ProofFailureKind): Promise<void>;
  /**
   * Flag the opened PR/MR as touching gate config. Unlike addFailureLabel this is NOT best-effort:
   * the label IS the gate a human review keys off (GATE_CONFIG_REVIEW_INSTRUCTION in pr-review.ts /
   * mr-review.ts), so a failed flip must throw rather than hand back an unflagged PR. A no-op on a
   * host that has no labelable review surface.
   */
  addGateConfigLabel(prUrl: string): Promise<void>;
}

const none = async (): Promise<void> => undefined;

/** No review host: the result is a local branch, so there is no verdict to post and nothing to label. */
export const localReviewHost: ReviewHost = { kind: 'local', newPrTarget: () => ({ kind: 'local-branch' }), publishVerdict: none, addFailureLabel: none, addGateConfigLabel: none };

/** Per-source seam (the issue tracker): fetch/prepare, extra secrets, id derivation, stage set, extra variables, PR link-back. */
export interface Tracker {
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
  /** A `local` delivery: the branch that holds the committed result. */
  branch?: string;
  /** True when a PR was withheld because the secret scan flagged the outgoing diff — NOT "no changes". */
  secretBlocked?: boolean;
  /** True when the run stopped before implementing because the base branch is already red — NOT "no changes". */
  baseRed?: boolean;
  /** True when a result was delivered (a PR or a local branch) but its verify command failed. */
  verificationFailed?: boolean;
  /** True when the implementer stopped before signalling it was done (e.g. it asked a question): the result is partial. */
  implementerIncomplete?: boolean;
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
 * Shared pipeline body for GitHub and Linear issue runners, parameterised by a Tracker and a ReviewHost. A model
 * pool whose entry hits a provider limit is re-run on the next entry, then on the fallback chain; the
 * limit escapes (as today) only once every entry the stage can use is out.
 */
export async function runSourcedIssue(
  issueRef: string,
  configuredDeps: RunIssueDeps,
  tracker: Tracker,
  host: ReviewHost,
): Promise<RunIssueResult> {
  // Entries that hit a limit during this run: skipped by the next attempt even when the cool-down file cannot be written.
  const exhausted = new Set<string>();
  return runWithTokenRotation(issueRef, configuredDeps, async (deps) => {
    for (;;) {
      try {
        return await runSourcedIssueAttempt(issueRef, deps, tracker, host, exhausted);
      } catch (error) {
        // Anything else (a CredentialLimited too) goes to the caller: the hub's createRun cools the account and restarts.
        if (!(error instanceof PoolEntryLimited)) throw error;
        console.log(`taskcell: ${issueRef} ${error.message}; retrying on the next pool entry`);
      }
    }
  });
}

/**
 * Several subscription tokens outside the hub and outside an LLM proxy (which rotates them itself): a limit on
 * one restarts the run on the next, and only when every token is out does the limit reach the fallback chain.
 * With a single token (or any other auth) `attempt` runs once, exactly as before.
 */
export async function runWithTokenRotation<T>(issueRef: string, configuredDeps: RunIssueDeps, attempt: (deps: RunIssueDeps) => Promise<T>): Promise<T> {
  const rotation = configuredDeps.credentialRotation === undefined && configuredDeps.sandboxContext?.llmProxy === undefined ? tokenRotationFor(configuredDeps.auth) : undefined;
  if (rotation === undefined) return attempt(configuredDeps);
  for (;;) {
    try {
      return await attempt({
        ...configuredDeps,
        auth: rotation.auth(),
        credentialName: rotation.name(),
        credentialRotation: { provider: rotation.provider, hasNext: async () => rotation.hasNext() },
        onCredentialCooled: async (until) => rotation.cool(until),
      });
    } catch (error) {
      if (!(error instanceof CredentialLimited)) throw error;
      const from = rotation.name();
      if (!rotation.limited(error.until)) throw error.limit;
      console.log(`taskcell: ${issueRef} ${from} hit a plan limit; continuing on ${rotation.name()}`);
    }
  }
}

async function runSourcedIssueAttempt(
  issueRef: string,
  deps: RunIssueDeps,
  tracker: Tracker,
  host: ReviewHost,
  exhausted: Set<string>,
): Promise<RunIssueResult> {
  // Named-flow dispatch, resolved FIRST: a flow typo must fail before the tracker fetch, the
  // provider proxies, and the sandbox spin-up (the CLI mirror of the sidecar fail-fast, S5 D6).
  // `--flow <name>` selects a FLOWS builder or a repo `.taskcell/flows/*.hcl` flow; `--plan` is
  // the back-compat alias for flow 'plan'.
  const baseStages = await resolveBaseStages(flowOf(deps), deps.repoPath, tracker, deps.customProviders);
  // Every source gets the same skills: the --skills dir plus the repo's own .github/vanguard-skills/.
  const [{ task: fetchedTask }, skills] = await Promise.all([tracker.prepare(issueRef), skillRegistryForRun(deps.skillsDir, deps.repoPath)]);
  const cooldowns = await readCooldowns(deps.repoPath).catch(() => new Map<string, Date>());
  const plan = await planIssueRun({
    fetchedTask,
    deps,
    baseStages,
    tracker,
    skillIds: skills.ids(),
    ...(deps.specFile !== undefined ? { specFileText: await readSpecFile(deps.specFile) } : {}),
    cooldowns,
    exhausted,
  });
  for (const warning of plan.warnings) console.warn(warning);
  for (const line of plan.logs) console.log(line);
  // One credential context for the whole run: every provider key reader (agents, rotation, fork scorer,
  // difficulty probe) and every secret gate/redaction takes it from here.
  const session = await openAgentSession({
    choice: plan.choice,
    repoPath: deps.repoPath,
    usageCap: 'stages',
    ...(deps.auth !== undefined ? { auth: deps.auth } : {}),
    ...(deps.sandboxContext !== undefined ? { sandboxContext: deps.sandboxContext } : {}),
    ...(deps.pnpmStore !== undefined ? { pnpmStore: deps.pnpmStore } : {}),
    ...(tracker.secrets !== undefined ? { secrets: tracker.secrets } : {}),
  });
  // The session owns the provider sidecars, sandbox and context: closed on every exit path below.
  try {
    return await executeIssueRun({ issueRef, plan, session, skills, tracker, host, exhausted });
  } finally {
    await session.close();
  }
}
