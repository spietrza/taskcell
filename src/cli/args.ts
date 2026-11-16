import { join, resolve } from 'node:path';
import { poolOf } from '../core/model-pool.js';
import { parseArgs } from 'node:util';
import { STREAMS } from '../core/audit.js';
import { isProviderName, validateProviderChoice, PROVIDER_NAMES } from '../agents/registry.js';
import type { ProviderName } from '../agents/registry.js';
import type { RunOptions } from '../runners/source-adapter.js';
import type { LessonsCommand } from './lessons.js';
import { assertSafeBaseBranch } from '../core/base-branch.js';
import { parseUsageCap } from '../core/usage-cap.js';
import { namedSkillsProblem, normalizeSkillNames } from '../context/named-skills.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import { readEnv } from '../core/env.js';
import { parseSince } from '../core/skill-stats.js';
import { KNOWN_OPTIONS, GLOBAL_OPTION_TYPES, findCommand } from './commands.js';
import type { CommandDecl } from './commands.js';

type WatchSource = 'linear' | 'github' | 'project' | 'gitlab';

/** A parsed command; `usageCapPct` is the validated `--usage-cap` value, applied to the environment by the CLI entry (parseCli stays pure). */
export type Command = CommandKind & { usageCapPct?: string };

type CommandKind =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean; abandoned: boolean }
  | { kind: 'migrate-labels'; repoSlug: string; apply: boolean }
  | { kind: 'resume-rate-limited'; repoSlug: string; dryRun: boolean; triggerLabels?: string[]; startedLabels?: string[] }
  | {
      kind: 'review-pr';
      prRef: string;
      repoSlug?: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
      /** Write the review to this local file instead of posting a PR comment (no trace on the tracker). */
      out?: string;
      /** Review even if this head already has a factory review (set by watch-prs, which dedupes its own sweep). */
      force?: boolean;
      /** Logins trusted beyond OWNER/MEMBER/COLLABORATOR as authors of the issue the PR implements (set by watch-prs). */
      feedbackAuthors?: string[];
    }
  | {
      kind: 'research';
      /** GitHub issue ref: owner/repo#n, or a bare number with --github-repo. */
      issueRef: string;
      repoSlug?: string;
      repoPath: string;
      egress: boolean;
      llmProxy?: boolean;
      /** Declare that web egress is available; the prompt/comment will reflect web-research mode. */
      webAccess?: boolean;
      provider?: ProviderName;
      researchModel?: string;
      /** White-label the research comment (drop "Taskcell" heading/marker). Presence toggles it; the author value is unused (no commit). */
      commitAuthor?: { name: string; email: string };
    }
  | {
      kind: 'spec';
      /** GitHub issue ref: owner/repo#n, or a bare number with --github-repo. */
      issueRef: string;
      repoSlug?: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      /** Model for the tech-spec stage (e.g. a planner-tier model). */
      specModel?: string;
      /** Override the tech-spec stage turn cap (default: techSpecStage's own default). Backs --max-turns. */
      maxTurns?: number;
      /** Branch the spec worktree is cut from — the "baseline" Fable researches against (default: main). */
      baseBranch?: string;
      /** Write the spec to this local file instead of posting an issue comment (no trace on the tracker; pairs with `run --spec-file`). */
      out?: string;
      /** White-label the spec comment (drop the "Taskcell" heading). Presence toggles it; the author value is unused (no commit). */
      commitAuthor?: { name: string; email: string };
    }
  | {
      kind: 'revise-pr';
      feedbackAuthors?: string[];
      prRef: string;
      repoSlug?: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      /**
       * When set, every stage on the primary provider retries once on this provider after an
       * AgentError (outage, usage limit, revoked credential, rate limit) — same contract as `run`/`watch`.
       */
      fallbackProvider?: ProviderName;
      /** Model for every stage that fell back (default: that provider's default). */
      fallbackModel?: string;
      /** Model for the implementer/simplifier stages, as in `run`/`watch`. Overridden by a `taskcell:model=<m>` label on the issue the PR references. */
      providerModel?: string;
      reviewModel?: string;
      maxRounds?: number;
      /** Git author for the revision commits + white-label the revision marker (client repos carry no automation branding). */
      commitAuthor?: { name: string; email: string };
      /** Dry-run: write the diff + proposed thread replies to this local file and push/comment nothing. */
      out?: string;
    }
  | {
      kind: 'watch-prs';
      repoSlug: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      /** Only review PRs opened by this GitHub login (self-review-only when set). */
      author?: string;
      /** Review this PR even when the label-filtered scan misses it (from --pr or the CI label event). */
      pr?: number;
      /** With a pinned PR (--pr or the CI label event), review only it: no label scan of other PRs. */
      pinnedOnly?: boolean;
      /** PR-author logins trusted beyond OWNER/MEMBER/COLLABORATOR (pass the workflow's allowed-actors here). */
      feedbackAuthors?: string[];
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
    }
  | {
      kind: 'doctor-prs';
      repoSlug: string;
      repoPath: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      provider?: ProviderName;
      llmProxy?: boolean;
    }
  | ({
      kind: 'doctor';
      /** Repair what the checks can repair (today: refresh the sandbox image's claude CLI). */
      fix?: boolean;
      source: 'linear' | 'github' | 'project' | 'gitlab';
      label?: string;
      projectNumber?: number;
      /** GitLab project path (e.g. group/project); required when source === 'gitlab'. */
      project?: string;
      team?: string;
      triggerState?: string;
      triggerStateName?: string;
      claimedState?: string;
      reviewState?: string;
      repoSlug?: string;
      repoPath: string;
      /** Cap on ready tasks per poll; parsed with watch's flags, read by nothing doctor runs. */
      maxTasks?: number;
      /** Single-issue selector; parsed with watch's flags, read by nothing doctor runs. */
      issue?: string;
      specModel?: string;
      specLabel?: string;
      agentLabel?: string;
      needsInfoLabel?: string;
      specClaimedLabel?: string;
      specState?: string;
      specStateName?: string;
      agentState?: string;
      needsInfoState?: string;
      specClaimedState?: string;
      specOnly?: boolean;
      llmProxy?: boolean;
    } & Omit<SharedRunOptions, StageOnlyKey>)
  | ({
      kind: 'run';
      source: 'linear' | 'github' | 'project' | 'gitlab';
      id: string;
      parent: boolean;
      gcBefore: boolean;
      egress: boolean;
      /** Hold the provider credential (Anthropic, or z.ai with --provider zai) in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      reuse?: boolean;
      repoPath: string;
      concurrency: number;
      repoSlug?: string;
      label?: string;
      /** GitLab project path (e.g. group/project); optional for --source gitlab (falls back to git remote auto-detect). */
      project?: string;
      /** Run the implementer stage as N variants via forkAndSelect, keeping the best-scored diff. */
      forkN?: number;
    } & RunOptions)
  | ({
      kind: 'watch';
      source: 'linear' | 'github' | 'project' | 'gitlab';
      /** Required for linear/github; optional for project (label-filter on the board). */
      label?: string;
      /** Project number; required when source === 'project'. */
      projectNumber?: number;
      /** GitLab project path (e.g. group/project); required when source === 'gitlab'. */
      project?: string;
      team?: string;
      triggerState?: string;
      triggerStateName?: string;
      claimedState?: string;
      reviewState?: string;
      repoSlug?: string;
      repoPath: string;
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      /** Cap the number of ready tasks claimed and processed per poll. Unset: process all of them. */
      maxTasks?: number;
      /**
       * Run only this GitHub issue (owner/repo#n matching --github-repo, or a bare number) instead
       * of sweeping every ready issue — same gates as the sweep (open state, labels, author trust,
       * triage). An issue another run already claimed (carries the claimed label) is skipped with a
       * log line; that check is best effort, the claim's label swap is what settles a race. Implies
       * --once. --source github only.
       */
      issue?: string;
      /** Hold the provider credential (Anthropic, or z.ai with --provider zai) in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      // --- Loop v1 flags ---
      /** (loop-v1) Cheap model for the spec-generation stage. */
      specModel?: string;
      // GitHub loop-v1
      /** (github loop-v1) Label that triggers the spec pass (issues with this label are specced). */
      specLabel?: string;
      /** (github loop-v1) Label the agent pass triggers on (set after spec is generated). */
      agentLabel?: string;
      /** (github loop-v1) Label set when a ticket is too vague (e.g. 'needs info'). */
      needsInfoLabel?: string;
      /**
       * (github loop-v1) Label the spec pass moves a claimed ticket to while speccing
       * (default: 'taskcell:speccing'). Omitted when absent — the default is used.
       */
      specClaimedLabel?: string;
      // Linear loop-v1
      /** (linear loop-v1) State TYPE that triggers the spec pass (e.g. 'triage'). */
      specState?: string;
      /**
       * (linear loop-v1) Display NAME of the spec-trigger state — used to revert the issue on
       * spec-pass failure so the next poll re-picks it (e.g. 'Spec'). Required alongside --spec-state.
       */
      specStateName?: string;
      /** (linear loop-v1) State NAME the spec pass advances to (agent-pass trigger, e.g. 'Todo'). */
      agentState?: string;
      /** (linear loop-v1) State NAME for vague tickets that need more info (e.g. 'Needs Info'). */
      needsInfoState?: string;
      /**
       * (linear loop-v1) State NAME the spec pass moves a claimed ticket to while speccing
       * (default: 'Speccing'). Omitted when absent — the default is used.
       */
      specClaimedState?: string;
      /** (loop-v1) Run only the spec pass each tick; the agent pass is skipped (no list, claim or run). */
      specOnly?: boolean;
      // customProviders stays: dispatch loads the repo customs onto the command (watch.ts); only RunOnlyKey is excluded.
    } & Omit<RunOptions, RunOnlyKey>)
  | {
      kind: 'review-mr';
      iid: number;
      project: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
    }
  | {
      kind: 'watch-mrs';
      project: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      /** Only review MRs opened by this GitLab username (self-review-only when set). */
      author?: string;
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
    }
  | {
      kind: 'doctor-mrs';
      project: string;
      repoPath: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      provider?: ProviderName;
      llmProxy?: boolean;
    }
  | {
      kind: 'stats';
      repoPath: string;
      json: boolean;
      /** Read the metrics file from this remote branch instead of the local .taskcell/runs. */
      branch?: string;
      /** Shadow approver scorecard instead of the cost/token rollup: verdict vs human outcome, per risk class. */
      approver: boolean;
      /** Per-skill usage vs outcome table (`stats --skills`); `since` (e.g. 30d) limits the window. */
      skills?: boolean;
      since?: string;
      /** Also print the label->merge lead-time rollup for every PR url recorded in metrics.jsonl that belongs to this repo (needs `gh`). */
      githubRepo?: string;
      /** Extra logins whose review verdicts count for the first-pass rate, beyond OWNER/MEMBER/COLLABORATOR and Taskcell's bot. */
      feedbackAuthors?: string[];
    }
  | { kind: 'metrics'; action: 'push'; repoPath: string; branch?: string }
  | { kind: 'approve'; prNumber: number; repoSlug: string; repoPath: string; mode: 'shadow' | 'act'; json: boolean; dryRun: boolean; branch?: string }
  | { kind: 'memory'; repoPath: string; limit?: number; json: boolean }
  | { kind: 'history'; repoPath: string; repoSlug: string; issue: number; json: boolean; configDir?: string; branch?: string; offline: boolean }
  | {
      kind: 'audit';
      action: 'verify' | 'export';
      repoPath: string;
      /** One stream (hub, run-events, metrics, decisions, lessons); omitted = every stream. */
      stream?: string;
      /** The hub's config dir (holds the hub audit log); default: the hub's own default. */
      configDir?: string;
      branch?: string;
      since?: string;
      until?: string;
      format: 'jsonl' | 'csv';
    }
  | { kind: 'skills'; action: 'list' | 'check'; dir: string; strict: boolean }
  | { kind: 'skills'; action: 'add'; dir: string; source: string; ref?: string; path?: string; name?: string }
  | { kind: 'skills'; action: 'remove'; dir: string; name: string }
  | { kind: 'skills'; action: 'update'; dir: string; repo: string; name?: string; baseBranch?: string; dryRun: boolean; pr: boolean; force: boolean }
  | LessonsCommand
  | {
      kind: 'eval';
      json: boolean;
      judgeModel?: string;
      produceModel?: string;
      /** Draft eval-corpus candidates from retrospective memory instead of running the corpus (suggest-only). */
      suggest: boolean;
      repoPath: string;
      limit?: number;
      /** Also write the drafted candidates to this scratch path (refused if under src/evals/corpus/). */
      out?: string;
      /** With --suggest: also draft candidates from GitHub (closed-unmerged / needs-human-review PRs, reverts). */
      githubRepo?: string;
      /** With --suggest: only consider entries/PRs/commits at or after this ISO date. */
      since?: string;
      /** With --suggest: force markdown output (default is already markdown unless --json; explicit for scripting). */
      markdown?: boolean;
      /** Gate against a saved baseline: a local file path, or "main" for the latest one on the metrics branch. */
      baseline?: string;
      /** Max tolerated drop in overall pass rate, in points (default 5). Only meaningful with --baseline. */
      maxDrop?: number;
      /** Compare against a baseline whose corpus hash differs, instead of refusing. */
      allowCorpusChange?: boolean;
      /** Push this run's report to the metrics branch, keyed by the current commit. */
      saveBaseline?: boolean;
      /** Metrics-branch override for --baseline main / --save-baseline (default: taskcell-metrics). */
      branch?: string;
    }
  | { kind: 'sidecar' }
  | { kind: 'complete' }
  | { kind: 'hub'; repoPath: string; host: string; port: number; uiDir?: string; open: boolean; allowedHosts?: string[]; tokenFile?: string; adminGithubLogins?: string[]; demo?: boolean }
  | { kind: 'hub-rotate-token'; tokenFile: string }
  /** Print help: one command's usage when `command` is set (`taskcell <command> --help`), else the full text. */
  | { kind: 'help'; command?: string }
  | { kind: 'error'; message: string };

