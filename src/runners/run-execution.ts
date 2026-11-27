import { loadGateConfigExtraGlobs } from '../context/gate-config.js';
import { clearStageMarker, writeStageMarker } from '../core/run-stage-marker.js';
import { reviewVerdictLine, reviewVerdictOf } from '../pipeline/review-verdict.js';
import { trustedSpecText, isTrustedComment } from '../tasks/comment-trust.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { escapePromptTags } from '../context/escape.js';
import { hasLabel } from '../core/labels.js';
import { coolPoolEntries } from './agent-session.js';
import type { AgentSession } from './agent-session.js';
import { probeTaskDifficulty, decisionProbeConfig } from '../core/decision-probe.js';
import { TaskcellError, ProviderLimitError } from '../core/errors.js';
import { isStructuredProviderLimit } from '../core/rate-limit-marker.js';
import { recordCooldown, entryKey, cooldownUntil } from '../core/model-pool.js';
import type { StagePick } from './model-pool-routing.js';
import { decisionDiffScorer } from '../evals/decision-judge.js';
import { SPEC_TAG } from '../tasks/triage.js';
import { runStages, sandboxComplete, reviewFinalDiff, STAGE } from '../pipeline/pipeline.js';
import { buildReviewerAttribution, hasBlockingFinding } from '../pipeline/review-publish.js';
import { stripReviewMarkers } from './review-prompt.js';
import { beginRun, persistDecisionProbe } from '../core/run-store.js';
import type { RunSkills } from '../core/run-store.js';
import type { SecretBlock } from '../core/secret-scan.js';
import { redactForPublish } from '../core/secret-scan.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { appendStepSummary, authFallbackNotice } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import { loadLessonsForTask } from '../core/lessons.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback, proofBlock, verifySkippedBlock, baseRedBlock } from '../pipeline/verify.js';
import { resolveBaselineVerify } from '../pipeline/baseline-verify.js';
import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { reviewRequestBody } from './review-body.js';
import { repairUntilGreen } from '../pipeline/repair-gate.js';
import { SANDBOX_WORKDIR, gitHostScreens, sandboxBaseCheckout, sandboxCapture, screensSection } from './ui-screens.js';
import { deliverChange, conventionalPrTitle, scanOutgoingForSecrets } from './deliver-change.js';
import {
  parseSpecManifest,
  primaryModuleScope,
  checkConformance,
  extractDiffFiles,
  renderConformanceFeedback,
  commitLeakWarningBlock,
  prBodyGapWarningBlock,
  PASSING_RESULT,
} from '../pipeline/conformance-gate.js';
import type { ConformanceResult } from '../pipeline/conformance-gate.js';
import type { VerificationResult } from '../pipeline/verify.js';
import type { StageOutcome } from '../pipeline/pipeline.js';
import type { GateResult, RepairGateOptions } from '../pipeline/repair-gate.js';
import type { RunResult } from '../core/types.js';
import type { RunEvent } from '../pipeline/events.js';
import type { SkillRegistry } from '../context/skill-registry.js';
import { REVIEW_TIER, MAX_REPAIR_ITERATIONS, branchIdFromTaskId, planIssuePipeline, planIssueSkills, resolveForkScorerConfig, tierPick } from './run-plan.js';
import type { IssueRunPlan } from './run-plan.js';
import type { ReviewHost, RunIssueResult, Tracker } from './source-adapter.js';

/** Issue label that skips the base-red check: the task is meant to fix the red base. */
export const BASE_RED_OK_LABEL = 'taskcell:base-red-ok';
/** A verify command that installs its dependencies before running anything (the auto-detected JS shape). */
const SELF_INSTALLING_VERIFY_RE = /^\s*(?:(?:pnpm|yarn|npm) install --frozen-lockfile|npm ci|npm install --no-package-lock)\s*&&/;

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

/** Thrown by one attempt when a pool entry hit a limit and another entry or fallback still has quota. */
export class PoolEntryLimited extends Error {
  constructor(readonly limit: unknown, readonly keys: readonly string[]) {
    super(`pool entries out of quota: ${keys.join(', ')}`);
  }
}

const pinnedName = (p: string | { name: string } | undefined): string | undefined => (typeof p === 'string' ? p : p?.name);

