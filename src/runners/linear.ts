import { LinearCliTaskFetcher, linkLinearIssue, commentLinearIssue, setLinearState, linearGraphql } from '../tasks/linear-cli.js';
import { applyLinearDependencyGate } from '../tasks/linear-dependencies.js';
import { runSpecGenerator } from './spec.js';
import { NO_CHANGE_MSG, holdMessage, commentAndRevert, failureOrCapComment, runSpecCore, triageAgentRun } from './watch-shared.js';
import type { WatchPrimitives, SpecWatchPrimitives, GenerateSpec } from './watch-shared.js';
import type { RunSpecGeneratorDeps } from './spec.js';
import type { LinearCliRunner, LinearGraphql } from '../tasks/linear-cli.js';
import { implementReviewSimplifyStages, retrospectiveMemoryBlock } from '../pipeline/pipeline.js';
import { fanOut } from '../pipeline/fan-out.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { runSourcedIssue } from './source-adapter.js';
import { knownGitlabProjectFromOrigin, gitlabReviewHost } from './gitlab.js';
import { githubReviewHost } from './github.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { Task, SubTask } from '../tasks/fetcher.js';
import type { CustomProviderEntry } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { RunIssueDeps, RunIssueResult, Tracker } from './source-adapter.js';

/** Everything needed to run a single Linear issue end to end. */
export interface RunLinearIssueDeps extends RunIssueDeps {
  linearKey: string;
  /** Required here: the agent reads the issue through the linear-cli skill in this dir. */
  skillsDir: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld PR is not read as "no changes". */
export type RunLinearIssueResult = RunIssueResult;

/**
 * The canonical implement/review/simplify pipeline with only the implementer's prompt swapped, so
 * the agent reads the issue from Linear via the injected linear-cli skill. The review and simplify
 * stages stay canonical (no duplicated prompts, no silently dropped review).
 */
function linearStages(): PipelineStage[] {
  const base = implementReviewSimplifyStages();
  const implementer = base[0];
  if (implementer === undefined) throw new Error('implementReviewSimplifyStages() returned no stages');
  const readAndImplement = [
    'Use the linear-cli skill to read Linear issue {{ISSUE}} for the full spec:',
    'run `linear issue view {{ISSUE}} --json` (the `linear` CLI is installed and LINEAR_API_KEY is set).',
    '',
    'Implement it in the current repo, keeping the change minimal. If the description is too vague to',
    'write code, add or update NOTES.md summarising the issue instead.',
    '',
    retrospectiveMemoryBlock(),
    '',
    'When done, write <promise>COMPLETE</promise>.',
    '',
    'Title: {{TITLE}}',
  ].join('\n');
  return [{ ...implementer, promptTemplate: readAndImplement }, ...base.slice(1)];
}

/** Best-effort issue write-back: a failed comment must never fail the run. */
async function commentBestEffort(taskId: string, body: string): Promise<void> {
  try {
    await commentLinearIssue(taskId, body);
  } catch { /* best-effort */ }
}

/** @internal Exported for unit tests; production callers use runLinearIssue. */
export function linearTracker(deps: RunLinearIssueDeps): Tracker {
  return {
    async prepare(issueRef: string) {
      return { task: await new LinearCliTaskFetcher().fetch(issueRef) };
    },
    secrets: { LINEAR_API_KEY: deps.linearKey },
    taskId: (task) => `linear-${task.id.toLowerCase()}`,
    stages: linearStages,
    variables: (issueRef: string) => ({ ISSUE: issueRef }),
    async linkPr(_issueRef: string, task: Task, prUrl: string) {
      await linkLinearIssue(task.id, prUrl);
    },
    async signalSecretBlock(_issueRef: string, task: Task, block: SecretBlock) {
      // Linear uses workflow states, not labels; the comment is the primary signal. The watch
      // primitive that holds the issue posts how to release it (it knows the configured states).
      await commentBestEffort(task.id, renderSecretBlockComment(block));
    },
    async signalBaseRed(_issueRef: string, task: Task, body: string) {
      await commentBestEffort(task.id, body);
    },
  };
}

/**
 * Run one Linear issue end to end: the agent reads it from inside the sandbox via the injected
 * linear-cli skill, runs the canonical implement/review/simplify pipeline, opens a draft GitHub PR
 * (a draft GitLab MR when origin is on gitlab.com or GITLAB_HOST), and comments the PR/MR link back
 * onto the issue. Each call provisions its own sandbox, so callers can fan several out concurrently
 * (see runLinearParent).
 */
export async function runLinearIssue(issueRef: string, deps: RunLinearIssueDeps): Promise<RunLinearIssueResult> {
  // The review host follows origin: a draft MR through glab on gitlab.com or GITLAB_HOST, else a GitHub PR.
  const gitlabProject = await knownGitlabProjectFromOrigin(deps.repoPath);
  const host = gitlabProject === undefined ? githubReviewHost(deps.repoPath) : gitlabReviewHost(gitlabProject);
  return runSourcedIssue(issueRef, deps, linearTracker(deps), host);
}

/** Fan a Linear parent issue out into one independent run (and PR) per sub-issue. */
export async function runLinearParent(
  parentRef: string,
  deps: RunLinearIssueDeps,
  opts: { concurrency?: number } = {},
): Promise<{ parent: Task; outcomes: FanOutOutcome<SubTask, RunLinearIssueResult>[] }> {
  const parent = await new LinearCliTaskFetcher().fetch(parentRef);
  const outcomes = await fanOut(parent.children, (child) => runLinearIssue(child.id, deps), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return { parent, outcomes };
}

/** Read the run dependencies from the environment, throwing actionable errors when one is missing. */
export function linearDepsFromEnv(provider?: string, customProviders?: readonly CustomProviderEntry[]): RunLinearIssueDeps {
  const auth = agentAuthFromEnv({
    ...(provider !== undefined ? { provider } : {}),
    ...(customProviders !== undefined ? { customProviders } : {}),
  });
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR to a directory of skills (e.g. a clone of schpet/linear-cli /skills).');
  }
  return { ...(auth !== undefined ? { auth } : {}), linearKey, skillsDir, repoPath: process.env.REPO_PATH ?? process.cwd() };
}

export interface WatchLinearOptions {
  deps: RunLinearIssueDeps;
  label: string;
  /** Linear state TYPE to poll (triage/backlog/unstarted/started/...); default 'unstarted' (Todo-like). */
  triggerState?: string;
  /**
   * The display NAME of the same state as `triggerState` (which is a TYPE). Needed because
   * `setLinearState` takes a state NAME, not a type. Used by `onNoChange` to revert a genuine
   * no-change issue back to the trigger state so a later poll re-picks it. Absent => onNoChange
   * only comments (no state revert).
   */
  triggerStateName?: string;
  /** State NAME to move an issue to on claim, e.g. 'In Progress'. */
  claimedState: string;
  /** State NAME after a PR opens, e.g. 'In Review'. */
  reviewState: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + moved to this state and NO implement budget is spent (returns
   * no PR). Absent => behaviour is unchanged (no triage, straight to runLinearIssue).
   */
  needsInfoState?: string;
  team?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  linear?: LinearCliRunner;
  /** Injected for tests: the GraphQL sender for list and the dependency gate. */
  graphql?: LinearGraphql;
}

interface LinearReadyOptions {
  label: string;
  state: string;
  team?: string;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
  moveToNeedsInfo?: (id: string) => Promise<void>;
}

/** List and dependency-check with one resolved GraphQL sender for the whole poll. */
async function listLinearReady(opts: LinearReadyOptions): Promise<Task[]> {
  const graphql = opts.graphql ?? (await linearGraphql(opts.linear));
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
    graphql,
  });
  return applyLinearDependencyGate(await fetcher.list({ labels: [opts.label], state: opts.state }), {
    ...(opts.moveToNeedsInfo !== undefined ? { moveToNeedsInfo: opts.moveToNeedsInfo } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
    graphql,
  });
}

