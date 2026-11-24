/** Shared flag groups and parsers: what several commands read off the same flags, plus the context parseCli hands each command. */
import type { RunOptions } from '../runners/source-adapter.js';
import { normalizeSkillNames } from '../context/named-skills.js';
import { REVIEWED_LABEL } from '../github-labels.js';
import type { Command } from './args.js';
import type { CommandDecl } from './commands.js';
import type { ProviderName } from '../agents/registry.js';

/** The repo-configured provider-name grammar (S6, mirrors custom.ts) — every built-in matches too. */
export const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** `--fork-scorer` value: undefined when absent, null when unrecognised. */
export function parseForkScorer(raw: unknown): 'llm' | 'decision' | undefined | null {
  if (raw === undefined) return undefined;
  return raw === 'llm' || raw === 'decision' ? raw : null;
}

/**
 * RunOptions keys only `run` sets: one spec file describes one task, and fork variants need one
 * implementer stage. watch processes every ready ticket per poll and never forks, so it rejects them.
 */
export type RunOnlyKey = 'forkScorer' | 'specFile' | 'namedSkills';

/**
 * The RunOptions run and watch read off the same flags. `customProviders` is loaded from the target
 * repo at dispatch (provider-choice.ts), never parsed.
 */
export type SharedRunOptions = Omit<RunOptions, RunOnlyKey | 'customProviders'>;

/** Shared keys only a running stage reads: doctor's preflight never runs one, so they stay off its command. */
export type StageOnlyKey = 'visualProofCmd' | 'conformance' | 'conformanceModel';

/**
 * Every key of T, present or not — so a RunOptions field added without a line in parseRunOptions
 * is a type error, not a flag one subcommand silently drops. `keyof Required<T>` makes the keys
 * required without a `-?` modifier, which would also strip `undefined` from the value type wherever
 * `exactOptionalPropertyTypes` is off — apps/desktop's tsconfig, which type-checks this file through
 * the hub — and every value here is allowed to be undefined.
 */
export type Exhaustive<T> = { readonly [K in keyof Required<T>]: T[K] | undefined };

