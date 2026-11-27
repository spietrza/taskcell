import { parseArgs } from 'node:util';
import { poolOf } from '../core/model-pool.js';
import { isProviderName, validateProviderChoice, PROVIDER_NAMES } from '../agents/registry.js';
import type { ProviderName } from '../agents/registry.js';
import { assertSafeBaseBranch } from '../core/base-branch.js';
import { parseUsageCap } from '../core/usage-cap.js';
import { KNOWN_OPTIONS, GLOBAL_OPTION_TYPES, findCommand } from './commands.js';
import type { CommandDecl } from './commands.js';
import { CUSTOM_NAME_RE, fail, parseCommitAuthor, parseLimit, parseNamedSkills, parseRunOptions } from './flags.js';
import type { SharedRunOptions, StageOnlyKey, RunOnlyKey } from './flags.js';
import type { RunOptions } from '../runners/source-adapter.js';
import type { LessonsCommand } from './lessons.js';
import { parserFor } from './parsers.js';

/** A parsed command; `usageCapPct` is the validated `--usage-cap` value, applied to the environment by the CLI entry (parseCli stays pure). */
export type Command = CommandKind & { usageCapPct?: string };

type CommandKind =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean; abandoned: boolean }
  | { kind: 'migrate-labels'; repoSlug: string; apply: boolean }
  | { kind: 'resume-rate-limited'; repoSlug: string; dryRun: boolean; triggerLabels?: string[]; dependencyRepos?: string[]; startedLabels?: string[]; ciWatch?: boolean }
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
      /** A GitHub PR ref, or a GitLab MR (iid with `gitlabProject`, or its URL). */
      prRef: string;
      repoSlug?: string;
      /** GitLab project for a bare MR iid; a GitLab MR URL needs none. */
      gitlabProject?: string;
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
      /** Other repos (owner/repo) a dependency may be read from, besides the watched repo. */
      dependencyRepos?: string[];
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
      /** With --once: also ask for a revision on factory MRs whose pipeline failed or that conflict (default: on). */
      ciWatch?: boolean;
      dryRun?: boolean;
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
  const proxyMode = values['llm-proxy'] === true;
  const entry = parserFor(decl.name);
  if (entry === undefined) return { kind: 'help' };
  // Skipped when the provider is a (possible) custom name: this call dereferences the built-in
  // table and the customs live on disk, invisible to the sync parser. The dispatch entry point
  // re-runs it with the loaded customs BEFORE any sandbox cost (run.ts/watch.ts). reviewProvider
  // cannot be non-built-in (gate above), so built-in pairs keep failing right here at parse.
  // Commands that never pick a provider (entry.providerChoice false) skip it.
  if (entry.providerChoice && (provider === undefined || isProviderName(provider))) {
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

  // Shared by run and watch/doctor; parsing it for the other commands is harmless (pure).
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

  return entry.parse({
    name: decl.name, decl, values, positionals, cwd, repoPath, allowedHosts, adminGithubLogins, skills,
    provider, reviewProvider, fallbackProvider, fallbackModel, builtinProvider, flowRaw, commitAuthor,
    maxTurns, maxRepairIterations, proxyMode, runOptions,
  });
}

export { USAGE } from './commands.js';
