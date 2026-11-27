/**
 * Per-command option declarations. Each command lists the options it accepts, each with its help line;
 * `parseCli` parses strictly against the matched command's table and `--help` is generated from the same
 * tables, so a flag cannot be accepted by a command that ignores it or go missing from the help.
 */

export interface OptionDecl {
  type: 'string' | 'boolean';
  multiple?: boolean;
  /** Value placeholder shown in help, e.g. `<n>`; absent for booleans. */
  arg?: string;
  help: string;
}

export interface CommandDecl {
  name: string;
  /** Positional part of the synopsis, e.g. `<owner/repo#N>`. */
  synopsis?: string;
  summary: string;
  options: Record<string, OptionDecl>;
}

const str = (arg: string, help: string): OptionDecl => ({ type: 'string', arg, help });
const bool = (help: string): OptionDecl => ({ type: 'boolean', help });
const multi = (arg: string, help: string): OptionDecl => ({ type: 'string', multiple: true, arg, help });

const PROVIDERS = '<claude|codex|cursor|zai|openrouter|meridian>';

/** Option definitions shared by several commands; a command may override a field (type, arg, help) for itself. */
const OPT = {
  repo: str('<path>', 'Repo checkout to work in (default: cwd)'),
  help: bool('Print help for this command'),
  provider: str(PROVIDERS, 'Provider that runs every stage (default: claude)'),
  'review-provider': str(PROVIDERS, 'Run only the review stage on this provider (cross-provider review)'),
  'fallback-provider': str('<name>', 'Retry on this provider when the primary one fails (outage, limit, revoked credential); a comma list (codex,cursor) is a fallback chain'),
  'fallback-model': str('<model>', 'Model for every stage that fell back (default: that provider\'s default); a comma list pairs with --fallback-provider'),
  'usage-cap': str('<pct>', 'Stop starting work once the provider\'s plan window is at/over this % (1-100; env TASKCELL_USAGE_CAP_PCT)'),
  'provider-model': str('<m>', 'Model for the implementer/simplifier stages (default: provider\'s default), or a weighted pool: claude/sonnet:3,codex/gpt-6-sol:1'),
  'review-model': str('<m>', 'Model for the review stage (default: provider\'s default), or a pool as for --provider-model'),
  'escalate-model': str('<m>', 'Model for the 2nd and later gate repairs (default: stay on the implementer model)'),
  'no-simplify': bool('Skip the simplifier stage (lean: implement -> review only)'),
  verify: str('<cmd>', 'Verification command for Proof of Work (overrides TASKCELL_VERIFY_CMD and auto-detect)'),
  'visual-proof': str('<cmd>', 'Visual proof command for UI artifacts (overrides TASKCELL_VISUAL_PROOF_CMD)'),
  conformance: bool('Run the conformance pass (planner-tier model checks the diff against the spec; opt-in)'),
  'conformance-model': str('<m>', 'Model for the conformance stage (default: same as implementer)'),
  'commit-author': str('<a>', 'Git author "Name <email>"; also enables white-label mode (no Taskcell branding)'),
  plan: bool('Add a dedicated planning stage first (opus, high effort); same as --flow plan'),
  flow: str('<name>', 'Run a named workflow (e.g. flow-b: plan -> implement -> adversary -> repair)'),
  base: str('<branch>', 'Base branch to branch off and target the PR at (default: main)'),
  'max-turns': str('<n>', 'Override the agent turn cap'),
  'max-repair-iterations': str('<n>', 'Override the conformance/verify repair loop-back cap (default: 2)'),
  skills: str('<dir>', 'Skills directory, merged with the repo\'s .github/vanguard-skills/'),
  'pnpm-store': bool('Mount a persistent pnpm store, one per repo (see docs/cli.md)'),
  'feedback-authors': str('<a,b>', 'Logins trusted beyond OWNER/MEMBER/COLLABORATOR'),
  'dependency-repos': str('<o/r,o/r>', 'Other repos a `Depends on` reference may be read from (default: only the watched repo)'),
  egress: bool('Run the sandbox with allow-listed network egress'),
  'llm-proxy': bool('Hold model credentials in a host sidecar instead of the sandbox'),
  'github-repo': str('<o/r>', 'GitHub repo slug (owner/repo)'),
  'gitlab-project': str('<g/p>', 'GitLab project path (group/project)'),
  github: str('<ref>', 'GitHub issue or PR ref: owner/repo#n, URL, or a bare number with --github-repo'),
  label: str('<name>', 'Trigger label'),
  'reviewing-label': str('<l>', 'Label added while an item is being reviewed'),
  'reviewed-label': str('<l>', 'Label added after review succeeds'),
  author: str('<login>', 'Only review items opened by this author'),
  concurrency: str('<n>', 'Max items processed at once (default: 2)'),
  interval: str('<seconds>', 'Poll interval (default: 60)'),
  once: bool('Do a single pass'),
  json: bool('Machine-readable JSON output'),
  branch: str('<name>', 'Metrics branch to read or write (default: taskcell-metrics)'),
  'dry-run': bool('Report what would happen without changing anything'),
  out: str('<file>', 'Write the result to this local file instead of posting it'),
  since: str('<date>', 'Only entries at or after this date or window'),
  limit: str('<n>', 'Maximum number of entries'),
  pr: str('<n>', 'PR number'),
  'pinned-only': bool('With a pinned PR, review only it and skip the label scan (per-PR CI concurrency group, one run per labelled PR)'),
  'config-dir': str('<dir>', 'The hub config dir holding the hub audit log (default: the hub\'s own)'),
  'spec-model': str('<m>', 'Model for the tech-spec stage'),
  'trigger-state': str('<x>', 'Status option name for ready items (project default "Todo"; linear: state type, default "unstarted")'),
  'trigger-state-name': str('<x>', 'Linear display state name matching --trigger-state'),
  'claimed-state': str('<x>', 'Status/label set on claim (github: label taskcell:running)'),
  'review-state': str('<x>', 'Status/label set after a PR opens (github: label taskcell:needs-human-review)'),
  'spec-claimed-label': str('<l>', '(loop-v1, github/gitlab) Label set while an issue is being specced'),
  'trigger-labels': str('<a,b>', 'Custom trigger labels to re-apply'),
} satisfies Record<string, OptionDecl>;