/** Build the real Linear-backed primitives: state+label trigger, claim and review via state changes. */
export function linearWatchPrimitives(opts: WatchLinearOptions): WatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
    ...(opts.graphql !== undefined ? { graphql: opts.graphql } : {}),
  });
  const trigger = opts.triggerState ?? 'unstarted';
  const needsInfoState = opts.needsInfoState;
  return {
    listReady: () =>
      listLinearReady({
        label: opts.label,
        state: trigger,
        ...(opts.team !== undefined ? { team: opts.team } : {}),
        ...(needsInfoState !== undefined ? { moveToNeedsInfo: (id: string) => setLinearState(id, needsInfoState, opts.linear) } : {}),
        ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
        ...(opts.graphql !== undefined ? { graphql: opts.graphql } : {}),
      }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runOne:
      needsInfoState === undefined
        ? (id) => runLinearIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runLinearIssue(i, opts.deps), {
              comment: (body) => commentLinearIssue(id, body, opts.linear),
              toNeedsInfo: () => setLinearState(id, needsInfoState, opts.linear),
            }, opts.deps.feedbackAuthors),
    review: (id) => setLinearState(id, opts.reviewState, opts.linear),
    onNoChange: (id) =>
      commentAndRevert(
        commentLinearIssue(id, NO_CHANGE_MSG, opts.linear),
        opts.triggerStateName !== undefined ? setLinearState(id, opts.triggerStateName, opts.linear) : undefined,
      ),
    // Linear has no blocked state and reverting to the trigger state would re-list the issue next
    // poll, so the hold keeps the claimed state; the comment names the exact state to move back to.
    // Holding is only safe while `claimedState` (a state NAME) does not resolve to the `triggerState`
    // TYPE that listReady filters on — the same assumption the claim itself and onFailure rest on.
    onSecretBlocked: (id) =>
      commentLinearIssue(
        id,
        holdMessage(
          `It stays in "${opts.claimedState}" so the watch will not re-run it.`,
          `move it back to ${opts.triggerStateName !== undefined ? `"${opts.triggerStateName}"` : 'its trigger state'}`,
        ),
        opts.linear,
      ),
    onFailure: (id, error) => commentLinearIssue(id, failureOrCapComment('Taskcell run failed', error), opts.linear),
  };
}

