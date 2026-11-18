import { linearWatchPrimitives, linearSpecPrimitives } from './linear.js';
import type { WatchLinearOptions, WatchLinearSpecOptions } from './linear.js';
import { githubIssueWatchPrimitives, githubSpecPrimitives, githubProjectWatchPrimitives } from './github.js';
import type { WatchGithubOptions, WatchGithubSpecOptions, WatchGithubProjectOptions } from './github.js';
import { gitlabWatchPrimitives, gitlabSpecPrimitives } from './gitlab.js';
import type { WatchGitlabOptions, WatchGitlabSpecOptions } from './gitlab.js';
import { fanOut } from '../pipeline/fan-out.js';
import { failureReason } from '../core/errors.js';
import type { WatchPrimitives, SpecWatchPrimitives } from './watch-shared.js';

// The per-source primitives live in their source modules and the shared contract in watch-shared.ts;
// re-exported so existing importers of this module keep working.
export { specComment } from './watch-shared.js';
export type { GenerateSpec, WatchRunOutcome, WatchPrimitives, SpecWatchPrimitives } from './watch-shared.js';
export { linearWatchPrimitives, linearSpecPrimitives } from './linear.js';
export type { WatchLinearOptions, WatchLinearSpecOptions } from './linear.js';
export { githubIssueWatchPrimitives, githubSpecPrimitives, githubProjectWatchPrimitives } from './github.js';
export type { WatchGithubOptions, WatchGithubSpecOptions, WatchGithubProjectOptions } from './github.js';
export { gitlabWatchPrimitives, gitlabSpecPrimitives } from './gitlab.js';
export type { WatchGitlabOptions, WatchGitlabSpecOptions } from './gitlab.js';

export interface WatchTick {
  opened: string[];
  noChange: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
  /** Ready but left unclaimed for the next poll, because --max-tasks was already met. */
  deferred: string[];
  /** PR withheld by the secret scan; held for a human (never reverted to the trigger). */
  secretBlocked: string[];
}

type Kind = 'opened' | 'noChange' | 'failed' | 'skipped' | 'deferred' | 'secretBlocked';

interface WatchLogOptions {
  log?: (msg: string) => void;
  phase?: string;
}

interface WatchOnceOptions extends WatchLogOptions {
  concurrency?: number;
  /** Cap the number of ready tasks successfully claimed and processed this poll, per phase (unset: process all). */
  maxTasks?: number;
}

interface SpecOnceOptions extends WatchOnceOptions {
  /** (loop-v1) No agent pass follows the spec pass, so this watch never builds an advanced ticket. */
  specOnly?: boolean;
}

function operatorLog(opts: WatchLogOptions, msg: string): void {
  opts.log?.(msg);
}

/** Summary suffix for a capped poll; empty when --max-tasks left nothing for the next poll. */
function deferredNote(tick: { deferred: string[] }): string {
  return tick.deferred.length > 0 ? `, ${tick.deferred.length} deferred by --max-tasks` : '';
}

/** Summary suffix for runs the secret scan withheld; empty on a clean poll. */
function secretBlockedNote(tick: { secretBlocked: string[] }): string {
  return tick.secretBlocked.length > 0 ? `, ${tick.secretBlocked.length} secret-blocked` : '';
}

/**
 * Report a failed run on its ticket. A throwing write-back must not reject the item: fanOut would
 * settle it as rejected, which no bucket counts, and the run's own error would never be printed.
 */
async function noteFailure(
  onFailure: (id: string, error: unknown) => Promise<void>,
  id: string,
  error: unknown,
  opts: WatchLogOptions,
  phase: string,
): Promise<void> {
  try {
    await onFailure(id, error);
  } catch (noteError) {
    operatorLog(opts, `${phase} ${id}: failure note failed -> manual label check (${failureReason(noteError)})`);
  }
}

function logPoll(ready: number, opts: WatchOnceOptions, phase: string): void {
  const cappedNote = opts.maxTasks !== undefined && opts.maxTasks < ready ? ` (capped to ${opts.maxTasks} by --max-tasks)` : '';
  operatorLog(opts, `${phase}: poll -> ${ready} ready${cappedNote}`);
}