/** The repo-configured provider-name grammar (S6, mirrors custom.ts) — every built-in matches too. */
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** `--fork-scorer` value: undefined when absent, null when unrecognised. */
function parseForkScorer(raw: unknown): 'llm' | 'decision' | undefined | null {
  if (raw === undefined) return undefined;
  return raw === 'llm' || raw === 'decision' ? raw : null;
}

/**
 * RunOptions keys only `run` sets: one spec file describes one task, and fork variants need one
 * implementer stage. watch processes every ready ticket per poll and never forks, so it rejects them.
 */
type RunOnlyKey = 'forkScorer' | 'specFile' | 'namedSkills';

/**
 * The RunOptions run and watch read off the same flags. `customProviders` is loaded from the target
 * repo at dispatch (provider-choice.ts), never parsed.
 */
export type SharedRunOptions = Omit<RunOptions, RunOnlyKey | 'customProviders'>;

/** Shared keys only a running stage reads: doctor's preflight never runs one, so they stay off its command. */
type StageOnlyKey = 'visualProofCmd' | 'conformance' | 'conformanceModel';

/**
 * Every key of T, present or not — so a RunOptions field added without a line in parseRunOptions
 * is a type error, not a flag one subcommand silently drops. `keyof Required<T>` makes the keys
 * required without a `-?` modifier, which would also strip `undefined` from the value type wherever
 * `exactOptionalPropertyTypes` is off — apps/desktop's tsconfig, which type-checks this file through
 * the hub — and every value here is allowed to be undefined.
 */
export type Exhaustive<T> = { readonly [K in keyof Required<T>]: T[K] | undefined };