/** The options run, watch and doctor share (one list, so the three cannot drift). */
const RUN_OPTS = [
  'provider', 'review-provider', 'fallback-provider', 'fallback-model', 'usage-cap', 'provider-model', 'review-model',
  'escalate-model', 'no-simplify', 'verify', 'visual-proof', 'conformance', 'conformance-model', 'commit-author', 'plan',
  'flow', 'base', 'max-turns', 'max-repair-iterations', 'skills', 'pnpm-store', 'feedback-authors',
] as const satisfies readonly (keyof typeof OPT)[];

type Overrides = Record<string, Partial<OptionDecl> & { help: string }>;

/** Own (command-specific) options: full declarations, not in the shared table. */
type Own = Record<string, OptionDecl>;

function command<N extends string>(name: N, summary: string, shared: readonly (keyof typeof OPT)[], own: Own = {}, overrides: Overrides = {}, synopsis?: string): CommandDecl & { name: N } {
  const options: Record<string, OptionDecl> = {};
  for (const key of shared) options[key] = { ...OPT[key], ...overrides[key] };
  Object.assign(options, own);
  options['help'] = OPT.help;
  return { name, summary, options, ...(synopsis !== undefined ? { synopsis } : {}) };
}

const WATCH_OWN: Own = {
  source: str('<linear|github|project|gitlab>', 'Task source (default: linear; github when --github-repo is given)'),
  project: str('<number>', '(--source project) GitHub Projects v2 project number'),
  team: str('<KEY>', '(linear) limit to a team'),
  'max-tasks': str('<n>', 'Cap the ready tasks claimed per poll, for each phase (default: unlimited)'),
  issue: str('<ref>', '(--source github) Run only this issue (owner/repo#n or a bare number); implies --once'),
  'loop-v1': bool('Use Loop v1 defaults (routing labels / states for the spec and agent passes)'),
  'spec-label': str('<l>', '(loop-v1, github/gitlab) Label that triggers the spec pass'),
  'agent-label': str('<l>', '(loop-v1, github/gitlab) Label that triggers the agent pass'),
  'needs-info-label': str('<l>', '(loop-v1, github/gitlab) Label set when the spec needs information'),
  'spec-state': str('<x>', '(loop-v1, linear) State type that triggers the spec pass'),
  'spec-state-name': str('<x>', '(loop-v1, linear) State name the spec pass reverts to'),
  'agent-state': str('<x>', '(loop-v1, linear) State the spec pass advances specced issues into'),
  'needs-info-state': str('<x>', '(loop-v1, linear) State set when the spec needs information'),
  'spec-claimed-state': str('<x>', '(loop-v1, linear) State set while an issue is being specced'),
  'spec-only': bool('Run only the spec pass (needs loop-v1 and a review --agent-label/--agent-state other than the build trigger)'),
};