/** A stage on the rotation's provider hit a limit and its fallback rescued it: cool the run's account until the limit resets, so the next run starts on the next one. A stage on another provider cools nothing. */
export async function coolRescuedCredential(
  outcomes: readonly { name: string; primaryLimitResetAt?: string }[],
  providerOf: (stage: string) => string,
  rotationProvider: string | undefined,
  onCooled: ((until: Date) => Promise<void>) | undefined,
): Promise<void> {
  if (rotationProvider === undefined) return;
  for (const o of outcomes) {
    if (o.primaryLimitResetAt !== undefined && providerOf(o.name) === rotationProvider) await onCooled?.(new Date(o.primaryLimitResetAt)).catch(() => undefined);
  }
}

/** Thrown by one attempt when its stored credential hit a provider limit and another account of that provider has quota. */
export class CredentialLimited extends Error {
  constructor(readonly limit: unknown, readonly until: Date) {
    super('credential out of quota');
  }
}

/**
 * Per stage that ran: the provider/model actually used and why it was picked (rotation, skip after a
 * limit, fallback, label, flow pin, or plain config). Written to every stage record of the run so
 * `taskcell stats` can compare a cheaper entry on cost, gate pass rate, verdict and revise rounds.
 */
export function stagePicks(
  outcomes: readonly StageOutcome[],
  picks: Readonly<Record<string, StagePick>>,
  primaryName: string,
  labelModel?: string,
): Record<string, StagePick> {
  const out: Record<string, StagePick> = {};
  for (const o of outcomes) {
    const provider = o.providerName ?? primaryName;
    const model = o.model;
    const own = picks[o.name];
    if (own !== undefined && own.provider === provider) {
      out[o.name] = { provider, ...(model !== undefined ? { model } : {}), pick: own.pick, ...(own.skipped !== undefined ? { skipped: own.skipped } : {}) };
      continue;
    }
    const tier = REVIEW_TIER.has(o.name) && picks.reviewer !== undefined && picks.reviewer.provider === provider ? picks.reviewer : undefined;
    const fell = picks.fallback !== undefined && provider === picks.fallback.provider && provider !== primaryName;
    const pick = fell
      ? picks.fallback!.pick
      : tier !== undefined
        ? tier.pick
        : provider === primaryName && picks.implementer !== undefined && (model === undefined || model === picks.implementer.model)
          ? picks.implementer.pick
          : labelModel !== undefined && model === labelModel
            ? 'label'
            : 'config';
    // A stage rescued in-run by the fallback names the primary that hit its limit; a re-routed run names the entries it passed over.
    const skipped = fell
      ? [{ entry: entryKey(picks.implementer ?? { provider: primaryName }), ...(o.primaryLimitResetAt !== undefined ? { until: o.primaryLimitResetAt } : {}) }]
      : (pick === 'skip-limit' || pick === 'fallback') && provider === primaryName ? picks.implementer?.skipped : undefined;
    out[o.name] = { provider, ...(model !== undefined ? { model } : {}), pick, ...(skipped !== undefined ? { skipped } : {}) };
  }
  return out;
}

/** What {@link executeIssueRun} runs against: the decided plan, an open agent session (sandbox included), the adapters. */
export interface IssueRunExecution {
  issueRef: string;
  plan: IssueRunPlan;
  /** Provider sidecars, sandbox and credential context; the caller closes it. */
  session: Pick<AgentSession, 'agents' | 'credentials' | 'prepare'>;
  /** The installed skill registry the sandbox is given. */
  skills: SkillRegistry;
  tracker: Tracker;
  host: ReviewHost;
  /** Pool entries that hit a limit during this run: filled here, read by the next attempt. */
  exhausted: Set<string>;
}

/**
 * Execute a decided plan: build the worktree, run the stages, gate, deliver, and link the result back
 * through the tracker and review host. Nothing here chooses a model, flow, skill or base branch.
 */