/** Drop the undefined entries: an absent flag leaves no key on the command (callers test with `in`). */
export function present<T extends object>(exhaustive: Exhaustive<T>): T {
  return Object.fromEntries(Object.entries(exhaustive).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Shared flags other commands validate too (provider gates, --commit-author, --flow/--plan, the
 * turn caps): parseCli checks them once, before any subcommand branch, and hands the results in.
 */
export type CheckedRunFlags = Exhaustive<
  Pick<SharedRunOptions, 'provider' | 'reviewProvider' | 'fallbackProvider' | 'fallbackModel' | 'commitAuthor' | 'flow' | 'maxTurns' | 'maxRepairIterations'>
>;

/** `--skill a --skill b` (repeatable) -> ['a','b']; none -> undefined, not []. */
export function parseNamedSkills(value: string | boolean | (string | boolean)[] | undefined): string[] | undefined {
  const names = normalizeSkillNames((Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string'));
  return names.length > 0 ? names : undefined;
}

/** `--dependency-repos a/b, c/d` -> { dependencyRepos: ['a/b','c/d'] }; absent or empty -> {}. */
export function parseDependencyRepos(value: string | boolean | undefined): { dependencyRepos?: string[] } {
  const repos = typeof value === 'string' ? value.split(',').map((r) => r.trim()).filter((r) => r !== '') : [];
  return repos.length > 0 ? { dependencyRepos: repos } : {};
}

/** `--feedback-authors a, b ,A` -> ['a','b']; an empty or separator-only value -> undefined, not []. */
export function parseFeedbackAuthors(value: string | boolean | undefined): string[] | undefined {
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
export function parseRunOptions(values: Record<string, string | boolean | undefined>, checked: CheckedRunFlags): SharedRunOptions {
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

export const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_AGE_HOURS = 6;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_LOOP_V1_OWNERSHIP_LABEL = 'vanguard';
export const DEFAULT_LINEAR_SPEC_STATE = 'triage';
export const DEFAULT_LINEAR_SPEC_STATE_NAME = 'Spec';
export const DEFAULT_LINEAR_NEEDS_INFO_STATE = 'Needs Info';
/** State NAME the Linear spec pass advances to when --agent-state is absent. */
export const DEFAULT_LINEAR_AGENT_STATE = 'Todo';
/** First-attempt turn cap of a review-pr or review-mr run without --max-turns; the retry gets 1.5x. */
export const DEFAULT_REVIEW_MAX_TURNS = 30; // Opus 5.5 hit 16 (then 24 on retry) on large PRs with no verdict (#1136, #1154)
export const DEFAULT_PR_REVIEWING_LABEL = 'taskcell:reviewing';
export const DEFAULT_PR_REVIEWED_LABEL = REVIEWED_LABEL;
export const DEFAULT_GITLAB_MR_REVIEWING_LABEL = 'taskcell::reviewing';
export const DEFAULT_GITLAB_MR_REVIEWED_LABEL = 'taskcell::reviewed';
/** TASKCELL_HUB_HOST default (spec §2.10) — loopback-only, so a fresh install binds nothing reachable off-box. */
export const DEFAULT_HUB_HOST = '127.0.0.1';
/** TASKCELL_HUB_PORT default (spec §2.10). */
export const DEFAULT_HUB_PORT = 7777;

export function fail(message: string): Command {
  return { kind: 'error', message };
}

// Case and surrounding spaces are not trusted to tell two names apart; a false match only rejects the config.
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Parse a positive-integer flag (--limit, --max-turns, --max-tasks, --max-repair-iterations, ...), or undefined
 * if absent or invalid. A huge value is clamped to Number.MAX_SAFE_INTEGER, so it still means "effectively
 * unlimited" and never reaches a CLI argument as Infinity or in exponent notation.
 */
export function parseLimit(raw: string | boolean | undefined): number | undefined {
  const limit = Number(raw);
  return Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), Number.MAX_SAFE_INTEGER) : undefined;
}

/** `--max-drop` value: a finite number of percentage points, or undefined when absent/malformed. */
export function parseMaxDrop(raw: string | boolean | undefined): number | undefined {
  const maxDrop = Number(raw);
  return typeof raw === 'string' && Number.isFinite(maxDrop) ? maxDrop : undefined;
}

/**
 * Parse a `--commit-author` value in git's `Name <email>` form into { name, email }. Returns undefined
 * when absent. Throws (as a caught string) on a malformed value so the caller can `return fail(...)`.
 */
export function parseCommitAuthor(raw: string | boolean | undefined): { name: string; email: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*(.+?)\s*<([^<>]+)>\s*$/.exec(raw);
  const name = match?.[1];
  const email = match?.[2];
  if (name === undefined || email === undefined) {
    throw `Invalid --commit-author "${raw}". Use the form: "Name <email@example.com>".`;
  }
  return { name, email };
}

/** Everything the generic step (parseCli) computes before handing a command its own flags. */
export interface ParseCtx {
  name: string;
  decl: CommandDecl;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  cwd: string;
  repoPath: string;
  allowedHosts: string[] | undefined;
  adminGithubLogins: string[] | undefined;
  skills: string[];
  provider: string | undefined;
  reviewProvider: ProviderName | undefined;
  fallbackProvider: ProviderName | undefined;
  fallbackModel: string | undefined;
  builtinProvider: ProviderName | undefined;
  flowRaw: string | undefined;
  commitAuthor: { name: string; email: string } | undefined;
  maxTurns: number | undefined;
  maxRepairIterations: number | undefined;
  proxyMode: boolean;
  runOptions: SharedRunOptions;
}

export type WatchSource = 'linear' | 'github' | 'project' | 'gitlab';