/** Drop the undefined entries: an absent flag leaves no key on the command (callers test with `in`). */
function present<T extends object>(exhaustive: Exhaustive<T>): T {
  return Object.fromEntries(Object.entries(exhaustive).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Shared flags other commands validate too (provider gates, --commit-author, --flow/--plan, the
 * turn caps): parseCli checks them once, before any subcommand branch, and hands the results in.
 */
type CheckedRunFlags = Exhaustive<
  Pick<SharedRunOptions, 'provider' | 'reviewProvider' | 'fallbackProvider' | 'fallbackModel' | 'commitAuthor' | 'flow' | 'maxTurns' | 'maxRepairIterations'>
>;

/** `--skill a --skill b` (repeatable) -> ['a','b']; none -> undefined, not []. */
function parseNamedSkills(value: string | boolean | (string | boolean)[] | undefined): string[] | undefined {
  const names = normalizeSkillNames((Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string'));
  return names.length > 0 ? names : undefined;
}

/** `--feedback-authors a, b ,A` -> ['a','b']; an empty or separator-only value -> undefined, not []. */
function parseFeedbackAuthors(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const seen = new Set<string>();
  const authors = value.split(',').map((a) => a.trim()).filter((a) => {
    if (!a || seen.has(a.toLowerCase())) return false;
    seen.add(a.toLowerCase());
    return true;
  });
  return authors.length > 0 ? authors : undefined;
}

/** The one CLI → RunOptions mapping, used by run and watch so the two cannot drift. */
function parseRunOptions(values: Record<string, string | boolean | undefined>, checked: CheckedRunFlags): SharedRunOptions {
  return present<SharedRunOptions>({
    feedbackAuthors: parseFeedbackAuthors(values['feedback-authors']),
    provider: checked.provider,
    reviewProvider: checked.reviewProvider,
    fallbackProvider: checked.fallbackProvider,
    fallbackModel: checked.fallbackModel,
    providerModel: typeof values['provider-model'] === 'string' ? values['provider-model'] : undefined,
    reviewModel: typeof values['review-model'] === 'string' ? values['review-model'] : undefined,
    escalateModel: typeof values['escalate-model'] === 'string' ? values['escalate-model'] : undefined,
    noSimplify: values['no-simplify'] === true ? true : undefined,
    verifyCmd: typeof values.verify === 'string' ? values.verify : undefined,
    visualProofCmd: typeof values['visual-proof'] === 'string' ? values['visual-proof'] : undefined,
    conformance: values.conformance === true ? true : undefined,
    conformanceModel: typeof values['conformance-model'] === 'string' ? values['conformance-model'] : undefined,
    commitAuthor: checked.commitAuthor,
    plan: values.plan === true ? true : undefined,
    flow: checked.flow,
    baseBranch: typeof values.base === 'string' ? values.base : undefined,
    maxTurns: checked.maxTurns,
    maxRepairIterations: checked.maxRepairIterations,
    skillsDir: typeof values.skills === 'string' ? values.skills : undefined,
    pnpmStore: values['pnpm-store'] === true ? true : undefined,
  });
}

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 6;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LOOP_V1_OWNERSHIP_LABEL = 'vanguard';
export const DEFAULT_GITHUB_SPEC_LABEL = 'ready for spec';
export const DEFAULT_GITHUB_AGENT_LABEL = 'ready for agent';
export const DEFAULT_GITHUB_NEEDS_INFO_LABEL = 'needs info';
const DEFAULT_LINEAR_SPEC_STATE = 'triage';
const DEFAULT_LINEAR_SPEC_STATE_NAME = 'Spec';
const DEFAULT_LINEAR_NEEDS_INFO_STATE = 'Needs Info';
/** State NAME the Linear spec pass advances to when --agent-state is absent. */
export const DEFAULT_LINEAR_AGENT_STATE = 'Todo';
/** First-attempt turn cap of a review-pr or review-mr run without --max-turns; the retry gets 1.5x. */
export const DEFAULT_REVIEW_MAX_TURNS = 30; // Opus 5.5 hit 16 (then 24 on retry) on large PRs with no verdict (#1136, #1154)
const DEFAULT_PR_REVIEWING_LABEL = 'taskcell:reviewing';
const DEFAULT_PR_REVIEWED_LABEL = 'taskcell:reviewed';
const DEFAULT_GITLAB_MR_REVIEWING_LABEL = 'taskcell::reviewing';
const DEFAULT_GITLAB_MR_REVIEWED_LABEL = 'taskcell::reviewed';
/** TASKCELL_HUB_HOST default (spec §2.10) — loopback-only, so a fresh install binds nothing reachable off-box. */
const DEFAULT_HUB_HOST = '127.0.0.1';
/** TASKCELL_HUB_PORT default (spec §2.10). */
const DEFAULT_HUB_PORT = 7777;

function fail(message: string): Command {
  return { kind: 'error', message };
}

// Case and surrounding spaces are not trusted to tell two names apart; a false match only rejects the config.
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Parse a positive-integer flag (--limit, --max-turns, --max-tasks, --max-repair-iterations, ...), or undefined
 * if absent or invalid. A huge value is clamped to Number.MAX_SAFE_INTEGER, so it still means "effectively
 * unlimited" and never reaches a CLI argument as Infinity or in exponent notation.
 */
function parseLimit(raw: string | boolean | undefined): number | undefined {
  const limit = Number(raw);
  return Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), Number.MAX_SAFE_INTEGER) : undefined;
}

/** `--max-drop` value: a finite number of percentage points, or undefined when absent/malformed. */
function parseMaxDrop(raw: string | boolean | undefined): number | undefined {
  const maxDrop = Number(raw);
  return typeof raw === 'string' && Number.isFinite(maxDrop) ? maxDrop : undefined;
}

/**
 * Parse a `--commit-author` value in git's `Name <email>` form into { name, email }. Returns undefined
 * when absent. Throws (as a caught string) on a malformed value so the caller can `return fail(...)`.
 */
function parseCommitAuthor(raw: string | boolean | undefined): { name: string; email: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*(.+?)\s*<([^<>]+)>\s*$/.exec(raw);
  const name = match?.[1];
  const email = match?.[2];
  if (name === undefined || email === undefined) {
    throw `Invalid --commit-author "${raw}". Use the form: "Name <email@example.com>".`;
  }
  return { name, email };
}

/** Hidden entrypoints (__sidecar, __complete): no options besides --help, so they are not in the generated help. */
const HIDDEN_COMMAND: CommandDecl = { name: '', summary: '', options: { help: { type: 'boolean', help: '' } } };

/**
 * The command word: the first argument that is not an option or an option's value (options may precede it).
 * `--pr skills` is the one value-looking pair read the other way, as skills' boolean `--pr` before its command.
 */
function commandWord(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') return argv[i + 1];
    if (!arg.startsWith('-')) return arg;
    const flag = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : undefined;
    if (flag !== undefined && GLOBAL_OPTION_TYPES.get(flag) === 'string' && !(flag === 'pr' && argv[i + 1] === 'skills')) i++;
  }
  return undefined;
}

/**
 * Parse argv (without the node/script prefix) into a typed command. Pure: cwd is passed in so this is
 * unit-testable. Unknown options or a missing/unknown command resolve to `help`; invalid flag
 * combinations for a recognised command resolve to `error` with an actionable message.
 */
export function parseCli(argv: string[], cwd: string): Command {
  const cap: { pct?: string } = {};
  const command = parseCommand(argv, cwd, cap);
  return cap.pct === undefined || command.kind === 'error' || command.kind === 'help' ? command : { ...command, usageCapPct: cap.pct };
}

function parseCommand(argv: string[], cwd: string, cap: { pct?: string }): Command {
  const name = commandWord(argv);
  const decl = findCommand(name) ?? (name === '__sidecar' || name === '__complete' ? HIDDEN_COMMAND : undefined);
  if (decl === undefined) return { kind: 'help' };
  let values: Record<string, string | boolean | undefined>;
  let allowedHosts: string[] | undefined;
  let adminGithubLogins: string[] | undefined;
  let skills: string[] = [];
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: Object.fromEntries(Object.entries(decl.options).map(([key, o]) => [key, { type: o.type, ...(o.multiple === true ? { multiple: true } : {}) }])),
    });
    const { 'allowed-host': hosts, 'admin-github-login': admins, skill, ...singleValues } = parsed.values as Record<string, string | boolean | string[] | undefined>;
    allowedHosts = hosts as string[] | undefined;
    adminGithubLogins = admins as string[] | undefined;
    skills = parseNamedSkills(skill) ?? [];
    values = singleValues as Record<string, string | boolean | undefined>;
    positionals = parsed.positionals;
  } catch (error) {
    // A flag another command declares is refused by name; a typo or a malformed value prints help.
    const message = error instanceof Error ? error.message : '';
    const unknown = /Unknown option '--([^'=]+)/.exec(message)?.[1];
    if (unknown !== undefined && KNOWN_OPTIONS.has(unknown)) return fail(`${decl.name} does not accept --${unknown}; see \`taskcell ${decl.name} --help\`.`);
    const valued = /Option '--([^' ]+)' does not take an argument/.exec(message)?.[1];
    if (valued !== undefined) return fail(`${decl.name} --${valued} takes no value.`);
    return { kind: 'help' };
  }

  if (values.help === true) return decl === HIDDEN_COMMAND ? { kind: 'help' } : { kind: 'help', command: decl.name };
  // An option before the command that takes a value elsewhere swallows its neighbour: `--skills ./d stats`.
  if (positionals[0] !== name) return fail(`${decl.name}: "${positionals[0] ?? ''}" is not the command; put options after \`${decl.name}\`.`);

  // Hidden desktop entrypoint: a persistent stdio JSON server (not a documented subcommand). Takes no
  // flags; parsed before provider validation so it never touches the run/watch surface.
  if (positionals[0] === '__sidecar') return { kind: 'sidecar' };
  // Hidden one-shot doc-chat completion (Subsystem 3): reads one JSON request on stdin, writes one
  // JSON line. A separate process per turn so it never queues behind the run sidecar's mutex.
  if (positionals[0] === '__complete') return { kind: 'complete' };

  const repoPath = typeof values.repo === 'string' ? values.repo : cwd;

  // Declared (approve only) so it is refused by name here: help would exit 0 and a workflow still passing it would end green having decided nothing.
  if (values['review-run-id'] !== undefined) {
    return fail('--review-run-id was removed: act mode reads the run stamp on the review itself. Drop the flag.');
  }

  // Provider flags. run/watch/doctor also accept repo-configured custom provider names (S6): those
  // shapes relax to the name grammar here — this parser is synchronous and cannot read the repo's
  // app.json, so resolution (and the "which names exist" error) happens at dispatch. Every other
  // command keeps the closed built-in set, and --review-provider is built-ins-only everywhere
  // (customs never review — spec §2/§3).
  const providerRaw = typeof values.provider === 'string' ? values.provider : undefined;
  const reviewProviderRaw = typeof values['review-provider'] === 'string' ? values['review-provider'] : undefined;
  const fallbackProviderRaw = typeof values['fallback-provider'] === 'string' ? values['fallback-provider'] : undefined;
  const fallbackModel = typeof values['fallback-model'] === 'string' ? values['fallback-model'] : undefined;
  const customsAllowed = positionals[0] === 'run' || positionals[0] === 'watch' || positionals[0] === 'doctor';
  if (providerRaw !== undefined && !isProviderName(providerRaw)) {
    if (!customsAllowed || !CUSTOM_NAME_RE.test(providerRaw)) {
      return fail(`Unknown provider "${providerRaw}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
    }
  }
  if (reviewProviderRaw !== undefined && !isProviderName(reviewProviderRaw)) {
    return fail(`Unknown review-provider "${reviewProviderRaw}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  const provider: string | undefined = providerRaw;
  const fallbackNames = fallbackProviderRaw?.split(',').map((n) => n.trim()) ?? [];
  const badFallback = fallbackNames.find((n) => !isProviderName(n));
  if (badFallback !== undefined) {
    return fail(`Unknown fallback-provider "${badFallback}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  if (fallbackModel !== undefined && fallbackModel.split(',').length > Math.max(1, fallbackNames.length)) {
    return fail('--fallback-model lists more models than --fallback-provider lists providers.');
  }
  // Model pools (`provider/model:weight, …`) are checked here so a typo fails before any run starts.
  const isPoolProvider = (name: string): boolean => isProviderName(name) || (customsAllowed && CUSTOM_NAME_RE.test(name));
  for (const flag of ['provider-model', 'review-model', 'escalate-model'] as const) {
    const value = values[flag];
    if (typeof value !== 'string') continue;
    try {
      poolOf(value, isPoolProvider, `--${flag}`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (fallbackModel !== undefined && fallbackProviderRaw === undefined) {
    return fail('--fallback-model needs --fallback-provider.');
  }
  const reviewProvider: ProviderName | undefined = reviewProviderRaw;
  // A comma list (`codex,cursor`) passed the per-name gate above; the type names one provider for the single case.
  const fallbackProvider = fallbackProviderRaw as ProviderName | undefined;
  // Closed-set shapes: the gate above guarantees a built-in there; this re-narrow is for the compiler.
  const builtinProvider: ProviderName | undefined =
    provider !== undefined && isProviderName(provider) ? provider : undefined;

  // Named flow (run + watch). --flow selects a FLOWS entry or a repo `.taskcell/flows/*.hcl` flow
  // (S5); --plan stays the alias for flow 'plan'. No name check here: this parser is synchronous
  // and cannot see the repo's flow files — an unknown name fails in the async dispatch, which
  // lists built-ins + discovered repo flows.
  const flowRaw = typeof values.flow === 'string' ? values.flow : undefined;
  if (flowRaw !== undefined && values.plan === true) {
    return fail('Use either --plan or --flow <name>, not both — --plan is the alias for --flow plan.');
  }

  let commitAuthor: { name: string; email: string } | undefined;
  try {
    commitAuthor = parseCommitAuthor(values['commit-author']);
  } catch (message) {
    return fail(String(message));
  }

  // Checked once here for run, watch and spec, so a bad --base exits before any ticket is claimed.
  if (typeof values.base === 'string') {
    try {
      assertSafeBaseBranch(values.base);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  const usageCapRaw = values['usage-cap'];
  if (typeof usageCapRaw === 'string') {
    if (parseUsageCap(usageCapRaw) === undefined) return fail(`--usage-cap must be a number from 1 to 100, got "${usageCapRaw}".`);
    cap.pct = usageCapRaw;
  }

  // Opt-in overrides to let a single run finish a large task (run + watch). Positive integers only;
  // 0/negative/non-numeric are rejected at parse (no override set), same semantics as parseLimit.
  const maxTurns = parseLimit(values['max-turns']);
  const maxRepairIterations = parseLimit(values['max-repair-iterations']);

  if (positionals[0] === 'stats') {
    const statsRepo = values['github-repo'];
    // The slug lands in a `gh api repos/<slug>/...` path, so `..` segments or extra slashes are refused.
    if (typeof statsRepo === 'string' && (!/^[\w.-]+\/[\w.-]+$/.test(statsRepo) || statsRepo.split('/').some((p) => p === '.' || p === '..'))) {
      return fail(`stats --github-repo must be owner/repo, got '${statsRepo}'.`);
    }
    const statsFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    if (values.skills === true && positionals.length > 1) return fail('stats --skills takes no value.');
    if (values.skills === true && (values.approver === true || statsRepo !== undefined || statsFeedbackAuthors !== undefined)) {
      return fail('stats --skills cannot be combined with --approver, --github-repo or --feedback-authors.');
    }
    if (values.skills === true && typeof values.since === 'string' && parseSince(values.since) === undefined) {
      return fail(`stats --since must look like 30d or 12h, got '${values.since}'.`);
    }
    return {
      kind: 'stats',
      repoPath,
      json: values.json === true,
      approver: values.approver === true,
      ...(values.skills === true ? { skills: true } : {}),
      // Without --skills, --since is accepted and ignored, as it always was on stats.
      ...(values.skills === true && typeof values.since === 'string' ? { since: values.since } : {}),
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
      ...(typeof values['github-repo'] === 'string' ? { githubRepo: values['github-repo'] } : {}),
      ...(statsFeedbackAuthors !== undefined ? { feedbackAuthors: statsFeedbackAuthors } : {}),
    };
  }

  if (positionals[0] === 'approve') {
    const prRaw = typeof values.pr === 'string' ? values.pr : positionals[1];
    const prNumber = prRaw !== undefined ? Number(prRaw) : NaN;
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    if (repoSlug === undefined) return fail('approve requires --github-repo <owner/repo>.');
    if (!Number.isInteger(prNumber) || prNumber < 1) return fail(`approve requires a positive --pr <n>, got "${String(prRaw)}".`);
    const modeRaw = typeof values.mode === 'string' ? values.mode : 'shadow';
    if (modeRaw !== 'shadow' && modeRaw !== 'act') return fail(`approve: unknown --mode "${modeRaw}" (shadow or act).`);
    return {
      kind: 'approve',
      prNumber,
      repoSlug,
      repoPath,
      mode: modeRaw,
      json: values.json === true,
      dryRun: values['dry-run'] === true,
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    };
  }

  if (positionals[0] === 'metrics') {
    if (positionals[1] !== 'push') return fail('metrics expects a subcommand: taskcell metrics push [--repo <path>] [--branch <name>].');
    return { kind: 'metrics', action: 'push', repoPath, ...(typeof values.branch === 'string' ? { branch: values.branch } : {}) };
  }

  if (positionals[0] === 'lessons') {
    const branch = typeof values.branch === 'string' ? { branch: values.branch } : {};
    const action = positionals[1];
    if (action === 'list') return { kind: 'lessons', action, repoPath, json: values.json === true, ...branch };
    if (action === 'dismiss') {
      const id = positionals[2];
      if (id === undefined || !/^[0-9a-f]{12}$/.test(id)) return fail('lessons dismiss expects a lesson id (12 hex chars, see `taskcell lessons list`).');
      return { kind: 'lessons', action, repoPath, id, ...branch };
    }
    if (action === 'record') {
      const gitlabProject = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
      const numFlagName = gitlabProject !== undefined ? 'mr' : 'pr';
      const numFlag = values[numFlagName];
      const prRaw = typeof numFlag === 'string' ? numFlag : positionals[2];
      const prNumber = prRaw !== undefined ? Number(prRaw) : NaN;
      const repoSlug = gitlabProject ?? (typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined);
      if (repoSlug === undefined) return fail('lessons record requires --github-repo <owner/repo> or --gitlab-project <group/project>.');
      if (!Number.isInteger(prNumber) || prNumber < 1) {
        return fail(`lessons record requires a positive --${numFlagName} <n>, got "${String(prRaw)}".`);
      }
      const feedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
      return {
        kind: 'lessons',
        action,
        repoPath,
        repoSlug,
        prNumber,
        ...(gitlabProject !== undefined ? { gitlab: true as const } : {}),
        dryRun: values['dry-run'] === true,
        ...(typeof values['provider-model'] === 'string' ? { model: values['provider-model'] } : {}),
        ...(feedbackAuthors !== undefined ? { feedbackAuthors } : {}),
        ...branch,
      };
    }
    return fail('lessons expects a subcommand: record --pr <n> --github-repo <o/r> (or --mr <n> --gitlab-project <g/p>) | list | dismiss <id>.');
  }

  if (positionals[0] === 'skills') {
    const action = positionals[1];
    const usage =
      'skills expects a subcommand: taskcell skills list|check [--dir <skills dir>] [--strict] | add <git-url>[#ref] [--path <dir>] [--name <name>] [--dir <skills dir>] | remove <name> [--dir <skills dir>] | update [name] [--dir <skills dir>] [--dry-run] [--pr [--base <branch>]] [--force].';
    // add, remove and update write, and --pr needs the directory inside the repo: a relative --dir is
    // under --repo. list and check keep reading it as given.
    const writes = action === 'add' || action === 'remove' || action === 'update';
    const dir = typeof values.dir === 'string' ? (writes ? resolve(repoPath, values.dir) : values.dir) : join(repoPath, 'skills');
    if (action !== 'list' && action !== 'check' && action !== 'add' && action !== 'remove' && action !== 'update') return fail(usage);
    if (values.pr === true && action !== 'update') return fail('--pr is only supported with skills update.');
    if (values['dry-run'] === true && action !== 'update') return fail('--dry-run is only supported with skills update.');
    if (values.strict === true && action !== 'check') return fail('--strict only applies to skills check.');
    if ((values.path !== undefined || values.name !== undefined) && action !== 'add') return fail('--path and --name only apply to skills add.');
    if (values.force === true && action !== 'update') return fail('--force only applies to skills update.');
    if (values.base !== undefined && !(action === 'update' && values.pr === true)) return fail('--base only applies to skills update --pr.');
    if (action === 'list' || action === 'check') {
      return { kind: 'skills', action, dir, strict: values.strict === true };
    }
    if (action === 'add') {
      const target = positionals[2];
      if (target === undefined || positionals.length > 3) return fail('skills add expects one argument: <git-url>[#ref].');
      const hash = target.indexOf('#');
      const ref = hash === -1 ? '' : target.slice(hash + 1);
      if (hash !== -1 && ref === '') return fail('skills add: empty #ref.');
      return {
        kind: 'skills',
        action,
        dir,
        source: hash === -1 ? target : target.slice(0, hash),
        ...(ref !== '' ? { ref } : {}),
        ...(typeof values.path === 'string' ? { path: values.path } : {}),
        ...(typeof values.name === 'string' ? { name: values.name } : {}),
      };
    }
    if (action === 'remove') {
      const name = positionals[2];
      if (name === undefined || positionals.length > 3) return fail('skills remove expects one argument: <name>.');
      return { kind: 'skills', action, dir, name };
    }
    if (positionals.length > 3) return fail('skills update expects at most one argument: [name].');
    const name = positionals[2];
    return { kind: 'skills', action, dir, repo: repoPath, ...(name !== undefined ? { name } : {}), ...(typeof values.base === 'string' ? { baseBranch: values.base } : {}), dryRun: values['dry-run'] === true, pr: values.pr === true, force: values.force === true };
  }

  if (positionals[0] === 'audit') {
    const action = positionals[1];
    if (action !== 'verify' && action !== 'export') return fail('audit expects a subcommand: taskcell audit verify [--stream <name>] | taskcell audit export [--stream <name>] [--since <date>] [--until <date>] [--format jsonl|csv].');
    if (typeof values.stream === 'string' && !Object.keys(STREAMS).includes(values.stream)) return fail(`audit --stream must be one of ${Object.keys(STREAMS).join(', ')}, got '${values.stream}'.`);
    const format = typeof values.format === 'string' ? values.format : 'jsonl';
    if (format !== 'jsonl' && format !== 'csv') return fail(`audit --format must be jsonl or csv, got '${format}'.`);
    for (const key of ['since', 'until'] as const) {
      const v = values[key];
      if (typeof v === 'string' && Number.isNaN(Date.parse(v))) return fail(`audit --${key} must be a date, got '${v}'.`);
    }
    return {
      kind: 'audit',
      action,
      repoPath,
      format,
      ...(typeof values.stream === 'string' ? { stream: values.stream } : {}),
      ...(typeof values['config-dir'] === 'string' ? { configDir: values['config-dir'] } : {}),
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
      ...(typeof values.since === 'string' ? { since: values.since } : {}),
      ...(typeof values.until === 'string' ? { until: values.until } : {}),
    };
  }

  if (positionals[0] === 'history') {
    const groups = /^(?<repo>[^\s#/]+\/[^\s#/]+)#(?<number>\d+)$/.exec(positionals[1] ?? '')?.groups;
    if (groups === undefined || Number(groups['number']) < 1) return fail('history expects an issue reference: taskcell history owner/repo#N [--json].');
    return {
      kind: 'history',
      repoPath,
      repoSlug: groups['repo']!,
      issue: Number(groups['number']),
      json: values.json === true,
      offline: values.offline === true,
      ...(typeof values['config-dir'] === 'string' ? { configDir: values['config-dir'] } : {}),
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    };
  }

  if (positionals[0] === 'memory') {
    const limit = parseLimit(values.limit);
    return {
      kind: 'memory',
      repoPath,
      ...(limit !== undefined ? { limit } : {}),
      json: values.json === true,
    };
  }

  if (positionals[0] === 'eval') {
    const limit = parseLimit(values.limit);
    const maxDrop = parseMaxDrop(values['max-drop']);
    return {
      kind: 'eval',
      json: values.json === true,
      ...(typeof values['judge-model'] === 'string' ? { judgeModel: values['judge-model'] } : {}),
      ...(typeof values['produce-model'] === 'string' ? { produceModel: values['produce-model'] } : {}),
      suggest: values.suggest === true,
      repoPath,
      ...(limit !== undefined ? { limit } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
      ...(typeof values['github-repo'] === 'string' ? { githubRepo: values['github-repo'] } : {}),
      ...(typeof values.since === 'string' ? { since: values.since } : {}),
      ...(values.markdown === true ? { markdown: true } : {}),
      ...(typeof values.baseline === 'string' ? { baseline: values.baseline } : {}),
      ...(maxDrop !== undefined ? { maxDrop } : {}),
      allowCorpusChange: values['allow-corpus-change'] === true,
      saveBaseline: values['save-baseline'] === true,
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    };
  }

  if (positionals[0] === 'migrate-labels') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    if (repoSlug === undefined) return fail('migrate-labels requires --github-repo <owner/repo>.');
    return { kind: 'migrate-labels', repoSlug, apply: values.apply === true };
  }

  if (positionals[0] === 'resume-rate-limited') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    if (repoSlug === undefined) return fail('resume-rate-limited requires --github-repo <owner/repo>.');
    const raw = values['trigger-labels'];
    const triggerLabels = typeof raw === 'string' ? raw.split(',').map((l) => l.trim()).filter((l) => l !== '') : [];
    // A waiting issue carrying one of these already started; custom names must match the watch's.
    const started = [
      [values['claimed-state'], GITHUB_CLAIMED_LABEL],
      [values['review-state'], GITHUB_REVIEW_LABEL],
      [values['spec-claimed-label'], GITHUB_SPEC_CLAIMED_LABEL],
    ] as const;
    const startedLabels = started.some(([v]) => typeof v === 'string')
      ? started.map(([v, fallback]) => (typeof v === 'string' ? v : fallback))
      : undefined;
    return {
      kind: 'resume-rate-limited',
      repoSlug,
      dryRun: values['dry-run'] === true,
      ...(triggerLabels.length > 0 ? { triggerLabels } : {}),
      ...(startedLabels !== undefined ? { startedLabels } : {}),
    };
  }

  if (positionals[0] === 'gc') {
    const hours = Number(values['max-age-hours']);
    const maxAgeMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MAX_AGE_HOURS) * HOUR_MS;
    return {
      kind: 'gc',
      repoPath,
      maxAgeMs,
      dryRun: values['dry-run'] === true,
      abandoned: values.abandoned === true,
      ...(typeof values.remote === 'string' ? { remoteRepo: values.remote } : {}),
    };
  }

  if (positionals[0] === 'hub') {
    const hostRaw = typeof values.host === 'string' ? values.host : readEnv('TASKCELL_HUB_HOST');
    const host = hostRaw !== undefined && hostRaw.trim() !== '' ? hostRaw : DEFAULT_HUB_HOST;

    const portRaw = typeof values.port === 'string' ? values.port : undefined;
    let port: number;
    if (portRaw !== undefined) {
      const parsed = Number(portRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return fail(`--port expects an integer between 1 and 65535, got "${portRaw}".`);
      }
      port = parsed;
    } else {
      const envPort = Number(readEnv('TASKCELL_HUB_PORT'));
      port = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : DEFAULT_HUB_PORT;
    }

    const tokenFileRaw = typeof values['token-file'] === 'string' ? values['token-file'] : readEnv('TASKCELL_HUB_TOKEN_FILE');
    const tokenFile = tokenFileRaw !== undefined && tokenFileRaw.trim() !== '' ? tokenFileRaw : undefined;
    if (positionals[1] === 'rotate-token') {
      if (tokenFile === undefined) return fail('hub rotate-token requires --token-file <path> (or TASKCELL_HUB_TOKEN_FILE).');
      return { kind: 'hub-rotate-token', tokenFile };
    }
    if (positionals[1] !== undefined) return fail(`Unknown hub subcommand '${positionals[1]}'. Expected: rotate-token.`);

    return {
      kind: 'hub',
      ...(tokenFile !== undefined ? { tokenFile } : {}),
      repoPath,
      host,
      port,
      ...(typeof values['ui-dir'] === 'string' ? { uiDir: values['ui-dir'] } : {}),
      open: values['no-open'] !== true,
      ...(values.demo === true ? { demo: true } : {}),
      ...(allowedHosts?.length ? { allowedHosts } : {}),
      ...(adminGithubLogins?.length ? { adminGithubLogins } : {}),
    };
  }

  const proxyMode = values['llm-proxy'] === true;
  // Skipped when the provider is a (possible) custom name: this call dereferences the built-in
  // table and the customs live on disk, invisible to the sync parser. The dispatch entry point
  // re-runs it with the loaded customs BEFORE any sandbox cost (run.ts/watch.ts). reviewProvider
  // cannot be non-built-in (gate above), so built-in pairs keep failing right here at parse.
  if (provider === undefined || isProviderName(provider)) {
    try {
      validateProviderChoice(
        {
          ...(provider !== undefined ? { provider } : {}),
          ...(reviewProvider !== undefined ? { reviewProvider } : {}),
          ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
        },
        { proxyMode },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (positionals[0] === 'review-pr') {
    // Accept the PR ref as a positional, --github-pr <n>, or --github <ref> — the last for parity with
    // spec/run/research, which all take --github (a natural thing to reach for).
    const prRef =
      typeof values['github-pr'] === 'string'
        ? values['github-pr']
        : typeof values.github === 'string'
        ? values.github
        : positionals[1];
    if (prRef === undefined) {
      return fail('review-pr requires a PR reference: a URL, owner/repo#number, --github <ref>, or --github-pr <number>.');
    }
    const reviewFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    return {
      kind: 'review-pr',
      ...(reviewFeedbackAuthors !== undefined ? { feedbackAuthors: reviewFeedbackAuthors } : {}),
      prRef,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
    };
  }

  if (positionals[0] === 'research') {
    const issueRef = typeof values.github === 'string' ? values.github : positionals[1];
    if (issueRef === undefined) return { kind: 'help' };
    return {
      kind: 'research',
      issueRef,
      repoPath,
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(values.web === true ? { webAccess: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['research-model'] === 'string' ? { researchModel: values['research-model'] } : {}),
      ...(commitAuthor !== undefined ? { commitAuthor } : {}),
    };
  }

  if (positionals[0] === 'spec') {
    const issueRef = typeof values.github === 'string' ? values.github : positionals[1];
    if (issueRef === undefined) return { kind: 'help' };
    return {
      kind: 'spec',
      issueRef,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(typeof values.base === 'string' ? { baseBranch: values.base } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
      ...(commitAuthor !== undefined ? { commitAuthor } : {}),
    };
  }

  if (positionals[0] === 'revise-pr') {
    const prRef =
      typeof values['github-pr'] === 'string'
        ? values['github-pr']
        : typeof values.github === 'string'
        ? values.github
        : positionals[1];
    if (prRef === undefined) return { kind: 'help' };
    const maxRounds = parseLimit(values['max-rounds']);
    const feedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    return {
      kind: 'revise-pr',
      ...(feedbackAuthors !== undefined ? { feedbackAuthors } : {}),
      prRef,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      ...(typeof values['provider-model'] === 'string' ? { providerModel: values['provider-model'] } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(commitAuthor !== undefined ? { commitAuthor } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
    };
  }

  if (positionals[0] === 'watch-prs') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (repoSlug === undefined || label === undefined) return fail('watch-prs requires --github-repo <owner/repo> and --label <name>.');
    const concurrency = Number(values.concurrency);
    const interval = Number(values.interval);
    const prNumber = typeof values.pr === 'string' ? Number(values.pr) : undefined;
    if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) {
      return fail('watch-prs --pr expects a positive PR number.');
    }
    const prFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    return {
      kind: 'watch-prs',
      ...(prFeedbackAuthors !== undefined ? { feedbackAuthors: prFeedbackAuthors } : {}),
      repoSlug,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      egress: values.egress === true,
      ...(typeof values.author === 'string' ? { author: values.author } : {}),
      ...(prNumber !== undefined ? { pr: prNumber } : {}),
      ...(values['pinned-only'] === true ? { pinnedOnly: true } : {}),
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  if (positionals[0] === 'doctor-prs') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (repoSlug === undefined || label === undefined) return fail('doctor-prs requires --github-repo <owner/repo> and --label <name>.');
    return {
      kind: 'doctor-prs',
      repoSlug,
      repoPath,
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    };
  }

  if (positionals[0] === 'review-mr') {
    const iidRaw = typeof values.mr === 'string' ? Number(values.mr) : undefined;
    const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
    if (iidRaw === undefined || !Number.isInteger(iidRaw) || project === undefined) return { kind: 'help' };
    return {
      kind: 'review-mr',
      iid: iidRaw,
      project,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  if (positionals[0] === 'watch-mrs' || positionals[0] === 'doctor-mrs') {
    const commandKind = positionals[0];
    const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (project === undefined || label === undefined) return { kind: 'help' };
    const concurrency = Number(values.concurrency);
    const interval = Number(values.interval);
    const shared = {
      project,
      repoPath,
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_GITLAB_MR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_GITLAB_MR_REVIEWED_LABEL,
      ...(typeof values.author === 'string' ? { author: values.author } : {}),
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    };
    if (commandKind === 'doctor-mrs') return { kind: 'doctor-mrs', ...shared };
    return {
      kind: 'watch-mrs',
      ...shared,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  // Shared by the two branches below; every command above returned already.
  const runOptions = parseRunOptions(values, {
    provider,
    reviewProvider,
    fallbackProvider,
    fallbackModel,
    commitAuthor,
    flow: flowRaw,
    maxTurns,
    maxRepairIterations,
  });

  if (positionals[0] === 'run') {
    const sources: Array<['linear' | 'github' | 'project' | 'gitlab', string]> = [];
    if (typeof values.linear === 'string') sources.push(['linear', values.linear]);
    if (typeof values.github === 'string') sources.push(['github', values.github]);
    if (typeof values.project === 'string') sources.push(['project', values.project]);
    if (typeof values.gitlab === 'string') sources.push(['gitlab', values.gitlab]);
    // Exactly one source is required.
    const picked = sources[0];
    if (sources.length !== 1 || picked === undefined) {
      return fail('run requires exactly one of --linear <id>, --github <ref>, --gitlab <ref>, or --project <number>.');
    }
    if (values.parent === true && picked[0] !== 'linear') {
      return fail('--parent is only supported with --linear.');
    }
    // One spec file cannot describe N different tasks — fan-out modes would inject it into every run.
    if (typeof values['spec-file'] === 'string' && (picked[0] === 'project' || values.parent === true)) {
      return fail('--spec-file is only supported for a single-issue run (not --parent / --project fan-out).');
    }
    if (skills.length > 0 && (picked[0] === 'project' || values.parent === true)) {
      return fail('--skill is only supported for a single-issue run (not --parent / --project fan-out); use a "Skills:" line in each issue.');
    }
    if (picked[0] === 'project') {
      const projectNum = Number(picked[1]);
      if (!Number.isInteger(projectNum) || projectNum < 1) {
        return fail(`--project expects a board number, got "${picked[1]}".`);
      }
    }
    const concurrency = Number(values.concurrency);
    const forkN = Number(values.fork);
    const forkScorer = parseForkScorer(values['fork-scorer']);
    if (forkScorer === null) return fail(`--fork-scorer expects llm or decision, got "${String(values['fork-scorer'])}".`);
    if (forkScorer !== undefined && !(Number.isFinite(forkN) && forkN >= 2)) return fail('--fork-scorer only applies with --fork <n> (n>=2).');
    // forkAndSelect runs every variant on the primary agent and returns before the stage fallback is
    // consulted, so the flag would be accepted and silently never fire.
    if (fallbackProvider !== undefined && Number.isFinite(forkN) && forkN >= 2) return fail('--fallback-provider does not apply to --fork variants; drop one of them.');
    // The single-task RunOptions (see RunOnlyKey): typed exhaustively so a new run-only field lands here.
    const skillProblem = namedSkillsProblem(skills);
    if (skillProblem !== undefined) return fail(`--skill ${skillProblem}.`);
    const runOnly = present<Pick<RunOptions, RunOnlyKey>>({
      forkScorer,
      specFile: typeof values['spec-file'] === 'string' ? values['spec-file'] : undefined,
      namedSkills: skills.length > 0 ? skills : undefined,
    });
    return {
      kind: 'run',
      source: picked[0],
      id: picked[1],
      parent: values.parent === true,
      gcBefore: values['gc-before'] === true,
      egress: values.egress === true,
      repoPath,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(Number.isFinite(forkN) && forkN >= 2 ? { forkN: Math.floor(forkN) } : {}),
      ...(values.reuse === true ? { reuse: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(typeof values.label === 'string' ? { label: values.label } : {}),
      ...(typeof values['gitlab-project'] === 'string' && picked[0] === 'gitlab' ? { project: values['gitlab-project'] } : {}),
      ...runOptions,
      ...runOnly,
    };
  }

  if (positionals[0] === 'watch' || positionals[0] === 'doctor') {
    const commandKind = positionals[0];
    const source: WatchSource =
      values.source === 'github' || (values.source === undefined && typeof values['github-repo'] === 'string')
        ? 'github'
        : values.source === 'project'
          ? 'project'
          : values.source === 'gitlab'
            ? 'gitlab'
            : 'linear';
    // project number is required when source === 'project'
    const projectNumber = typeof values.project === 'string' ? Number(values.project) : undefined;
    if (source === 'project' && (projectNumber === undefined || !Number.isFinite(projectNumber))) {
      return fail(`${commandKind} --source project requires --project <number>.`);
    }

    let label = typeof values.label === 'string' ? values.label : undefined;
    let specLabel = typeof values['spec-label'] === 'string' ? values['spec-label'] : undefined;
    let agentLabel = typeof values['agent-label'] === 'string' ? values['agent-label'] : undefined;
    let needsInfoLabel = typeof values['needs-info-label'] === 'string' ? values['needs-info-label'] : undefined;
    let specState = typeof values['spec-state'] === 'string' ? values['spec-state'] : undefined;
    let specStateName = typeof values['spec-state-name'] === 'string' ? values['spec-state-name'] : undefined;
    const agentState = typeof values['agent-state'] === 'string' ? values['agent-state'] : undefined;
    let needsInfoState = typeof values['needs-info-state'] === 'string' ? values['needs-info-state'] : undefined;

    const hasGithubLoopFlags =
      specLabel !== undefined ||
      agentLabel !== undefined ||
      needsInfoLabel !== undefined ||
      typeof values['spec-claimed-label'] === 'string';
    const hasLinearLoopFlags =
      specState !== undefined ||
      specStateName !== undefined ||
      agentState !== undefined ||
      needsInfoState !== undefined ||
      typeof values['spec-claimed-state'] === 'string';
    const repoOnlyGithubLoop =
      source === 'github' && label === undefined && !hasGithubLoopFlags && !hasLinearLoopFlags;
    const isLoopV1 = values['loop-v1'] === true || hasGithubLoopFlags || hasLinearLoopFlags || repoOnlyGithubLoop;

    if (isLoopV1 && (source === 'github' || source === 'gitlab') && hasLinearLoopFlags) {
      return fail('Linear loop-v1 flags (--spec-state etc.) are not compatible with --source github/gitlab.');
    }
    if (isLoopV1 && source === 'linear' && hasGithubLoopFlags) {
      return fail('GitHub loop-v1 flags (--spec-label etc.) are not compatible with --source linear.');
    }
    if (isLoopV1 && (source === 'github' || source === 'gitlab')) {
      specLabel ??= DEFAULT_GITHUB_SPEC_LABEL;
      agentLabel ??= DEFAULT_GITHUB_AGENT_LABEL;
      needsInfoLabel ??= DEFAULT_GITHUB_NEEDS_INFO_LABEL;
    } else if (isLoopV1 && source === 'linear') {
      label ??= DEFAULT_LOOP_V1_OWNERSHIP_LABEL;
      specState ??= DEFAULT_LINEAR_SPEC_STATE;
      specStateName ??= DEFAULT_LINEAR_SPEC_STATE_NAME;
      needsInfoState ??= DEFAULT_LINEAR_NEEDS_INFO_STATE;
    }

    if (isLoopV1) {
      // Loop v1 validation per source.
      if (source === 'github' || source === 'gitlab') {
        if (specLabel === undefined || agentLabel === undefined || needsInfoLabel === undefined) {
          return fail('github/gitlab loop-v1 requires --spec-label, --agent-label, and --needs-info-label.');
        }
        if (source === 'gitlab' && label === undefined) {
          return fail('gitlab loop-v1 requires --label <name>.');
        }
        if (values['spec-only'] === true && sameName(agentLabel, DEFAULT_GITHUB_AGENT_LABEL)) {
          return fail(`${commandKind} --spec-only requires --agent-label <review label> other than "${DEFAULT_GITHUB_AGENT_LABEL}"; that default is the build trigger, so specced issues would get no review window.`);
        }
        if (values['spec-only'] === true && sameName(agentLabel, specLabel)) {
          return fail(`${commandKind} --spec-only cannot advance specced issues into the spec trigger label "${specLabel}"; set --agent-label to another label, or the spec pass specs the same issues again on every poll.`);
        }
        // --label is an optional extra ownership filter in github loop-v1. A repo-scoped shorthand
        // watches the routing labels directly; explicit --label narrows that further when desired.
      } else if (source === 'linear') {
        if (specState === undefined || specStateName === undefined || needsInfoState === undefined) {
          return fail('--spec-state requires --spec-state-name and --needs-info-state (linear loop-v1).');
        }
        // --label is still the shared ownership label across both passes. Defaults keep the filter,
        // not a status-only scan over the whole Linear workspace.
        if (label === undefined) {
          return fail(`${commandKind} --source linear loop-v1 requires --label <name>.`);
        }
        if (values['spec-only'] === true && sameName(agentState ?? DEFAULT_LINEAR_AGENT_STATE, DEFAULT_LINEAR_AGENT_STATE)) {
          return fail(`${commandKind} --spec-only requires --agent-state <review state> other than "${DEFAULT_LINEAR_AGENT_STATE}"; that default is the build trigger, so specced issues would get no review window.`);
        }
        // The spec pass lists by state TYPE (--spec-state); --spec-state-name is only its revert target. This
        // name check catches the obvious case and assumes --spec-state-name is a state of the --spec-state type.
        if (values['spec-only'] === true && sameName(agentState ?? DEFAULT_LINEAR_AGENT_STATE, specStateName)) {
          return fail(`${commandKind} --spec-only cannot advance specced issues into the spec trigger state "${specStateName}"; set --agent-state to another state, or the spec pass specs the same issues again on every poll.`);
        }
      } else {
        // project source does not support loop-v1
        return fail('loop-v1 is not supported with --source project.');
      }
    } else {
      if (values['spec-only'] === true) {
        return fail(`${commandKind} --spec-only requires loop-v1, which any loop-v1 flag turns on (for example --loop-v1, --spec-state or --spec-label); single-pass watch has no spec pass.`);
      }
      // Existing single-pass validation: label is required for linear/github/gitlab; optional for project.
      if (source !== 'project' && label === undefined) {
        return fail(`${commandKind} --source ${source} requires --label <name>${commandKind === 'doctor' && source === 'linear' ? ' (or pick a source: --source github --github-repo <owner/repo>)' : ''}.`);
      }
    }

    const interval = Number(values.interval);
    const concurrency = Number(values.concurrency);
    const maxTasks = parseLimit(values['max-tasks']);
    // A blast-radius cap must not fall through to "process all" on a typo, 0 or a negative.
    if (values['max-tasks'] !== undefined && maxTasks === undefined) {
      return fail(`--max-tasks needs a positive integer, got "${String(values['max-tasks'])}".`);
    }
    const issueRef = typeof values.issue === 'string' ? values.issue : undefined;
    if (issueRef !== undefined) {
      if (source !== 'github') return fail(`${commandKind} --issue requires --source github.`);
      // Same shape check as `watch-prs --pr`, plus the repo prefix: the fetch strips an `owner/repo#`
      // prefix and reads the number from --github-repo, so a prefix naming another repo would
      // silently run a different issue.
      const groups = /^(?:(?<repo>[^\s#/]+\/[^\s#/]+)#)?(?<number>\d+)$/.exec(issueRef)?.groups;
      if (groups === undefined || Number(groups['number']) < 1) {
        return fail(`${commandKind} --issue expects a positive issue number or owner/repo#n, got "${issueRef}".`);
      }
      const refRepo = groups['repo'];
      const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
      if (refRepo !== undefined && refRepo !== repoSlug) {
        return fail(
          `${commandKind} --issue ${issueRef} names repo "${refRepo}", but --github-repo is ${repoSlug === undefined ? 'unset' : `"${repoSlug}"`}; the issue must live in the watched repo.`,
        );
      }
    }
    type WatchCommon = Omit<Extract<Command, { kind: 'watch' }>, 'kind' | 'concurrency' | 'intervalMs' | 'once' | 'egress'>;
    const common: WatchCommon = {
      source,
      repoPath,
      ...(maxTasks !== undefined ? { maxTasks } : {}),
      ...(issueRef !== undefined ? { issue: issueRef } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(typeof values['gitlab-project'] === 'string' ? { project: values['gitlab-project'] } : {}),
      ...(typeof values.team === 'string' ? { team: values.team } : {}),
      ...(typeof values['trigger-state'] === 'string' ? { triggerState: values['trigger-state'] } : {}),
      ...(typeof values['trigger-state-name'] === 'string' ? { triggerStateName: values['trigger-state-name'] } : {}),
      ...(typeof values['claimed-state'] === 'string' ? { claimedState: values['claimed-state'] } : {}),
      ...(typeof values['review-state'] === 'string' ? { reviewState: values['review-state'] } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...runOptions,
      ...(proxyMode ? { llmProxy: true } : {}),
      // Loop v1 fields (omitted when not supplied, preserving existing behaviour when absent).
      ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
      ...(specLabel !== undefined ? { specLabel } : {}),
      ...(agentLabel !== undefined ? { agentLabel } : {}),
      ...(needsInfoLabel !== undefined ? { needsInfoLabel } : {}),
      ...(typeof values['spec-claimed-label'] === 'string' ? { specClaimedLabel: values['spec-claimed-label'] } : {}),
      ...(specState !== undefined ? { specState } : {}),
      ...(specStateName !== undefined ? { specStateName } : {}),
      ...(agentState !== undefined ? { agentState } : {}),
      ...(needsInfoState !== undefined ? { needsInfoState } : {}),
      ...(typeof values['spec-claimed-state'] === 'string' ? { specClaimedState: values['spec-claimed-state'] } : {}),
      ...(values['spec-only'] === true ? { specOnly: true } : {}),
    };

    if (commandKind === 'doctor') {
      // StageOnlyKey: the proof/conformance knobs stay off the doctor command.
      const { visualProofCmd: _visualProofCmd, conformance: _conformance, conformanceModel: _conformanceModel, ...checks } = common;
      return { kind: 'doctor', ...checks, ...(values.fix === true ? { fix: true } : {}) };
    }

    return {
      kind: 'watch',
      ...common,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      // --issue names one issue: polling for it again would re-read an issue this run already
      // claimed or skipped, so it implies --once.
      once: values.once === true || issueRef !== undefined,
      egress: values.egress === true,
    };
  }

  return { kind: 'help' };
}

export { USAGE } from './commands.js';