const WATCH_SHARED = [...RUN_OPTS, 'spec-model', 'repo', 'github-repo', 'gitlab-project', 'label', 'trigger-state', 'trigger-state-name', 'claimed-state', 'review-state', 'spec-claimed-label', 'dependency-repos', 'concurrency', 'interval', 'once', 'egress', 'llm-proxy'] as const satisfies readonly (keyof typeof OPT)[];

const REVIEW_SHARED = ['repo', 'provider', 'review-model', 'max-turns', 'usage-cap', 'egress', 'llm-proxy', 'skills'] as const satisfies readonly (keyof typeof OPT)[];

const SKILLS_OWN: Own = {
  dir: str('<skills dir>', 'Skills directory (default: <repo>/skills)'),
  strict: bool('(check) exit 1 on outdated or modified skills'),
  path: str('<dir>', '(add) Subdirectory of the source holding the skill'),
  name: str('<name>', '(add) Name to pin the skill under'),
  pr: bool('(update) Open a PR with the SKILL.md diff instead of editing in place'),
  force: bool('(update) Update even when the pinned commit can no longer be fetched'),
};

const AUDIT_STREAMS = 'hub, run-events, metrics, decisions, lessons';

export const COMMANDS = [
  command('run', 'Run an agent on a task and open a draft PR for review (exactly one of --linear, --github, --gitlab, --project).', [...RUN_OPTS, 'repo', 'github-repo', 'label', 'github', 'gitlab-project', 'concurrency', 'egress', 'llm-proxy'], {
    linear: str('<id>', 'Linear issue id'),
    gitlab: str('<ref>', 'GitLab issue ref'),
    project: str('<number>', 'GitHub Projects v2 board number: run every ready item'),
    parent: bool('(--linear) Run the sub-issues of a parent issue'),
    'gc-before': bool('Reap stale sandboxes before starting'),
    reuse: bool('Reuse an existing worktree/branch for the task'),
    fork: str('<n>', 'Run the implementer n times (n>=2) and keep the best variant'),
    'fork-scorer': str('<llm|decision>', 'Scorer for --fork variants (default: llm)'),
    'spec-file': str('<file>', 'Use this tech spec instead of fetching one (single-issue runs only)'),
    skill: multi('<name>', 'Named skill to apply (repeatable; single-issue runs only)'),
  }, { 'github-repo': { help: 'GitHub repo slug for a bare --github number (default: detected from origin)' } }),
  command('watch', 'Poll Linear, GitHub or GitLab and run each newly-ready issue automatically (the AFK factory loop).', WATCH_SHARED, WATCH_OWN, {
    label: { help: 'Required for linear/github/gitlab; optional label filter for project' },
    base: { help: 'Base branch to branch off and target PRs at (default: main)' },
  }),
  command('doctor', 'Check whether watch can run AFK before any issue is claimed; takes the same flags as watch.', WATCH_SHARED, { ...WATCH_OWN, fix: bool('Install the repo-pinned agent CLIs in the sandbox image if it is stale, then re-check') }),
  command('review-pr', 'Review an existing GitHub PR and post a non-blocking review comment.', [...REVIEW_SHARED, 'github-repo', 'github', 'feedback-authors', 'out'], {
    'github-pr': str('<n>', 'PR number (or pass the PR as a positional)'),
  }, { out: { help: 'Write the review to this local file instead of posting a PR comment' } }, '<PR ref>'),
  command('research', 'Research a GitHub issue and post the findings as a comment.', ['repo', 'github-repo', 'github', 'provider', 'usage-cap', 'egress', 'llm-proxy', 'commit-author'], {
    web: bool('Declare that web egress is available (web-research mode)'),
    'research-model': str('<m>', 'Model for the research stage'),
  }, {}, '<issue ref>'),
  command('spec', 'Write a tech spec for a GitHub issue and post it as an issue comment.', ['repo', 'github-repo', 'github', 'provider', 'usage-cap', 'egress', 'llm-proxy', 'skills', 'spec-model', 'max-turns', 'base', 'out', 'commit-author'], {}, {
    out: { help: 'Write the spec to this local file instead of posting an issue comment (pairs with run --spec-file)' },
    base: { help: 'Branch the spec worktree is cut from (default: main)' },
  }, '<issue ref>'),
  command('revise-pr', 'Apply human review feedback on a Taskcell draft PR and hand it back ready to merge.', ['repo', 'github-repo', 'github', 'feedback-authors', 'provider', 'fallback-provider', 'fallback-model', 'provider-model', 'review-model', 'usage-cap', 'egress', 'llm-proxy', 'skills', 'commit-author', 'out'], {
    'github-pr': str('<n>', 'PR number (or pass the PR as a positional)'),
    'max-rounds': str('<n>', 'Maximum revision rounds'),
  }, { out: { help: 'Dry-run: write the diff and proposed thread replies to this file; push and comment nothing' } }, '<PR ref>'),
  command('watch-prs', 'Poll GitHub PRs by label and run the non-blocking review loop.', [...REVIEW_SHARED, 'github-repo', 'label', 'reviewing-label', 'reviewed-label', 'author', 'concurrency', 'interval', 'once', 'feedback-authors', 'pr', 'pinned-only'], {}, {
    pr: { help: 'Also review this PR even if the label scan misses it' },
    label: { help: 'Required trigger label (e.g. "ready for taskcell review")' },
  }),
  command('doctor-prs', 'Check whether watch-prs can run AFK before any PR is claimed.', ['repo', 'github-repo', 'label', 'reviewing-label', 'reviewed-label', 'provider', 'llm-proxy']),
  command('review-mr', 'Review an existing GitLab MR and post a non-blocking review comment.', [...REVIEW_SHARED, 'gitlab-project'], { mr: str('<iid>', 'GitLab MR IID (integer)') }),
  command('watch-mrs', 'Poll GitLab MRs by label and run the non-blocking review loop.', [...REVIEW_SHARED, 'gitlab-project', 'label', 'reviewing-label', 'reviewed-label', 'author', 'concurrency', 'interval', 'once']),
  command('doctor-mrs', 'Check whether watch-mrs can run AFK before any MR is claimed.', ['repo', 'gitlab-project', 'label', 'reviewing-label', 'reviewed-label', 'author', 'provider', 'review-model', 'llm-proxy']),
  command('stats', 'Aggregate .taskcell/runs/metrics.jsonl into a cost/token/time rollup (per task, stage, model, probe).', ['repo', 'branch', 'json', 'github-repo', 'feedback-authors', 'since'], {
    skills: bool('Per-skill rollup: review pass rate, repair rounds and cost with vs without each skill'),
    approver: bool('Shadow approver scorecard instead of the cost/token rollup (verdict vs human outcome; needs gh)'),
  }, {
    branch: { help: 'Read metrics.jsonl from this remote branch instead (what `metrics push` wrote; default: taskcell-metrics)' },
    'github-repo': { help: 'Also read each recorded PR of this repo from GitHub: lead times and the LESSONS first-pass rate (needs gh)' },
    'feedback-authors': { help: 'Extra trusted logins whose review verdicts count for the first-pass rate (as on lessons record)' },
    since: { help: 'With --skills: only runs from the last window, e.g. 30d or 12h' },
  }),
  command('metrics', 'metrics push: append this checkout\'s metrics.jsonl lines to the orphan metrics branch and push (idempotent).', ['repo', 'branch'], {}, {}, 'push'),
  command('approve', 'Compute a deterministic APPROVE/ESCALATE decision for a factory PR; shadow mode (default) never merges.', ['repo', 'github-repo', 'branch', 'json', 'dry-run', 'pr'], {
    mode: str('<shadow|enforce|act>', 'shadow (default) only records and comments, check neutral; enforce: check success/failure, never merges; act merges (see docs/autonomous-loop.md)'),
    'rerun-open': bool('Re-judge every open factory PR (instead of --pr); decisions are appended only where the policy hash changed'),
    'review-run-id': str('<id>', 'Removed: act mode reads the run stamp on the review itself; passing it is an error'),
  }, { pr: { help: 'PR number (bare positional also accepted)' }, 'github-repo': { help: 'Repo slug — the approver never infers the repo it judges' } }, '[PR number]'),
  command('lessons', 'record: distil 0-3 lessons from a closed factory PR or MR; list | dismiss <id>: show or dismiss live lessons.', ['repo', 'branch', 'json', 'github-repo', 'gitlab-project', 'pr', 'dry-run', 'provider-model', 'feedback-authors'], {
    mr: str('<n>', '(record) GitLab MR number, with --gitlab-project'),
  }, {}, 'record|list|dismiss <id>'),
  command('skills', 'list | check | add | remove | update the repo\'s pinned skills; see docs/skills.md.', ['repo', 'dry-run', 'base'], SKILLS_OWN, {
    base: { help: '(update --pr) Branch the PR targets' },
  }, 'list|check|add <git-url>[#ref]|remove <name>|update [name]'),
  command('audit', `verify | export the hash-chained audit streams (${AUDIT_STREAMS}); see docs/audit.md.`, ['repo', 'since', 'branch', 'config-dir'], {
    stream: str('<name>', `One of ${AUDIT_STREAMS} (default: all)`),
    until: str('<date>', '(export) Only entries up to this date'),
    format: str('<jsonl|csv>', '(export) Output format (default: jsonl)'),
  }, {}, 'verify|export'),
  command('history', 'One issue\'s history over the audit streams (trigger, runs, reviews, approver, merge).', ['repo', 'config-dir', 'branch', 'json'], {
    offline: bool('Do not ask the Git host (no label/comment/merge events)'),
  }, {}, '<owner/repo#N>'),
  command('memory', 'Refresh .taskcell/memory/retrospective.md from run artifacts and print it.', ['repo', 'limit', 'json']),
  command('eval', 'Run the committed eval corpus and print a per-kind pass-rate report.', ['repo', 'json', 'limit', 'out', 'github-repo', 'since', 'branch'], {
    'judge-model': str('<m>', 'Model for the judge (default: a Haiku model, or a decision model)'),
    'produce-model': str('<m>', 'Model under test (default: claude-sonnet-5-5)'),
    suggest: bool('Draft eval-corpus candidates from retrospective memory instead of running the corpus'),
    markdown: bool('With --suggest: force markdown output'),
    baseline: str('<file|main>', 'Gate against a saved baseline: a local file, or "main" for the latest on the metrics branch'),
    'max-drop': str('<points>', 'Max tolerated drop in overall pass rate, in points (default 5; with --baseline)'),
    'allow-corpus-change': bool('Compare against a baseline whose corpus hash differs, instead of refusing'),
    'save-baseline': bool('Publish this result as the new baseline'),
  }),
  command('migrate-labels', 'Rename a repo\'s old vanguard:* labels to taskcell:* (dry-run by default).', ['github-repo'], { apply: bool('Rename the labels') }),
  command('resume-rate-limited', 'Re-apply the trigger label on issues/PRs a provider limit or an unmet dependency parked, once clear.', ['github-repo', 'dry-run', 'trigger-labels', 'dependency-repos', 'claimed-state', 'review-state', 'spec-claimed-label'], {
    'no-ci-watch': bool('Do not revise factory PRs whose required checks failed or that conflict with their base (default: on; needs a user token)'),
  }, {
    'claimed-state': { help: 'As given to watch' },
    'review-state': { help: 'As given to watch' },
    'spec-claimed-label': { help: 'As given to watch' },
  }),
  command('gc', 'Reap stale sandbox containers, prune worktrees, and (with --remote) delete merged remote chore/taskcell-* branches.', ['repo', 'dry-run'], {
    'max-age-hours': str('<n>', 'Only reap resources older than n hours (default: 6)'),
    remote: str('<owner/repo>', 'Also delete merged remote chore/taskcell-* (or chore/vanguard-*) branches (needs gh)'),
    abandoned: bool('Also delete branches whose PR is closed-unmerged'),
  }),
  command('hub', 'Serve the Inspector UI over HTTP/SSE; "hub rotate-token --token-file <path>" writes a new token.', ['repo'], {
    host: str('<addr>', 'Address to bind (env TASKCELL_HUB_HOST; default: 127.0.0.1)'),
    port: str('<port>', 'Port to bind, 1-65535 (env TASKCELL_HUB_PORT; default: 7777)'),
    'ui-dir': str('<dir>', 'Serve the Inspector UI from this directory instead of the bundled one'),
    'no-open': bool('Do not open the browser'),
    demo: bool('Open a read-only demo project on bundled sample data (touches no repo, remote or hub store)'),
    'token-file': str('<path>', 'Keep one token across restarts (env TASKCELL_HUB_TOKEN_FILE; created 0600 if missing)'),
    'allowed-host': multi('<host>', 'Extra Host header accepted on a non-loopback bind (repeatable)'),
    'admin-github-login': multi('<login>', 'GitHub login granted admin access (repeatable)'),
  }, {}, '[rotate-token]'),
] as const;