/** `taken`: the claim threw (another runner has it). `deferred`: --max-tasks is already met. */
type ClaimOutcome = 'claimed' | 'taken' | 'deferred';

/**
 * Claim gate for one poll. Under --max-tasks, claims run one at a time in fetcher order and only a
 * successful claim counts, so items another runner already took do not use up the cap; the rest stay
 * unclaimed for the next poll. Uncapped, claims run concurrently as before.
 */
function claimGate(maxTasks: number | undefined): (claim: () => Promise<void>) => Promise<ClaimOutcome> {
  let claimed = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (claim) => {
    const attempt = async (): Promise<ClaimOutcome> => {
      if (maxTasks !== undefined && claimed >= maxTasks) return 'deferred';
      try {
        await claim();
      } catch {
        return 'taken';
      }
      claimed += 1;
      return 'claimed';
    };
    if (maxTasks === undefined) return attempt();
    const next = queue.then(attempt);
    queue = next;
    return next;
  };
}

/**
 * One poll: claim each ready issue (skipping any that can't be claimed), run it, then move it to
 * review when a PR opens or report the failure. Pure orchestration over injected primitives, so the
 * claim-before-run ordering and dedup are unit-testable without Linear.
 */
export async function watchOnce(primitives: WatchPrimitives, opts: WatchOnceOptions = {}): Promise<WatchTick> {
  const phase = opts.phase ?? 'watch';
  const ready = await primitives.listReady();
  logPoll(ready.length, opts, phase);
  const claim = claimGate(opts.maxTasks);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: Kind }> => {
      const claimed = await claim(() => primitives.claim(item.id));
      if (claimed === 'deferred') return { id: item.id, kind: 'deferred' };
      if (claimed === 'taken') {
        operatorLog(opts, `${phase} ${item.id}: skipped -> already claimed`);
        return { id: item.id, kind: 'skipped' };
      }
      operatorLog(opts, `${phase} ${item.id}: claim -> running`);
      try {
        const { prUrl, parked, secretBlocked, baseRed } = await primitives.runOne(item.id);
        if (baseRed === true) {
          operatorLog(opts, `${phase} ${item.id}: base branch red -> held, no re-run until re-labelled`);
          await primitives.onBaseRed?.(item.id);
          return { id: item.id, kind: 'noChange' };
        }
        if (secretBlocked === true) {
          // Log first: if the hold edit below throws, the failure comment must not be the only record.
          operatorLog(opts, `${phase} ${item.id}: secret blocked -> held for a human`);
          await primitives.onSecretBlocked?.(item.id);
          return { id: item.id, kind: 'secretBlocked' };
        }
        if (prUrl === undefined) {
          if (parked !== true) await primitives.onNoChange(item.id);
          operatorLog(opts, `${phase} ${item.id}: no change -> idle`);
          return { id: item.id, kind: 'noChange' };
        }
        await primitives.review(item.id);
        operatorLog(opts, `${phase} ${item.id}: pr opened -> review`);
        return { id: item.id, kind: 'opened' };
      } catch (error) {
        await noteFailure(primitives.onFailure, item.id, error, opts, phase);
        operatorLog(opts, `${phase} ${item.id}: failed -> failure noted (${failureReason(error)})`);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: Kind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return {
    opened: ids('opened'),
    noChange: ids('noChange'),
    failed: ids('failed'),
    skipped: ids('skipped'),
    deferred: ids('deferred'),
    secretBlocked: ids('secretBlocked'),
  };
}

export interface SpecTick {
  /** Triaged ready: spec generated, posted, and advanced to the agent trigger. */
  advanced: string[];
  /** Triaged vague: a clarification was requested and the issue moved to needs-info. */
  needsInfo: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
  /** Ready but left unclaimed for the next poll, because --max-tasks was already met. */
  deferred: string[];
}

type SpecKind = 'advanced' | 'needsInfo' | 'failed' | 'skipped' | 'deferred';

/**
 * One SPEC poll: claim each ready issue (skipping any that can't be claimed), triage it, then either
 * generate+post a tech spec and advance it to the agent trigger, or request clarification and move it
 * to needs-info. Mirrors watchOnce structurally (claim-before-run, fan-out, failure isolation) but
 * with honest spec semantics instead of PR semantics — it never opens a PR.
 */
export async function specOnce(primitives: SpecWatchPrimitives, opts: SpecOnceOptions = {}): Promise<SpecTick> {
  const phase = opts.phase ?? 'spec';
  const advancedNext = opts.specOnly === true ? 'not built (--spec-only)' : 'next poll agent';
  const ready = await primitives.listReady();
  logPoll(ready.length, opts, phase);
  const claim = claimGate(opts.maxTasks);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: SpecKind }> => {
      const claimed = await claim(() => primitives.claim(item.id));
      if (claimed === 'deferred') return { id: item.id, kind: 'deferred' };
      if (claimed === 'taken') {
        operatorLog(opts, `${phase} ${item.id}: skipped -> already claimed`);
        return { id: item.id, kind: 'skipped' };
      }
      operatorLog(opts, `${phase} ${item.id}: claim -> triage`);
      try {
        const outcome = await primitives.runSpec(item.id);
        operatorLog(
          opts,
          outcome === 'advanced'
            ? `${phase} ${item.id}: advanced -> ${advancedNext}`
            : `${phase} ${item.id}: needs info -> waiting human`,
        );
        return { id: item.id, kind: outcome === 'advanced' ? 'advanced' : 'needsInfo' };
      } catch (error) {
        await noteFailure(primitives.onFailure, item.id, error, opts, phase);
        operatorLog(opts, `${phase} ${item.id}: failed -> retry later (${failureReason(error)})`);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: SpecKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { advanced: ids('advanced'), needsInfo: ids('needsInfo'), failed: ids('failed'), skipped: ids('skipped'), deferred: ids('deferred') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // Detach on the timer path too, or a long-lived signal gains one listener per tick.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface LoopControls {
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
}

interface LoopV1Controls extends LoopControls {
  /** Run only the spec pass each tick; the agent pass never lists, claims or runs. */
  specOnly?: boolean;
}

/** Poll on an interval, running each newly-ready item. Stops on signal or after one pass (once). */
async function runWatchLoop(primitives: WatchPrimitives, opts: LoopControls, log: (msg: string) => void): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchOnce(primitives, {
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {}),
      log,
      phase: 'watch',
    });
    log(`watch: ${tick.opened.length} PR(s), ${tick.noChange.length} no-change, ${tick.failed.length} failed, ${tick.skipped.length} skipped${deferredNote(tick)}${secretBlockedNote(tick)}.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

/** Poll Linear and run each newly-ready issue. */
export async function watchLinear(opts: WatchLinearOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(linearWatchPrimitives(opts), opts, log);
}

/**
 * Loop-v1 poll: run the SPEC pass (specOnce over specPrimitives) then the AGENT pass (watchOnce over
 * agentPrimitives) once per tick. Continuous loops defer freshly-specced tickets to the next poll,
 * giving a human a window to intervene before the agent runs. One-shot runs carry freshly-specced
 * tickets into the same invocation, which avoids relying on GitHub's eventually consistent label
 * search in GitHub Actions. With specOnly the agent pass is skipped entirely: advanced tickets move
 * to the spec pass's agent state/label (a review state in a review-window setup) and this watch
 * never builds them.
 * Pure orchestration over injected primitives; the per-source wrappers build the primitives.
 */
export async function runLoopV1(
  specPrimitives: SpecWatchPrimitives,
  agentPrimitives: WatchPrimitives,
  opts: LoopV1Controls,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const concurrency = opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {};
  const specOnly = opts.specOnly === true ? { specOnly: true } : {};
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const maxTasks = opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {};
    const spec = await specOnce(specPrimitives, { ...concurrency, ...maxTasks, ...specOnly, log, phase: 'spec' });
    log(`spec: ${spec.advanced.length} advanced, ${spec.needsInfo.length} needs-info, ${spec.failed.length} failed, ${spec.skipped.length} skipped${deferredNote(spec)}.`);
    if (opts.specOnly === true) {
      if (opts.once === true) return;
      await delay(intervalMs, opts.signal);
      continue;
    }
    // GitHub's label index is eventually consistent: a label written by the spec pass may not
    // appear in listReady for several seconds. In --once mode carry just-advanced IDs directly
    // into the agent ready-set so spec→build completes in one invocation, deduping against what
    // the index already returned. In continuous mode exclude them — the next poll is the
    // human-intervention window before the agent runs.
    const listed = await agentPrimitives.listReady();
    const advancedSet = new Set(spec.advanced);
    const listedIds = new Set(listed.map((item) => item.id));
    const agentReady =
      opts.once === true
        ? [...spec.advanced.filter((id) => !listedIds.has(id)).map((id) => ({ id })), ...listed]
        : listed.filter((item) => !advancedSet.has(item.id));
    const agentThisTick: WatchPrimitives = {
      ...agentPrimitives,
      listReady: async () => agentReady,
    };
    const agent = await watchOnce(agentThisTick, { ...concurrency, ...maxTasks, log, phase: 'watch' });
    log(`watch: ${agent.opened.length} PR(s), ${agent.noChange.length} no-change, ${agent.failed.length} failed, ${agent.skipped.length} skipped${deferredNote(agent)}${secretBlockedNote(agent)}.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

export interface WatchLinearLoopV1Options {
  /** SPEC-pass options (state+label trigger, spec-gen, advance to the agent state). */
  spec: WatchLinearSpecOptions;
  /** AGENT-pass options. Supply needsInfoState to gate vague tickets out of the implement budget. */
  agent: WatchLinearOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  /** Run only the spec pass each poll; advanced issues move to spec.agentState and are not built by this watch. */
  specOnly?: boolean;
  signal?: AbortSignal;
}

/** Loop v1 over Linear: each poll runs the spec pass then the agent pass. */
export async function watchLinearLoopV1(opts: WatchLinearLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(linearSpecPrimitives(opts.spec), linearWatchPrimitives(opts.agent), opts, log);
}

/** Poll GitHub Issues and run each newly-ready (labeled) issue. */
export async function watchGithub(opts: WatchGithubOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubIssueWatchPrimitives(opts, log), opts, log);
}

export interface WatchGithubLoopV1Options {
  /** SPEC-pass options (label trigger, spec-gen, swap to the agent label). */
  spec: WatchGithubSpecOptions;
  /** AGENT-pass options. Supply needsInfoLabel to gate vague tickets out of the implement budget. */
  agent: WatchGithubOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  /** Run only the spec pass each poll; advanced issues get spec.agentLabel and are not built by this watch. */
  specOnly?: boolean;
  signal?: AbortSignal;
}

/** Loop v1 over GitHub Issues: each poll runs the spec pass then the agent pass. */
export async function watchGithubLoopV1(opts: WatchGithubLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(githubSpecPrimitives(opts.spec, log), githubIssueWatchPrimitives(opts.agent, log), opts, log);
}

/** Poll GitHub Projects v2 and run each item in the trigger Status. */
export async function watchGithubProject(opts: WatchGithubProjectOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubProjectWatchPrimitives(opts, log), opts, log);
}

export interface WatchGitlabLoopV1Options {
  /** SPEC-pass options (label trigger, spec-gen, swap to the agent label). */
  spec: WatchGitlabSpecOptions;
  /** AGENT-pass options. Supply needsInfoLabel to gate vague tickets out of the implement budget. */
  agent: WatchGitlabOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  /** Run only the spec pass each poll; advanced issues get spec.agentLabel and are not built by this watch. */
  specOnly?: boolean;
  signal?: AbortSignal;
}

/** Poll GitLab Issues and run each newly-ready (labeled) issue. */
export async function watchGitlab(opts: WatchGitlabOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(gitlabWatchPrimitives(opts), opts, log);
}

/** Loop v1 over GitLab Issues: each poll runs the spec pass then the agent pass. */
export async function watchGitlabLoopV1(opts: WatchGitlabLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(gitlabSpecPrimitives(opts.spec), gitlabWatchPrimitives(opts.agent), opts, log);
}