export interface WatchLinearSpecOptions {
  /** Deps for the spec generator (no PR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  label: string;
  /** Linear state TYPE to poll for spec-ready issues (e.g. 'triage'). */
  specTriggerState?: string;
  /**
   * The display NAME of the same state as `specTriggerState` (which is a TYPE). Needed because
   * `issue update --state` takes a state NAME, not a type — this is the name the issue is reverted to
   * on failure so a later poll re-picks it. E.g. specTriggerState: 'triage', specTriggerStateName: 'Spec'.
   */
  specTriggerStateName: string;
  /** State NAME to move an issue to on claim, e.g. 'Speccing'. */
  claimedState: string;
  /** State NAME after a spec is generated — the agent-pass trigger, e.g. 'Todo'. */
  agentState: string;
  /** State NAME when triage flags the ticket as too vague, e.g. 'Needs Info'. */
  needsInfoState: string;
  team?: string;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * Linear SPEC primitives: poll a state+label trigger, triage each issue, then either generate+post a
 * tech spec and advance the issue to the agent state, or request clarification and move it to
 * needs-info. On failure the issue is reverted to its spec-trigger state so a later poll retries it.
 */
export function linearSpecPrimitives(opts: WatchLinearSpecOptions): SpecWatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
    ...(opts.graphql !== undefined ? { graphql: opts.graphql } : {}),
  });
  const trigger = opts.specTriggerState ?? 'triage';
  const generate = opts.generateSpec ?? runSpecGenerator;
  return {
    listReady: () =>
      listLinearReady({
        label: opts.label,
        state: trigger,
        ...(opts.team !== undefined ? { team: opts.team } : {}),
        moveToNeedsInfo: (id) => setLinearState(id, opts.needsInfoState, opts.linear),
        ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
        ...(opts.graphql !== undefined ? { graphql: opts.graphql } : {}),
      }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentLinearIssue(id, body, opts.linear),
        advance: () => setLinearState(id, opts.agentState, opts.linear),
        toNeedsInfo: () => setLinearState(id, opts.needsInfoState, opts.linear),
      });
    },
    onFailure: async (id, error) => {
      await commentLinearIssue(id, failureOrCapComment('Taskcell spec failed', error), opts.linear);
      await setLinearState(id, opts.specTriggerStateName, opts.linear);
    },
  };
}