export async function executeIssueRun(run: IssueRunExecution): Promise<RunIssueResult> {
  const { issueRef, plan, session, skills, tracker, host, exhausted } = run;
  const { task, runTaskId, whiteLabel, labelModel, deps, routing, recordedPicks, flow, baseBranch } = plan;
  const { agents, credentials } = session;
  /** The provider a stage actually runs on: its pool pick, else its own pinned provider (reviewer, flow stage), else the implementer's. */
  const stageProvider = (stage: string): string =>
    tierPick(plan, stage, agents.agent.name)?.provider
    ?? (REVIEW_TIER.has(stage) ? agents.reviewAgent?.name : pinnedName(plan.flowPools.stages.find((s) => s.name === stage)?.provider))
    ?? agents.agent.name;
  const { notes: skillNotes, record: skillsRecord } = planIssueSkills(plan, {
    agent: agents.agent.name,
    ...(agents.reviewAgent !== undefined ? { reviewAgent: agents.reviewAgent.name } : {}),
    ...(agents.fallbackAgent !== undefined ? { fallbackAgent: agents.fallbackAgent.name } : {}),
  });
  for (const note of skillNotes) console.log(`taskcell: ${task.id} ${note}`);
  // A decision-model fork scorer needs credentials; resolve them BEFORE the sandbox is built so a
  // missing key fails in a second, not after a full implementer run.
  const forkScore =
    deps.forkN !== undefined && deps.forkScorer === 'decision' ? decisionDiffScorer(resolveForkScorerConfig(whiteLabel, credentials.env), deps.signal !== undefined ? { signal: deps.signal } : {}) : undefined;
  // Lessons are picked by the files the spec plans to change as well as the paths the issue names;
  // the ids actually injected (first delivery + gate repairs) land on the run record.
  const lessonIds = new Set<string>();
  const trust = { allowedAuthors: deps.feedbackAuthors, issueAuthor: task.author };
  const specText = trustedSpecText(task, trust);
  const manifest = parseSpecManifest(specText);
  const plannedFiles = manifest?.files?.map((x) => x.path);
  const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath, {
    taskText: `${task.title}\n${task.description}`,
    ...(plannedFiles !== undefined ? { files: plannedFiles } : {}),
    onLessons: (ids) => ids.forEach((id) => lessonIds.add(id)),
  });
  // Log-only difficulty probe (decision model, opt-in via env): kicked off here so its round trip
  // hides under sandbox + worktree provisioning; awaited once the pipeline is assembled. Recorded
  // next to the run so stats can later tell whether it predicts repairs/escalation. Never routes.
  const probePromise = probeTaskDifficulty(task, labelModel ?? deps.providerModel, {
    config: decisionProbeConfig(credentials.env, { whiteLabel }),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  const ctx = await session.prepare(
    {
      taskId: runTaskId,
      localRepoPath: deps.repoPath,
      ...(agents.reviewAgent !== undefined ? { reviewAgentName: agents.reviewAgent.name } : {}),
      ...(agents.fallbackAgent !== undefined ? { fallbackAgentName: agents.fallbackAgent.name } : {}),
      // Cut from origin's copy of the base when it is ahead of the local one (on Actions the checkout is
      // the event SHA and main may already have moved), so the sandbox, verification and review see the
      // tree the PR will land on (#423). A reused branch keeps its own history.
      baseBranch,
      start: deps.reuse === true ? 'reuse' : 'base',
      ...(deps.keepLocalIfAhead !== undefined ? { keepLocalIfAhead: deps.keepLocalIfAhead } : {}),
      ...(whiteLabel ? { branchPrefix: 'feat/', branchId: branchIdFromTaskId(runTaskId) } : {}),
    },
    { skills },
  );
  let outcomes: StageOutcome[] = [];
  const notes = [...skillNotes, ...(deps.credentialName !== undefined ? [`credential: ${deps.credentialName}`] : [])];
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
      ...(notes.length > 0 ? { notes } : {}),
      ...extra,
    });
  };
  let markerWrites = Promise.resolve();
  let activeStage = 'run';
  let persistProviderStop: (() => Promise<void>) | undefined;
  try {
    if (labelModel !== undefined) {
      console.log(`taskcell: ${task.id} pins the implementer model to ${labelModel} via label (overrides --provider-model)`);
    }
    const plannedPipeline = planIssuePipeline(plan, agents);
    const probe = await probePromise;
    if (probe !== undefined && deps.signal?.aborted !== true) {
      await persistDecisionProbe(deps.repoPath, runTaskId, probe).catch(() => undefined);
      console.log(
        `taskcell: ${task.id} difficulty probe (${probe.model}, ${probe.latencyMs}ms): first-try ${probe.completesFirstTry.toFixed(2)}, difficulty ${probe.difficulty.toFixed(2)}/4, spec clear ${probe.specClear.toFixed(2)}`,
      );
    }
    // A conformance stage's narrative rides on the reviewer verdict comment (publishReviewVerdict
    // appends it as a `## Conformance` section). `--conformance` appends the stage to ANY flow, so on
    // a reviewer-less one (flow-b: adversary+repairer) it would run, cost money, and publish nothing.
    // Fail at assembly rather than surface nothing the user explicitly asked for. Giving conformance
    // its own standalone comment would need its own body format + dedupe marker; this error is that TODO.
    const hasConformance = plannedPipeline.some((s) => s.name === STAGE.CONFORMANCE);
    if (hasConformance && !plannedPipeline.some((s) => s.name === STAGE.REVIEWER)) {
      throw new Error(
        `--conformance needs a flow with a reviewer stage (its verdict rides on the review comment); flow "${flow ?? 'default'}" has none`,
      );
    }
    // The host decides "is there a spec?": a trusted comment carrying the tag. Without one the agent
    // session would only write "skipped", so drop the stage and say so here instead.
    const conformanceSkipped = hasConformance && !specText.includes(`<${SPEC_TAG}`);
    const pipeline = conformanceSkipped ? plannedPipeline.filter((s) => s.name !== STAGE.CONFORMANCE) : plannedPipeline;
    if (conformanceSkipped) {
      notes.push('conformance skipped: no spec');
      console.log(`taskcell: ${task.id} conformance skipped: no spec`);
    }
    const imageDigest = await ctx.sandbox.imageDigest?.();
    const runMeta = {
      flow: flow ?? 'default',
      provider: agents.agent.name,
      baseBranch,
      ...(imageDigest !== undefined ? { imageDigest } : {}),
      ...(deps.credentialSource !== undefined ? { credentialSource: deps.credentialSource } : {}),
      ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    };
    // Lessons are only all known once the gate repairs have run, so read them at write time.
    const stageMeta = (): typeof runMeta & { lessonIds: string[]; skills: RunSkills; maxRepairIterations: number; modelPicks?: Record<string, StagePick> } => ({
      ...runMeta,
      lessonIds: [...lessonIds],
      skills: skillsRecord,
      maxRepairIterations: deps.maxRepairIterations ?? MAX_REPAIR_ITERATIONS,
      ...(routing.pooled || labelModel !== undefined || Object.keys(recordedPicks).length > 0 ? { modelPicks: stagePicks(outcomes, recordedPicks, agents.agent.name, labelModel) } : {}),
    });
    // One RunWriter for the whole run: it owns the timestamp, so proof.json, visual-proof.json and
    // every stage record share one prefix and the hub/desktop readers can match a run's proof to
    // its stage records by name.
    const writer = beginRun(deps.repoPath, runTaskId, undefined, {
      secretEnvVars: credentials.keyEnvNames,
      ...(deps.startedBy !== undefined ? { startedBy: deps.startedBy } : {}),
    });
    const onEvent = (event: RunEvent): void => {
      if (event.type === 'stage-start') activeStage = event.name;
      markerWrites = markerWrites.then(async () => {
        if (event.type === 'stage-start') {
          await writeStageMarker(deps.repoPath, {
            taskId: runTaskId, stage: event.name, index: event.index, of: event.of,
            updatedAt: new Date().toISOString(),
          });
        } else if (event.type === 'run-end' || event.type === 'run-error' || event.type === 'run-cancelled') {
          await clearStageMarker(deps.repoPath, runTaskId);
        }
      }).catch(() => undefined);
      deps.onEvent?.(event);
    };
    persistProviderStop = async (): Promise<void> => {
      // A step after its stage returned (e.g. a repair): a record under that stage's name would overwrite the real one.
      // `after-<stage>` cannot collide with a flow stage name: `lowerFlow` reserves the `after-` prefix on the lowered name.
      const stopped: StageOutcome = {
        name: outcomes.some((outcome) => outcome.name === activeStage) ? `after-${activeStage}` : activeStage,
        result: {
          taskId: runTaskId,
          completed: false,
          exitReason: 'error',
          turns: 0,
          worktreePath: ctx.worktreePath,
          worktreePreserved: false,
          finalText: 'The provider stopped this stage because its usage or rate limit was reached.',
          stoppedBy: 'provider-limit',
        },
      };
      const recorded = outcomes.some((outcome) => outcome.name === activeStage && !outcome.result.completed)
        ? outcomes
        : [...outcomes, stopped];
      await writer.writeStages(recorded.length > 0 ? recorded : [stopped], stageMeta());
    };
    onEvent({
      type: 'run-start',
      taskId: runTaskId,
      ...runMeta,
      stages: pipeline.map((s) => s.name),
    });
    for (const message of skillNotes) onEvent({ type: 'warning', message });
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
      const baselineVerify = await resolveBaselineVerify(deps.repoPath, ctx.startRef, ctx.sandbox, verifyCmd, deps.signal, credentials.secretValues());
      if (!baselineVerify.passed) {
        console.log(
          `taskcell: ${task.id} base branch is red — \`${verifyCmd}\` already fails on ${ctx.baseBranch}@${ctx.startRef.slice(0, 7)} (exit ${baselineVerify.exitCode}); stopping before implementing instead of starting a repair loop.`,
        );
        console.log(redactForPublish(renderVerificationFeedback(baselineVerify)));
        if (!whiteLabel) await tracker.signalBaseRed(issueRef, task, baseRedBlock(ctx.baseBranch, ctx.startRef, baselineVerify));
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
      ...(tracker.variables?.(issueRef, task) ?? {}),
      RETROSPECTIVE_MEMORY: escapePromptTags(retrospectiveMemory),
    };
    // Deterministic spec-manifest vs diff conformance gate, joined with the verify command into a
    // single shared-cap repair loop: either gate failing resumes the implementer's own session with a
    // combined gap report (bounded, budget/turn caps already apply to the resumed
    // stage) — "iterate the implement loop", not "open PR and hope". It runs on the implementer's
    // output BEFORE the reviewer, so the review is never spent on code a repair round would change
    // (runStages' `gateBeforeReview`). Exhausting the cap (or having no resumable session) skips the
    // reviewer and falls through to a declared-partial PR (reviewRequestBody below), never a silent
    // `Closes` with any gate red. The secret scan also runs before the reviewer but is never repaired:
    // a hit ends the run as secret-blocked, exactly like the delivery-time scan.
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
      verification = verifyCmd !== undefined ? await runVerification(ctx.sandbox, verifyCmd) : undefined;
      // Completion is part of the gate (dogfood #352): an implementer that hit its turn cap or timeout
      // mid-task can leave residue that still typechecks and tests green. Gate on `completed`, NOT on
      // exitReason === 'maxTurns': the SDK counts internal steps as turns while vanguard counts real
      // ones. A provider that finishes but never emits <promise>COMPLETE</promise> is re-nudged and,
      // if it still won't signal, downgraded to a Part-of PR — an unverifiable "done" must not
      // auto-close the issue.
      const implementerIdx = outcomes.findIndex((o) => o.name === STAGE.IMPLEMENTER);
      implementerDone = implementerIdx === -1 || outcomes[implementerIdx]?.result.completed === true;
      const pass = conformance.pass && (verification === undefined || verification.passed) && implementerDone;
      // A red gate: hand the implementer the lessons for the files the diff actually touches.
      let repairLessons: string | undefined;
      if (!pass) {
        const repair = await loadLessonsForTask(deps.repoPath, `${task.title}\n${task.description}`, { files: extractDiffFiles(gateDiff !== '' ? gateDiff : await ctx.wm.diff(ctx.worktreePath)) });
        repair.ids.forEach((id) => lessonIds.add(id));
        repairLessons = repair.text !== '' ? repair.text : undefined;
      }
      const feedback = [
        !implementerDone
          ? 'The previous session ended before the task was finished (turn cap or timeout). Continue and complete the remaining work.'
          : undefined,
        !conformance.pass ? renderConformanceFeedback(conformance) : undefined,
        verification !== undefined && !verification.passed ? renderVerificationFeedback(verification) : undefined,
        repairLessons,
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
        modelPinned: labelModel !== undefined || pipeline.find((s) => s.name === STAGE.IMPLEMENTER)?.modelFromFlow === true,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      };
    };
    const reviewerStage = pipeline.find((s) => s.name === STAGE.REVIEWER);
    let gatedBeforeReview = false;
    // The pre-review gate stayed red, so runStages never ran the reviewer: there is no verdict to publish.
    let reviewerSkipped = false;
    let gateIterations = 0;
    // A secret in the tree the reviewer would see is a hard stop, never repair feedback: the implementer
    // is not resumed, the reviewer never runs and the run ends as secret-blocked (endSecretBlocked).
    let preReviewSecretBlock: SecretBlock | undefined;
    const scanBeforeReview = async (): Promise<boolean> => {
      preReviewSecretBlock = scanOutgoingForSecrets(await ctx.wm.outgoingDiff(ctx.worktreePath), task.id, 'pre-review gate', credentials.keyEnvNames);
      return preReviewSecretBlock === undefined;
    };
    const endSecretBlocked = async (block: SecretBlock): Promise<RunIssueResult> => {
      // The blocked diff holds the secret the scan caught: keep it (and the bundle) off disk.
      await writer.writeStages(outcomes, { ...stageMeta(), omitDiff: true });
      await stepSummary('secret-blocked');
      // White-label runs keep the automation invisible in the client repo: no secret-blocked label,
      // no branded comment. The operator still gets the masked findings on stderr + run record.
      if (!whiteLabel) await tracker.signalSecretBlock(issueRef, task, block);
      onEvent({ type: 'run-end', secretBlocked: true });
      return { task, secretBlocked: true };
    };
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
        ...(deps.credentialRotation !== undefined ? { holdLimitForRotation: async (provider: string) => provider === deps.credentialRotation!.provider && (await deps.credentialRotation!.hasNext()) } : {}),
        gateBeforeReview: async (outs) => {
          outcomes = outs;
          gatedBeforeReview = true;
          if (!(await scanBeforeReview())) return { pass: false };
          const repair = await repairUntilGreen(ctx, { ...repairOpts(), gate });
          gatePassed = repair.passed;
          gateIterations = repair.iterations;
          // A repair round may have written a secret of its own: the reviewer must not see that either.
          if (repair.iterations > 0 && !(await scanBeforeReview())) return { pass: false };
          reviewerSkipped = !repair.passed;
          return {
            pass: repair.passed,
            // A repair changed the tree: the reviewer must see the repaired diff, not the implementer's.
            ...(repair.iterations > 0 ? { diff: await ctx.wm.diff(ctx.worktreePath) } : {}),
          };
        },
      });
      if (preReviewSecretBlock !== undefined) return await endSecretBlocked(preReviewSecretBlock);
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
          taskId: runTaskId,
          completed: false,
          exitReason: 'incomplete',
          turns: 0,
          worktreePath: ctx.worktreePath,
          worktreePreserved: true,
          finalText: `Review unavailable: ${redactForPublish(String(error))}`,
          ...(isStructuredProviderLimit(error) ? { stoppedBy: 'provider-limit' as const } : {}),
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
      closeIssueOnMerge: !!tracker.closeIssueOnMerge,
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
    // A stage that ran on its fallback because the primary's credential was refused: the green run must say so.
    const authFallbackBlock = outcomes
      .filter((o) => o.primaryAuthRefused !== undefined)
      .map((o) => `> ⚠️ ${o.name} ${authFallbackNotice(o.primaryAuthRefused!, o.providerName)}`)
      .join('\n') || undefined;
    const delivery = await deliverChange(ctx, {
      taskId: task.id,
      // Default and white-label share the same type/scope logic as the PR title (conventionalPrTitle):
      // no second prefix when the title already has one, `fix:` for a `bug` label, `feat:` otherwise.
      // White-label additionally lower-cases the subject and caps the header at 100 chars so a target
      // repo's commitlint passes.
      commitMessage: whiteLabel
        ? conventionalCommitMessage(task.title, runTaskId, { bugLabel })
        : `${conventionalPrTitle(task.title, { bugLabel, ...(scope !== undefined ? { scope } : {}) })} (${task.id})`,
      ...(deps.commitAuthor !== undefined ? { commitAuthor: deps.commitAuthor } : {}),
      ...(partial ? { closingKeywordScan: true } : {}),
      // A custom provider's key env var is repo-configured: the secret gate cannot know its name.
      secretEnvVars: credentials.keyEnvNames,
      gateConfigExtraGlobs: extraGlobs,
      // Before/after screenshots of changed UI screens (demo data only); best effort, no UI change = no cost.
      screens: (files, push) => screensSection(files, {
        headDir: SANDBOX_WORKDIR,
        baseCheckout: sandboxBaseCheckout(ctx.sandbox, ctx.worktreePath, ctx.startRef, SANDBOX_WORKDIR),
        capture: sandboxCapture(ctx.sandbox),
        host: gitHostScreens({ repoDir: ctx.worktreePath, runId: runTaskId, ...(push.tokenProvider !== undefined ? { tokenProvider: push.tokenProvider } : {}) }),
      }),
      target: host.newPrTarget({
        title: `${task.title} (${task.id})`,
        bugLabel,
        ...(scope !== undefined ? { scope } : {}),
        // Ready for review only after verification, every configured proof and the review verdict
        // landed: an unavailable re-review ships as a draft too.
        draft: partial || verifyCmd === undefined || visualProofFailed || reviewUnavailable,
        body: ({ commitLeaks, facts: { configBlock }, screensBlock }) => {
          // The PR-body gap block carries no branding, so white-label keeps it like the gate-config block.
          return whiteLabel
            ? [baseBody, configBlock, prBodyGapBlock, authFallbackBlock, screensBlock].filter(Boolean).join('\n\n')
            : [
              configBlock,
              baseBody,
              commitLeaks.length > 0 ? commitLeakWarningBlock(commitLeaks) : undefined,
              prBodyGapBlock,
              authFallbackBlock,
              screensBlock,
              verification !== undefined ? proofBlock(verification) : verifySkippedBlock(),
              visualProof !== undefined ? visualProofBlock(visualProof) : undefined,
              reviewerOutcome !== undefined ? reviewVerdictLine(reviewVerdictOf(reviewerOutcome.result.finalText)) : undefined,
            ].filter((s): s is string => s !== undefined && s !== '').join('\n\n');
        },
      }),
    });
    if (delivery.kind === 'secret-blocked') return await endSecretBlocked(delivery.block);
    if (delivery.kind === 'no-changes') {
      await writer.writeStages(outcomes, { ...stageMeta(), noChanges: true });
      await stepSummary('no-changes');
      onEvent({ type: 'run-end' });
      return { task, ...(!implementerDone ? { implementerIncomplete: true } : {}) };
    }
    // Computed before the delivery-kind split: a local branch is flagged like a PR (which also gets the label).
    const configPaths = delivery.kind === 'delivered-local' || delivery.kind === 'delivered-pr'
      ? delivery.facts.configPaths
      : [];
    if (delivery.kind === 'delivered-local') {
      await writer.writeStages(outcomes, { ...stageMeta(), ...(configPaths.length > 0 ? { configPaths } : {}) });
      await stepSummary(verificationFailed ? 'verify-failed' : 'completed');
      onEvent({ type: 'run-end' });
      return { task, branch: delivery.branch, ...(verificationFailed ? { verificationFailed: true } : {}), ...(!implementerDone ? { implementerIncomplete: true } : {}) };
    }
    if (delivery.kind !== 'delivered-pr') throw new TaskcellError(`unexpected delivery outcome ${delivery.kind} for a new-pr target`);
    const pr = { prUrl: delivery.prUrl, headSha: delivery.headSha };
    // White-label mode delivers a plain PR: no Taskcell review comment and no issue link-back comment.
    // A flow without a `reviewer` stage (e.g. flow-b: adversary+repairer) has no verdict to surface,
    // so skip the verdict comment entirely. So does a red pre-review gate, which skipped the reviewer (the
    // partial draft PR carries the failed proof instead). Otherwise the no-silence guarantee still fires
    // for reviewer-bearing flows: publishReviewVerdict throws if the reviewer produced no outcome. (A
    // conformance stage can only reach here alongside a reviewer — the assembly check above rejects
    // conformance on a reviewer-less flow — so this skip can never swallow a conformance narrative.)
    const pipelineHasReviewer = pipeline.some((s) => s.name === STAGE.REVIEWER);
    if (!whiteLabel && pipelineHasReviewer && !reviewerSkipped) {
      const conformanceOutcome = outcomes.find((o) => o.name === STAGE.CONFORMANCE);
      await host.publishVerdict({
        prUrl: pr.prUrl,
        // The pre-push rebase may have rewritten the commit; the marker names the pushed head.
        headSha: pr.headSha,
        reviewerOutcome,
        conformanceOutcome,
        attribution: buildReviewerAttribution(reviewerOutcome, agents.agent.name),
        ...(deps.reviewGate === true ? { gate: true } : {}),
      });
    }
    await writer.writeStages(outcomes, { ...stageMeta(), prUrl: pr.prUrl, ...(configPaths.length > 0 ? { configPaths } : {}) });
    await stepSummary(verificationFailed ? 'verify-failed' : 'completed', { prUrl: pr.prUrl });
    if (verification !== undefined && !verification.passed) await host.addFailureLabel(pr.prUrl, 'verify');
    if (visualProofFailed) await host.addFailureLabel(pr.prUrl, 'visual-proof');
    // Unlike addFailureLabel (best-effort), this must not be swallowed: the label IS the gate a
    // human review relies on (GATE_CONFIG_REVIEW_INSTRUCTION keys off it), so a failed flip is
    // reported rather than handing back an unflagged PR for review.
    if (configPaths.length > 0) await host.addGateConfigLabel(pr.prUrl);
    if (!whiteLabel) await tracker.linkPr(issueRef, task, pr.prUrl);
    onEvent({ type: 'run-end', prUrl: pr.prUrl });
    return { task, prUrl: pr.prUrl, ...(verificationFailed ? { verificationFailed: true } : {}), ...(!implementerDone ? { implementerIncomplete: true } : {}) };
  } catch (error) {
    if (isStructuredProviderLimit(error)) {
      // The provider's accounts are exhausted before its pool entry moves on: while another account has quota, the
      // limited one is cooled by the caller and the run restarts on it. A local usage cap is per provider: rotating cannot help.
      const rotation = deps.credentialRotation;
      if (rotation !== undefined && error instanceof ProviderLimitError && stageProvider(activeStage) === rotation.provider && await rotation.hasNext()) {
        await persistProviderStop?.().catch(() => undefined);
        throw new CredentialLimited(error, cooldownUntil(error.message));
      }
      // A pooled stage cools down the entry that hit the limit (and the implementer's fallback: a limit
      // only escapes the stage once its fallback is out too), so new runs skip it until the named reset
      // or the default hour. Then this task moves on to the next entry, then the fallback chain.
      const pick = tierPick(plan, activeStage, agents.agent.name);
      if (pick !== undefined) {
        const out = [pick, ...(pick === routing.picks.implementer && routing.picks.fallback !== undefined ? [routing.picks.fallback] : [])];
        for (const key of await coolPoolEntries(deps.repoPath, out, error)) exhausted.add(key);
        // Re-route with those entries out: a tier still landing on an exhausted entry means every entry and fallback is out.
        const next = plan.reroute(exhausted);
        const stuck = [next.routing.picks.implementer, next.routing.picks.reviewer, ...Object.values(next.flowPools.picks)].some((p) => p !== undefined && exhausted.has(entryKey(p)));
        if (!stuck) throw new PoolEntryLimited(error, out.map(entryKey));
      }
      // Best effort: a failed write must not replace the limit error the caller parks the task on.
      await persistProviderStop?.().catch(() => undefined);
    }
    await stepSummary('error', { error: String(error) });
    throw error;
  } finally {
    // A stage whose own provider hit a limit and was rescued by its fallback: cool that stage's pool entry
    // until the limit resets, so new runs skip it. An outage, or a healthy stage, cools nothing.
    for (const o of outcomes) {
      const pick = o.primaryLimitResetAt !== undefined ? tierPick(plan, o.name, agents.agent.name) : undefined;
      if (pick !== undefined) await recordCooldown(deps.repoPath, pick, new Date(o.primaryLimitResetAt!)).catch(() => undefined);
    }
    await coolRescuedCredential(outcomes, stageProvider, deps.credentialRotation?.provider, deps.onCredentialCooled);
    await refreshRetrospectiveMemory(deps.repoPath).catch((err: unknown) => {
      console.error('retrospective memory refresh failed (non-fatal):', err);
    });
    await markerWrites;
    await clearStageMarker(deps.repoPath, runTaskId).catch(() => undefined);
  }
}