/** Every command word the CLI declares. */
export type CommandName = (typeof COMMANDS)[number]['name'];

/** Every option name any command declares: tells a flag meant for another command from a typo. */
export const KNOWN_OPTIONS: ReadonlySet<string> = new Set(COMMANDS.flatMap((c) => Object.keys(c.options)));

export function findCommand(name: string | undefined): CommandDecl | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/**
 * Option name -> type over every command, for finding the command word past options that take a value.
 * Sorted so a string declaration is inserted last and wins when commands disagree (`--pr`, `--skills`).
 */
export const GLOBAL_OPTION_TYPES: ReadonlyMap<string, 'string' | 'boolean'> = new Map(
  COMMANDS.flatMap((c) => Object.entries(c.options)).sort(([, a], [, b]) => (a.type === 'string' ? 1 : 0) - (b.type === 'string' ? 1 : 0)).map(([k, o]) => [k, o.type] as const),
);

function optionLines(decl: CommandDecl): string[] {
  const rows = Object.entries(decl.options).map(([name, o]) => [`--${name}${o.arg !== undefined ? ` ${o.arg}` : ''}`, o.help] as const);
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 2;
  return rows.map(([flag, help]) => `    ${flag.padEnd(width)}${help}`);
}

/** Usage for one command, generated from its declaration. */
export function commandUsage(decl: CommandDecl): string {
  return [`taskcell ${decl.name}${decl.synopsis !== undefined ? ` ${decl.synopsis}` : ''} [options]`, '', `  ${decl.summary}`, '', '  Options:', ...optionLines(decl)].join('\n');
}

/** The full `--help` text: every command's summary and options. */
export const USAGE: string = [
  'taskcell <command>',
  '',
  'Commands:',
  ...COMMANDS.map((c) => `  ${c.name.padEnd(20)}${c.summary}`),
  '',
  'Run `taskcell <command> --help` for one command. Options by command:',
  '',
  ...COMMANDS.flatMap((c) => [commandUsage(c), '']),
].join('\n');
