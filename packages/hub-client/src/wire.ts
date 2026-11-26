// GENERATED from src/wire.ts — do not edit; run pnpm gen:wire
/**
 * The wire contract shared between core and the desktop app (Subsystem 7).
 *
 * RULES (enforced by src/wire.test.ts):
 * - ZERO imports, static or dynamic — this file must be safe in the Tauri webview.
 * - Syntax ceiling: interfaces, type aliases, literal unions, `const` literals only — nothing the
 *   desktop's OLDER TypeScript cannot parse (the drift guard proves byte-equality, not
 *   compilability; the ceiling is what keeps this compiling on both sides).
 * - `pnpm gen:wire` copies this file (plus a header, and the `Commands`/`COMMAND_NAMES` derived from the
 *   hub command modules in src/hub/commands/) to packages/hub-client/src/wire.ts; the drift test compares them. Change here ⇒ regenerate, or root CI fails naming the fix.
 *
 * Rust never inspects these payloads (sidecar traffic passes through as opaque JSON), so this file
 * IS the contract for everything TS↔TS. The TS↔Rust shapes (serde structs in src-tauri) are a
 * different boundary and stay hand-mirrored — see the note above `Project`.
 */

/** Reasoning-effort tiers accepted across stages, flows, and the CLI. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Structured run events emitted by the pipeline runner when a caller passes `onEvent`. Stage names
 * are plain strings (matching StageOutcome.name). The desktop additionally sees a Rust-minted
 * `run-accepted` variant that core never emits — declared desktop-side, not here.
 *
 * `run-queued` is the one exception to that rule: unlike `run-accepted`, it is minted by the HUB
 * itself (`src/hub/run-session.ts`), in TypeScript on both ends of the wire, so it is declared here
 * rather than as a desktop-side extension — `position` is 1-based (1 = next to start), `repoPath`
 * scopes it to a project exactly like `run-accepted`'s.
 */
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: string[] }
  | { type: 'stage-start'; name: string; index: number; of: number }
  | { type: 'stage-end'; name: string; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number }
  | { type: 'warning'; message: string }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean }
  | { type: 'run-error'; message: string }
  | { type: 'run-cancelled' }
  | { type: 'run-queued'; position: number; repoPath: string };

/** A selectable flow: its stable key and a human label for the UI. */
export interface FlowInfo {
  name: string;
  label: string;
  /** Stage names in order, for built-ins. */
  stages?: string[];
  /** A built-in as an editable flow, present only when copying it is faithful; absent otherwise. */
  doc?: FlowDoc;
}

/** What the run builder + flow editor render from — providers, flows, the stage palette, transports, defaults. */
export interface Capabilities {
  providers: string[];
  flows: FlowInfo[];
  /** STAGE_LIBRARY keys — the flow editor's stage palette. Static per session. */
  stages: string[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

/** The task transports vanguard reads/publishes through. */
export const TRANSPORTS = ['github', 'gitlab', 'linear'] as const;

/** Params for the sidecar `createRun` method. */
export interface CreateRunParams {
  issueRef: string;
  /** Absolute path to the target project repo — required (the sidecar child has no project cwd). */
  repoPath: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
  /**
   * The run's whole hand-picked skill list (installed ids, loaded on top of the automatic selection). When
   * present it replaces the issue body's `Skills:` line, which the form preselects, so a skill unticked
   * there is not loaded. An unknown id fails the run before any model call.
   */
  skills?: string[];
  /** Hub only: who started the run. Set server-side from the request's actor, never from the client. */
  startedBy?: string;
  /** Hub only: the stored hub-board task a `hub` transport run implements. Set by the hub's scheduler; a client
   * cannot reach it, because `hub` is not one of `TRANSPORTS` and the protocol validator refuses it. */
  hubTask?: { id: string; title: string; body: string };
  /** Hub only, server-set from Settings (never from the client): the run's fallback chain as `--fallback-provider` / `--fallback-model` values. */
  fallbackProvider?: string;
  fallbackModel?: string;
}

/** Hub-only, server-set (never part of the client's params): the credential a run uses. `env` holds
 * the secret values and must never be persisted or logged; only `source` reaches the run record. */
export interface RunCredential {
  source: 'instance' | 'user';
  env: Record<string, string>;
  /** Stored account id (the cool-down key) and its user-given name; absent when the env came from the hub start-up
   * environment or a variable that is not a stored account. The name is shown in run records; never the value. */
  accountId?: string;
  accountName?: string;
  /** Which provider the stored account is for (default claude); server-internal. */
  accountProvider?: string;
}

/** Hub-only, in-process (never serialised): rotation across a provider's stored accounts for ONE run, in list order. */
export interface CredentialRotation {
  readonly provider: string;
  /** Another enabled, non-cooling account not yet exhausted in this run exists. */
  hasNext(): Promise<boolean>;
  /** Cool `accountId` until `until` (cool-down file, plus an in-run set so a failed write still skips it) and return the next account's credential, or undefined when all are out. */
  limited(accountId: string, until: Date): Promise<RunCredential | undefined>;
  /** Cool without switching (a stage fallback rescued the stage). */
  cool(accountId: string, until: Date): Promise<void>;
  /** Re-pick at dequeue: a queued run whose account has since cooled starts on the next one. */
  refresh(current: RunCredential): Promise<RunCredential>;
  /** Drop every account lease this run holds (Codex: an account in use by a run is skipped by others). Idempotent. */
  release(): void;
  /** Save a refreshed `CODEX_AUTH_JSON` back to the stored account `accountId` only, if it still holds `originalRefreshToken`. False when nothing was written; never throws. */
  saveRotated(accountId: string, originalRefreshToken: string, authJson: string): Promise<boolean>;
}

/** Result of the sidecar `createRun` method. */
export interface CreateRunResult {
  prUrl?: string;
  secretBlocked?: boolean;
  /** A hub-board task in a repository with no GitHub origin: the local branch that holds the result (no PR). */
  branch?: string;
  /** The run stopped before implementing because the base branch's verify command already fails. */
  baseRed?: boolean;
  /** The result was delivered (a PR or a local branch) but its verify command failed. */
  verificationFailed?: boolean;
  /** The implementer stopped before signalling it was done (e.g. it asked a question): any delivered result is partial. */
  implementerIncomplete?: boolean;
}

/** Per-stage routing/budget overrides expressible in HCL (snake_case keys map to these camelCase fields). */
export interface StageOverrides {
  model?: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  provider?: string;
  resumePrevious?: boolean;
}

/** One `stage {}` block: a name (library key), an optional `ref` (Layer-2 escape hatch), and overrides. */
export interface StageDecl {
  name: string;
  /** `"relpath#export"` resolved under `<repoPath>/.taskcell/`. Present ⇒ record comes from TS, not the library. */
  ref?: string;
  overrides: StageOverrides;
  /** Freeform pass-through block; never interpreted. */
  meta?: Record<string, unknown>;
}

/** One `loop {}` block. Parsed/emitted in S2; execution deferred. */
export interface LoopDecl {
  stages: string[];
  until: string;
  max: number;
}

/** A whole flow file: exactly one `flow "<name>" {}` block. */
export interface FlowDoc {
  name: string;
  label: string;
  stages: StageDecl[];
  loops: LoopDecl[];
  meta?: Record<string, unknown>;
}

/** A skill found in an upstream repository (`discover_skills`): its folder (`.` for the root) and its name. */
export interface DiscoveredSkill {
  path: string;
  name: string;
}

/** An open pull request that adds skills (`list_pending_skill_prs`): they appear in the list once it is merged. */
export interface PendingSkillPr {
  number: number;
  url: string;
  names: string[];
}

/** One skill of a repository's skills directory on the wire: `skills list`, `skills check` and `stats --skills` joined. */
export interface RepoSkill {
  name: string;
  /** Git URL it is pinned to; '-' for a local skill. */
  source: string;
  /** Short pinned commit; empty when none. */
  commit: string;
  /** Lock status: pinned, locally modified, or not in the lock. */
  status: 'pinned' | 'local' | 'modified';
  /** Against the upstream head; 'unknown' when it could not be resolved. */
  check: 'local' | 'current' | 'outdated' | 'unknown';
  /** Runs recorded with the skill; absent when none used it. */
  usage?: { runs: number; passRate?: number; avgRepairRounds: number; avgCostUsd: number };
  /** Runs that used the skill in the last 30 days (`taskcell stats --skills --since 30d`); 0 when none; absent from an older hub. */
  runs30d?: number;
}

/** One live lesson (src/core/lessons.ts) on the wire. */
export interface RepoLesson {
  id: string;
  rule: string;
  why: string;
  /** PR or comment URL the lesson came from. */
  evidence: string;
  /** Path globs the lesson applies to; empty = repo-wide. */
  paths: string[];
  stage?: 'spec' | 'implement' | 'review' | 'verify';
  prNumber: number;
  timestamp: string;
}

/** One discovered flow file. `name` present ⇔ parsed (openable); `error` present ⇔ not runnable. */
export interface RepoFlowInfo {
  file: string;
  name?: string;
  label?: string;
  error?: string;
}

/**
 * One configured custom provider on the wire (S6): healthy (name, no error) or broken (`error`
 * set; index -1 = the whole-file pseudo-entry). `error` absent ⇔ runnable.
 */
export interface RepoProviderInfo {
  index: number;
  name?: string;
  error?: string;
}

/**
 * One composer attachment forwarded with a doc-chat completion (Editor UX 7/7). Additive on the
 * wire — a caller that sends none is byte-identical to the pre-attachment protocol.
 *
 * `kind: 'image'` → a pasted/dropped image persisted under `.taskcell/drafts/<id>-assets/`; `path`
 * is its absolute path and `mediaType` its IANA type (e.g. `image/png`). `__complete` reads the
 * file and forwards it to the agent SDK as an image content block.
 *
 * `kind: 'file'` → a dropped text file or an `@`-mention; `path` is the fence label (the dropped
 * filename or the `@path`) and `content` its already-read, host-capped UTF-8 text, inlined into the
 * prompt as a fenced block. `mediaType`/`content` are per-kind and both optional on the wire.
 */
export interface CompleteAttachment {
  kind: 'image' | 'file';
  path: string;
  mediaType?: string;
  content?: string;
}

/** One doc-chat completion request (the JSON `vanguard __complete` reads on stdin). */
export interface CompleteRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
  baseUrl?: string;
  /** Pasted images + inlined text files/mentions (Editor UX 7/7). Absent ⇒ text-only completion. */
  attachments?: CompleteAttachment[];
  /** TRUSTED image-containment root, stamped by the Rust sidecar over anything the renderer sent
   * (like baseUrl): every image attachment path must canonicalize under it. Absent ⇒ image
   * attachments are refused. */
  assetRoot?: string;
}

/** Ceiling on ONE image attachment file (Editor UX 7/7 review r1) — matches the Anthropic API's
 * per-image limit; refused before the model is hit. */
export const MAX_IMAGE_BYTES = 5_000_000;

/** Ceiling on the AGGREGATE bytes of all image attachments in one send (Editor UX 7/7 review r3):
 * bounds the whole prompt, not just each image, so N images can't balloon a single turn. */
export const MAX_IMAGE_TOTAL_BYTES = 15_000_000;

/** Ceiling on ONE inlined attachment/mention file (Editor UX 7/7) — the drag-drop/mention 64KB cap. */
export const MAX_ATTACHMENT_BYTES = 64_000;

/** Ceiling on TOTAL inlined attachment/mention content per send (Editor UX 7/7). Error above. */
export const MAX_INLINE_TOTAL_BYTES = 256_000;

/** The single JSON line `vanguard __complete` writes to stdout. */
export interface CompleteResponse {
  text?: string;
  error?: { message: string };
}

/** A created task: the ref `taskcell run` accepts, and the URL to show the human. */
export interface CreatedTask {
  id: string;
  url: string;
}

/**
 * Body size ceiling for created tasks. Enforced BEFORE any request: hitting a real provider limit
 * surfaces as a bare E2BIG from the OS, which tells the user nothing.
 */
export const MAX_BODY_BYTES = 60_000;

/** Title byte ceiling for created tasks (a pathological `# ...` is one doc away). */
export const MAX_TITLE_BYTES = 500;

/** The ONE repo-configured-name grammar (flows AND custom providers — S5/S6). */
export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Grammar for a custom provider's `keyEnv` (an environment variable NAME, never a key). */
export const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The allowed keys of a `customProviders` entry (unknown keys are a validation error). */
export const CUSTOM_PROVIDER_KEYS = ['name', 'baseUrl', 'keyEnv', 'model'] as const;

/**
 * A VALID `customProviders` entry (Subsystem 6) — the shape the core loader accepts and the
 * Settings form edits. `AppConfig.customProviders` stays `unknown` on purpose: the file is
 * hand-editable, so entries reach both producers invalid and with unknown keys, and only the
 * loader (and `customProviderRowError`, its editor mirror) may call one well-formed.
 */
export interface CustomProviderSpec {
  name: string;
  /** Absolute http:/https: URL — becomes ANTHROPIC_BASE_URL verbatim. */
  baseUrl: string;
  /**
   * Host env var NAME holding the key (read at dispatch, never stored). Omit for a keyless endpoint
   * (a proxy that holds its own auth): a non-empty placeholder token is injected instead.
   */
  keyEnv?: string;
  /** Forced default model (zai pattern) for endpoints that don't serve the CLI's Claude default. */
  model?: string;
}

/**
 * The built-in provider names, in registry-table order. A LITERAL, not derived: PROVIDER_NAMES is
 * `Object.keys(PROVIDERS)` inside registry.ts, which imports node-only provider classes — this
 * file must stay webview-safe. registry.test.ts pins `WIRE_PROVIDER_NAMES` equal (incl. order).
 */
export const WIRE_PROVIDER_NAMES = ['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian'] as const;

/** Adversary-finding severity/kind vocabularies; core's zod schema derives its enums from these. */
export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const FINDING_KINDS = ['security', 'perf', 'correctness', 'style'] as const;

/** One board card (S9): id resolvable to (source, ref) for spec fetch and run-record matching. */
export interface BoardTask {
  id: string;
  title: string;
  column: 'queued' | 'claimed' | 'running' | 'verify-failed' | 'review' | 'done';
  /** The chip: first label else provider state (github/gitlab); the workflow state (Linear). */
  state: string;
  /** Hub board: the card's newest run stopped to ask the person; it waits for their answer (Home's inbox). */
  asked?: true;
  /** Waiting for the factory: carries a trigger label and is still `queued`. Absent when false. */
  waiting?: boolean;
  /** Current pipeline stage of a running task (from the run's stage marker). Absent ⇒ unknown. */
  stage?: string;
  /** Latest run's per-stage/gate verdicts. Absent ⇒ no run record for this task. */
  chips?: BoardChip[];
  /** The branch this card's PR targets: its `taskcell:base=` label, else the repo default. Absent when neither is set (`main`). */
  baseBranch?: string;
  /** Skills the task names by hand (its `Skills:` line). Absent when none. */
  skills?: string[];
  /** The tracker's labels, minus Taskcell's own routing labels; the Board and Runs search matches them. Absent when none. */
  labels?: string[];
  /** Taskcell's own lifecycle labels on the card (`ready for agent`, `taskcell:running`, `needs info`...), as the tracker spells them. Absent when none. */
  factoryLabels?: string[];
  /** The tracker the card came from; names the "Open in …" link. */
  source?: 'github' | 'gitlab' | 'linear';
  /** The issue's address in that tracker, as the tracker returned it. Absent ⇒ no link. */
  url?: string;
  /** Parked by a provider usage/rate limit (the `rate-limited` label); the factory retries it by itself. Absent when not paused. */
  paused?: PausedState;
  /** Tasks this one waits for: the hub board's field, or what a GitHub issue's body names (`Depends on #n`). */
  blockedBy?: string[];
  /** Start date as stored (`YYYY-MM-DD` or an ISO instant). Absent ⇒ none. */
  startDate?: string;
  /** Hub-board tasks: what the scheduler does with the card, with its reason. */
  schedule?: TaskSchedule;
  /** The hub's time zone, for dates shown on the card. */
  timeZone?: string;
  /** Where the card sits and what its newest run and its waiting item say; set by the hub's `list_tasks` / `list_tasks_all` (src/hub/card-view.ts), the one place that decides it. */
  view?: CardView;
}

/**
 * A place on the line: `at` is the station index (0 card … 5 pull request; 6 = past the line, done); `failed` marks that
 * station red. `passed`: stations after `at` the records show passed all the same (a run that stopped to ask after its gates ran green).
 */
export interface CardPlace {
  at: number;
  failed: boolean;
  passed?: number[];
}

/** A run's outcome, derived once by the hub: the Runs row, the run page and the card read the same. */
export interface RunOutcome {
  /** The state word ("PR open", "failed", "Waiting for your answer"...). */
  state: string;
  /** Where the run left its card on the line. */
  place: CardPlace;
}

/** A card's newest local run (CI-imported runs are never it). */
export interface CardRun extends RunOutcome {
  timestamp: string;
  /** The run's pull request / merge request address. Absent when it opened none. */
  prUrl?: string;
}

/** One card as the line shows it: the join of the card, its newest local run and its waiting needs-you item. */
export interface CardView {
  /** The station the card sits at: its newest run's place once it is in Review or failed, else its column's. */
  place: CardPlace;
  /** Absent ⇒ the card has no local run. */
  run?: CardRun;
  /** The card's Needs-you item (its pull request, its question, its issue), if one waits. */
  waiting?: NeedsYouItem;
  /** The hub could not check GitHub for what waits (rate limit, offline): `waiting` is the last good read, if any. */
  waitingUnchecked?: true;
}

/** The scheduler's answer for one hub-board task; `label` is pre-rendered ("waits until Tue 18.11 (Europe/Berlin)"). */
export interface TaskSchedule {
  /** `queued`: handed to the run session, waiting behind another run. `refused`: its last start was refused; retried every tick. */
  state: 'running' | 'queued' | 'done' | 'failed' | 'ready' | 'refused' | 'blocked' | 'waits-date' | 'waits-slot' | 'invalid';
  label: string;
  /** `invalid`: a missing reference, a cycle or a bad date. `failed` / `refused`: why. */
  reason?: string;
  /** `done`: the pull request URL, or `branch <name>` for a repository with no GitHub origin. */
  result?: string;
  blockedBy?: string[];
  /** `waits-date`: the instant the task may start (ISO). */
  until?: string;
}

/** Why a task is paused and when the scheduled resume retries it. `until`/`trigger` come from the factory's marker comment; absent when it is missing. */
export interface PausedState {
  reason: 'provider-limit';
  /** ISO time after which the scheduled resume retries. */
  until?: string;
  /** The label the retry re-applies. */
  trigger?: string;
}

/** The reviewer's persisted verdict: `changes` ⇔ the merge gate would request changes. */
export type ReviewVerdict = 'pass' | 'changes' | 'incomplete';

/** One Task Board verdict chip: a stage/gate and what it decided. `label` is pre-rendered by core. */
export interface BoardChip {
  /** Stage or gate the chip speaks for: a StageOutcome.name, or 'proof' / 'visual-proof'. */
  key: string;
  label: string;
  tone: 'pass' | 'changes' | 'failed';
}

/** One adversary-stage finding (the `<findings>` block item shape). */
export interface Finding {
  severity: (typeof FINDING_SEVERITIES)[number];
  kind: (typeof FINDING_KINDS)[number];
  title: string;
  evidence: string;
}

/**
 * Persisted run-record shapes. ONE producer: src/core/run-store.ts — the hub reads it directly, and
 * the desktop window is a client of a hub, so there is no second reader and no hand-mirror of these
 * structs (pinned by `src/wire.test.ts`).
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface RunRecord {
  taskId: string;
  completed: boolean;
  exitReason: string;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
  /** API-price estimate for a run that reported no cost (a subscription run is not billed per token); never a billed figure. */
  estCostUsd?: number;
  cacheEfficiency?: number;
  durationMs?: number;
  model?: string;
  /** The model the stage asked for (alias or pin), when the writer was given one; `model` is what
   *  the provider served. Absent when the stage pinned nothing. */
  requestedModel?: string;
  timestamp: string;
  stage?: string;
  prUrl?: string;
  /** The CI run (GitHub Actions run / GitLab pipeline) this record was written in. Absent ⇒ a local run. */
  ciUrl?: string;
  /** The sandbox image's content digest/ID (DockerSandboxProvider.imageDigest), so a run can be
   *  traced back to the exact image it executed against — pulled from GHCR or built locally. */
  imageDigest?: string;
  /** Why no `.diff` / `.bundle` / transcript sit next to this record (see core run-store.ts). */
  diffOmitted?: 'secret-blocked' | 'secret-scan' | 'not-scanned';
  /** Hub login (or `token`) that started the run from the hub; absent for CLI/CI runs. */
  startedBy?: string;
  /** `'watch'` when a `taskcell watch` worker started the run; absent for every other run. */
  trigger?: 'watch';
  /** Verdict-bearing stages (reviewer, conformance) only: the merge gate's own reading of this
   *  stage's reply, persisted so the hub and the PR body never re-derive it. */
  verdict?: ReviewVerdict;
  /** The `<findings>` block this stage emitted (the shape the repair gate consumes). Absent when
   *  the stage emitted none, and withheld entirely when `diffOmitted` is set. */
  findings?: Finding[];
  /** The branch the run's PR targets. Absent on records written before the target branch was recorded. */
  baseBranch?: string;
  /** Gate-config files (test/lint/type-check config) the run's delivered diff changed; absent when none. */
  configPaths?: string[];
  /** The run delivered nothing (an empty diff); absent otherwise. */
  noChanges?: true;
  /** The run's gate-repair cap (`--max-repair-iterations`); absent on older records (the default cap applies). */
  maxRepairIterations?: number;
  /** Agent calls folded into this stage (auto-resumes and gate repairs); absent when the stage ran once. */
  attempts?: number;
  /** Ids of the lessons injected into this run's prompts (`taskcell lessons list` counts them). */
  lessonIds?: string[];
  /** The run's own structured flag that this stage ended on a provider rate/usage limit (core RunResult.stoppedBy). */
  stoppedBy?: 'provider-limit';
  /** The provider/model this stage ran on and why (`pick`: config | rotation | skip-limit | fallback | label | flow); `skipped` lists the entries passed over because they were out of quota. */
  modelPick?: { provider: string; model?: string; pick: string; skipped?: Array<{ entry: string; until?: string }> };
  /** Why the primary provider's auth was refused and the stage ran on the fallback instead. */
  primaryAuthRefused?: string;
  /** Which kind of credential funded the run (hub per-user credentials); never the value. Absent on CLI/CI runs. */
  credentialSource?: 'instance' | 'user';
  /** The user-given name of the stored credential that funded the run; never the value. Absent when none was used. */
  credentialName?: string;
  /**
   * `named`: the skills named by hand that the run loaded. `available`: the other installed skills the
   * agent could pick from (not what it used). `notes`: an ignored `Skills:` line, or a provider that
   * reads no skills. Absent on older records.
   */
  skills?: { named: string[]; available: string[]; notes?: string[] };
  /** Installed skills the stage's agent used, from its `run_complete` metric line (`read_run` joins it in); `[]` = none.
   *  Absent on older runs and when the stage's transcript was withheld. */
  skillsUsed?: string[];
}

export interface Proof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
}

export interface VisualProofArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface VisualProof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
  artifacts: VisualProofArtifact[];
}

/** One thing the caller may do; `reason` says why not when `allowed` is false. */
export interface CallerCapability {
  allowed: boolean;
  reason?: string;
}

/** What the caller may do on the hub (`caller_capabilities`), and, when asked about a repository, on that project. */
export interface CallerCapabilities {
  /** The hub accepts remote writes (false on a non-loopback bind without TASKCELL_HUB_ALLOW_ADD=1). */
  mutationsAllowed: boolean;
  mutationsReason?: string;
  owner: boolean;
  /** Hub owner, hub admin or credentials admin. */
  admin: boolean;
  /** Owner (add or clone) or hub admin (clone only: the picker opens in clone-only mode). */
  canAddProject: CallerCapability;
  /** The caller's role per team id (owner: admin of every team); a team the caller is not in is absent. */
  teamRoles: Record<string, TeamRole>;
  project?: {
    /** The caller's best role in a team holding the project; the owner is an admin. */
    teamRole: TeamRole | null;
    canReply: CallerCapability;
    /** Hub-wide ability to merge; a PR the hub refuses by itself carries `mergeBlocked`. */
    canMerge: CallerCapability;
    canEnableFactory: CallerCapability;
    /** Create a tracker task (`api_create_task`): the draft's Create task and the starter task. */
    canCreateTask: CallerCapability;
    /** Start a task or retry a paused one (`start_task`, `retry_paused_task`). */
    canStartTask: CallerCapability;
    /** Change the project's settings (`write_app_config`) or approver mode (`set_approver_mode`). */
    canChangeSettings: CallerCapability;
    /** Owner only, like `update_skill_pr`. */
    canUpdateSkill: CallerCapability;
    /** Add or remove a skill. */
    canEditSkills: CallerCapability;
  };
}

/** Which repository an item of an all-repositories list belongs to. */
export interface RepoStamp {
  repoPath: string;
  repoName: string;
}

/** A repository an all-repositories list could not read (tracker down, bad config); the rest are still listed. */
export interface RepoReadFailure extends RepoStamp {
  error: string;
}

export interface RunSummary {
  taskId: string;
  timestamp: string;
  stages: string[];
  totalCostUsd: number;
  anyFailed: boolean;
  prUrl?: string;
  ciUrl?: string;
  /** Hub login (or `token`) that started the run; absent for runs not started from the hub. */
  startedBy?: string;
  /** `'watch'` when a `taskcell watch` worker started the run. */
  trigger?: 'watch';
  /** `'merged'` when the run's card is done (its pull request merged); set by the hub's list commands, absent when unknown or not merged. */
  prState?: 'merged';
  /** The run's card is done without a pull request (a hub card's local branch): the run passed, or its agent stopped to ask
   *  and the card moved on, so it waits on no answer; set by the hub's list commands. */
  cardDone?: true;
  /** `'ci'` for a run known only from the metrics branch (no local record to open); `prUrl` links its PR/MR. */
  source?: 'ci';
  /** `'provider-limit'` when the run ended on a provider usage or rate limit: not a failure of the change. */
  stoppedBy?: 'provider-limit';
  /** The run's metrics carry no cost data, so `totalCostUsd` (0) is not a cost: show "unknown", not $0. */
  costUnknown?: true;
  /** Sum of the run's API-price estimates (see RunRecord.estCostUsd); shown as `≈`, next to the reported cost when some stages have one. */
  estCostUsd?: number;
  /** Some entries without a reported cost have no estimate either (an unpriced model): the `≈` figure covers only the priced ones. On a run row it can be set with no `estCostUsd` (nothing priced). */
  estPartial?: true;
  /** Extra agent calls the run's stages folded in (`RunRecord.attempts` − 1, summed); absent when every stage ran once. Not a repair count:
   *  the records fold gate repairs, auto-resumes and fork variants into one `attempts` and do not tell them apart. */
  extraAttempts?: number;
  /** The stage of the run's first record that did not complete; absent when every stage completed. */
  failedStage?: string;
  /** The run's own proof says its verify command failed. */
  verifyFailed?: true;
  /** The run's own proof says its verify command passed. */
  verifyPassed?: true;
  /** The run's outcome (state word and place on the line), set by the hub's list commands once it knows the card is done. */
  outcome?: RunOutcome;
  /** The implementer stopped on its own before finishing (`exitReason: 'incomplete'`): the end of its last reply, which
   *  holds what it asks the person. Untrusted agent text, render as plain text. */
  asked?: string;
  /** Set when the run's implementer ran on a fallback entry (`pick` skip-limit | fallback): the entry it used and the entries it passed over (`entry until`). */
  ranOn?: { entry: string; pick: string; skipped?: string[] };
}

/** Period a cost breakdown covers: the last 7 / 30 days, or everything on the branch. */
export type CostPeriod = '7d' | '30d' | 'all';

/** One row of a cost breakdown (a model or a stage). */
export interface CostRow {
  key: string;
  entries: number;
  costUsd: number;
  /** Entries without cost data (counted in `entries`, add nothing to `costUsd`). */
  unknownEntries: number;
  /** API-price estimate of the entries without a reported cost; absent when none. */
  estCostUsd?: number;
  /** Some entries without a reported cost have no estimate either (an unpriced model): the `≈` figure covers only the priced ones. */
  estPartial?: true;
}

/**
 * A project's CI run cost from its metrics branch (the data `taskcell stats --branch` reads).
 * `no-branch`: the repo has no metrics branch yet (`hint` says how to set it up).
 * `costKind`: `estimated` (token usage priced at API rates; on a subscription nothing is billed per
 * token), `billed` (every costed record says so), `mixed`, or `unknown` (no record carries cost data).
 */
export interface CostBreakdown {
  status: 'ok' | 'no-branch';
  branch: string;
  period: CostPeriod;
  hint?: string;
  costKind: 'estimated' | 'billed' | 'mixed' | 'unknown';
  runs: number;
  totalCostUsd: number;
  unknownEntries: number;
  /** Estimated (≈) cost of the entries without a reported cost; absent when none. */
  totalEstCostUsd?: number;
  /** Some entries without a reported cost have no estimate either (an unpriced model): the `≈` figure covers only the priced ones. */
  estPartial?: true;
  byModel: CostRow[];
  byStage: CostRow[];
}

/** Period an approver scorecard covers: the last 30 / 90 days, or everything on the metrics branch. */
export type ApproverPeriod = '30d' | '90d' | 'all';

/** The approver's mode on the base branch: `off` (disabled or no policy), `shadow` (judges, never merges), `act` (merges its APPROVEs). */
export type ApproverMode = 'off' | 'shadow' | 'act';

/** One risk class of the scorecard: APPROVE verdicts that were right, and the current run of right ones. */
export interface ApproverClassRow {
  riskClass: string;
  approveTotal: number;
  approveCorrect: number;
  streak: number;
}

/**
 * The approver's shadow scorecard for a project over a period, from the metrics branch's decisions.jsonl and
 * GitHub PR state (the numbers `taskcell stats --approver` prints). `no-data`: no metrics branch, no
 * decisions, or none in the period (`hint` says which) — never zeros that look like data.
 * `approvesRight`: merged unchanged and not reverted. `approvesWrong`: merged after changes, closed or reverted.
 * `approvesPending`: no human outcome yet. `barMet`: some risk class has `threshold` correct APPROVEs in a row.
 * `actOffered`: false while the act switch must not be offered (see ACT_BLOCKING_ISSUES in src/hub/approver-card.ts).
 */
export interface ApproverScorecard {
  status: 'ok' | 'no-data';
  period: ApproverPeriod;
  hint?: string;
  mode: ApproverMode;
  /** False when `.taskcell/approver.json` is missing or unreadable on the base branch (mode is then `off`). */
  policyFound: boolean;
  actOffered: boolean;
  /** Why act is refused for this repo's policy, to show beside the switch; empty or absent when nothing holds it. */
  actHold?: string;
  threshold: number;
  judged: number;
  approves: number;
  escalates: number;
  approvesRight: number;
  approvesWrong: number;
  approvesPending: number;
  barMet: boolean;
  byRiskClass: ApproverClassRow[];
  topReasons: { reason: string; count: number }[];
}

/** What the approver decided for one PR: `merged` it did, `would-merge` it APPROVEd in shadow mode, `left` it escalated to a human. */
export interface ApproverPrDecision {
  prNumber: number;
  outcome: 'merged' | 'would-merge' | 'left';
  /** The rule ids that fired (empty for an APPROVE). */
  reasons: string[];
}

export interface ApproverModeChange {
  branch: string;
  prUrl: string;
  mode: ApproverMode;
}

export interface StageDetail {
  record: RunRecord;
  diff?: string;
  /** CI config paths (`workflowPaths()` in src/core/taskcell.ts) the stage's diff touches; empty when none, absent with no diff. */
  ciConfigPaths?: string[];
  transcript?: string;
}

export interface RunDetail {
  taskId: string;
  timestamp: string;
  stages: StageDetail[];
  proof?: Proof;
  visualProof?: VisualProof;
  /** Addresses in the Git host, computed by the server; each absent when unknown. */
  prUrl?: string;
  /** The pull/merge request's diff page ("Files changed" / "Changes"). */
  diffUrl?: string;
  ciUrl?: string;
  /** The outcome the run's Runs row shows (one derivation, src/hub/card-view.ts); set by the hub's `read_run`. */
  outcome?: RunOutcome;
}

/** A CI run, as returned by `gh run list` (src/hub/remote.ts) / Tauri's `list_remote_runs`. */
export interface RemoteRun {
  id: number;
  status: string;
  conclusion: string;
  title: string;
  branch: string;
  workflow: string;
  createdAt: string;
  event: string;
  url: string;
  /** The run's record artifact is already in the local cache (opens without `gh`). */
  cached: boolean;
}

/** A CI run's downloaded `vanguard-runs` artifact imported by `import_remote_run` / `importRemoteRun`. */
export interface RemoteImport {
  runId: number;
  taskIds: string[];
  runs: RunSummary[];
  cachedAt: string;
}

/**
 * Where one run's records live, resolved to a root by the hub that answers `read_run`: the
 * project's own run records, or an imported CI run under
 * `<project>/.taskcell/remote-runs/<runId>` (`src/hub/runs.ts`). The UI never sees either root: it
 * only carries this discriminant (see `RunRef`).
 */
export type RunSource = { kind: 'local' } | { kind: 'ci'; runId: number };

/** Identifies one run record to open: which source tree, and which task/timestamp within it. */
export interface RunRef {
  source: RunSource;
  taskId: string;
  timestamp: string;
}

export type TeamRole = 'admin' | 'member';

export interface TeamMember {
  login: string;
  role: TeamRole;
}

/** What a hub audit line records (src/hub/audit.ts). */
export type AuditAction =
  | 'sign-in'
  | 'project-add'
  | 'project-remove'
  | 'clone'
  | 'run-start'
  | 'run-queue'
  | 'run-cancel'
  | 'task-start'
  | 'task-retry'
  | 'settings-change'
  | 'needs-reply'
  | 'needs-merge'
  | 'pr-rereview'
  | 'task-create'
  | 'task-edit'
  | 'task-schedule'
  | 'enable-factory'
  | 'approver-mode'
  | 'team-member-add'
  | 'team-member-remove'
  | 'team-repository-add'
  | 'team-repository-remove'
  | 'team-fallback-set'
  | 'labels-migrate'
  | 'project-watch'
  | 'project-unwatch'
  | 'push-register'
  | 'push-unregister';
export type AuditOutcome = 'ok' | 'refused' | 'failed';

/** One saved change to a repository's settings, as the Line screen's history shows it: no actor, subject or chain fields. */
export interface SettingsHistoryEntry {
  time: string;
  login: string;
  outcome: AuditOutcome;
  /** `app.json` top-level key names that changed (never values); empty for a flow file. */
  detail: string[];
  /** The repository path, or `<repo>:<file>.hcl` for a flow file. */
  target: string;
  /** Old and new values of the changed keys on the non-secret allowlist (src/hub/audit.ts `SETTINGS_VALUE_KEYS`); absent on older lines. */
  changes?: SettingsValueChange[];
}

/** One allowlisted, non-secret `app.json` value before and after a save; an absent side was unset. */
export interface SettingsValueChange {
  key: string;
  from?: string;
  to?: string;
}

/** Models offered in Settings → Doc chat model before any fetch (Claude ids the doc chat accepts). Free text stays possible. */
export const CHAT_MODELS: readonly string[] = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5'];

/**
 * `list_chat_models`: what the repository's saved doc-chat endpoint or provider offers. `static` is {@link CHAT_MODELS};
 * `origin` names where the list came from. `error` is a short safe reason (never a response body or a key); `models` is then empty.
 */
export interface ChatModelList {
  source: 'openrouter' | 'endpoint' | 'static';
  origin?: string;
  models: string[];
  error?: string;
}

/** One line of Home's activity feed (`list_activity`): built from run records and the hub audit log, never from a tracker read. */
export interface ActivityEvent {
  time: string;
  /** `run-started` and `card-created`, `pr-merged`, `settings-changed` come from the hub's audit log (actions taken in the hub); the run outcomes from run records (`run-asked`: its agent stopped to ask). */
  kind: 'run-started' | 'run-finished' | 'run-failed' | 'run-asked' | 'card-created' | 'pr-merged' | 'settings-changed';
  repoPath: string;
  repoName: string;
  /** The hub login that acted (or `token`); absent when the record names nobody. */
  login?: string;
  /** A run's task id, or the merged item (`#12`). */
  subject?: string;
  /** `settings-changed`: the app.json key names, never values. */
  keys?: string[];
}

/** One line of `audit.jsonl`. `login` is a GitHub login, or `token` for header access. */
export interface AuditEntry {
  time: string;
  login: string;
  action: AuditAction;
  /** Project path, run id or setting name — never a value. */
  target?: string;
  outcome: AuditOutcome;
  /** Names only, e.g. the settings keys a change touched. */
  detail?: string[];
  /** `settings-change` of `app.json` only: values of the changed keys on the non-secret allowlist, never any other key's. */
  changes?: SettingsValueChange[];
  /** Who acted and on what (src/core/audit.ts); with `prev`/`hash` it is one link of the tamper-evident chain. */
  actor?: { kind: 'user' | 'local' | 'token' | 'bot'; id?: string; name?: string };
  subject?: { repo?: string; issue?: number; pr?: number; runId?: string };
  prev?: string;
  hash?: string;
}

/** Per-issue history (src/core/history.ts, docs/audit.md). */
export type HistoryKind =
  | 'label'
  | 'spec'
  | 'run-start'
  | 'stage'
  | 'run-end'
  | 'review'
  | 'revision'
  | 'approver'
  | 'merge'
  | 'close'
  | 'hub'
  | 'comment';

/** `verified`: a hashed line of a chain that checked out. `failed`: its chain did not verify. `none`: no chain (run records, Git host). */
export type HistoryChain = 'verified' | 'failed' | 'none';

export interface HistoryEntry {
  time: string;
  kind: HistoryKind;
  /** Undefined when the source does not say who. */
  actor?: NonNullable<AuditEntry['actor']>;
  what: string;
  /** Where it came from: the stream (or `run-record`, `github`), a stable ref into it, and a link when one exists. */
  source: { stream: string; ref: string; url?: string };
  chain: HistoryChain;
}

export interface ChainStatus {
  /** The stream: `hub`, `decisions`, `run-events`. */
  stream: string;
  /** The chain read: the stream, or one run's log for run-events. */
  name: string;
  ok: boolean;
  records: number;
  /** Unchained lines written before the chain began (tolerated, but not verified). */
  legacy: number;
  torn: number;
  problems: { file: string; line: number; reason: string }[];
}

export interface IssueHistory {
  repo: string;
  issue: number;
  prs: number[];
  /** Oldest first. */
  entries: HistoryEntry[];
  chains: ChainStatus[];
  /** Sources that could not be read; the history is incomplete without them. */
  unavailable: string[];
}


/** A hub team (src/hub/teams.ts). `repositories` are project paths. */
export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  repositories: string[];
  /** Fallback chain every project of the team without its own `fallbackChain` uses; absent = none. */
  fallbackChain?: FallbackEntry[];
}

/**
 * Hand-mirrors of RUST serde structs in src-tauri (the persisted/aggregated shapes) — a TS seam
 * cannot pin these to Rust, so they live here only because the `Commands` catalogue below needs a
 * result type for every command; keep them in sync with src-tauri by hand.
 */
export interface Project {
  path: string;
  name: string;
  runCount: number;
  taskCount: number;
  totalCostUsd: number;
  failedCount: number;
  /** Of the runs, those whose agent stopped to ask (not counted in `failedCount`). Absent when none. */
  askedCount?: number;
  lastRun?: string | null;
  runningCount: number;
  runsLast24h: number;
  /** Of `runCount`, the runs known only from the metrics branch (CI). */
  ciRunCount?: number;
  color?: string | null;
  /** Where this project's tasks come from (`app.json` `taskSource`); unset = GitHub Issues. */
  taskSource?: TaskSourceId | null;
  /** Where this project's work runs (`app.json` `runLocation`); unset = GitHub Actions. */
  runLocation?: RunLocationId | null;
}

/** Per-project task source: GitHub Issues, GitHub Projects v2, GitLab Issues, Linear or the hub board. */
export type TaskSourceId = 'github' | 'github-project' | 'gitlab' | 'linear' | 'hub';
/** Per-project run location: GitHub Actions, GitLab CI, the user's own server (`watch`) or the local hub. */
export type RunLocationId = 'github-actions' | 'gitlab-ci' | 'watch' | 'local';

export interface ActiveRun {
  taskId: string;
  sessionFile: string;
  lastActivityMs: number;
}

export interface TranscriptEntry {
  role: 'assistant' | 'tool';
  text: string;
}

export interface SessionRead {
  entries: TranscriptEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Live spend estimate in USD (priced per-message off each message's model; unknown models add
   * nothing, so it's a lower bound — show as "~$"). */
  estCostUsd: number;
}

/** Every field is nullable, not just optional: Rust's emit-all serde writes `null` for an absent
 * `Option`, and a hand-edited `app.json` may spell a default that way too. */
export interface AppConfig {
  source?: string | null;
  /** Per-project task source (see `TaskSourceId`); unset = GitHub Issues. */
  taskSource?: string | null;
  /** Per-project run location (see `RunLocationId`); unset = GitHub Actions. */
  runLocation?: string | null;
  label?: string | null;
  team?: string | null;
  color?: string | null;
  provider?: string | null;
  reviewProvider?: string | null;
  /** Flow the Hub runs this project with: a built-in or `.taskcell/flows/<name>.hcl`; unset = the standard flow. */
  flow?: string | null;
  verifyCmd?: string | null;
  concurrency?: number | null;
  budgetUsd?: number | null;
  /** Stop starting tasks/stages at this % (1-100) of the provider's plan window; unset = no cap. */
  usageCapPct?: number | null;
  runCommand?: string | null;
  /** Doc-editor chat model (Subsystem 3), e.g. `claude-sonnet-5`. Non-secret; key is env-only. */
  chatModel?: string | null;
  chatBaseUrl?: string | null;
  /** Repository default target branch for pull requests; unset = `main`. */
  baseBranch?: string | null;
  /** Extra branches a card's `taskcell:base=` label may select, besides the default. Unset = only the default. */
  baseBranches?: string[] | null;
  /** Ordered providers/models a run moves to on a provider limit, after `provider` (the Engine). Absent = the team default; `[]` = none. */
  fallbackChain?: FallbackEntry[] | null;
  /** Opaque JSON preserved by Rust and the hub, including invalid entries and unknown keys — see
   * `CustomProviderSpec` for the shape a valid entry has. */
  customProviders?: unknown;
}

/** One fallback chain entry: a provider and, optionally, a model (empty = that provider's default). */
export interface FallbackEntry {
  provider: string;
  model?: string;
}

/** The longest fallback chain: bounds the reroute attempts of one run. */
export const FALLBACK_CHAIN_MAX = 8;

const FALLBACK_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FALLBACK_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
/** A provider's transport slot (agents/registry.ts `transport`): codex and cursor own theirs; every other built-in and repo custom drives the claude CLI. */
export const fallbackSlot = (provider: string): string => (provider === 'codex' || provider === 'cursor' ? provider : 'claude-cli');

/**
 * Why a fallback chain cannot be saved: one message per row (`undefined` = fine) and one for the list as a whole.
 * The rules keep `parseFallbackList` / `validateProviderChoice` from ever throwing on a saved chain. `providers`
 * (built-ins plus healthy repo customs) is checked when given. One rule for the hub's `write_app_config` and the form.
 */
export function fallbackChainErrors(chain: unknown, opts: { primary: string; providers?: readonly string[] }): { rows: (string | undefined)[]; list?: string } {
  if (chain === undefined || chain === null) return { rows: [] };
  if (!Array.isArray(chain)) return { rows: [], list: 'The fallback chain must be a list.' };
  const seen = new Set<string>();
  const rows = chain.map((e: unknown): string | undefined => {
    if (typeof e !== 'object' || e === null) return 'Not a provider entry.';
    const { provider, model } = e as { provider?: unknown; model?: unknown };
    if (typeof provider !== 'string' || !FALLBACK_PROVIDER_RE.test(provider)) return 'Pick a provider.';
    if (provider === 'meridian') return 'meridian cannot run on a stored credential.';
    if (opts.providers !== undefined && !opts.providers.includes(provider)) return `Unknown provider "${provider}".`;
    if (model !== undefined && model !== null && model !== '' && (typeof model !== 'string' || !FALLBACK_MODEL_RE.test(model))) return 'Invalid model name.';
    const m = typeof model === 'string' ? model : '';
    if (provider === opts.primary && m === '') return 'This is the Engine itself; pick another provider or add a model.';
    const key = `${provider}/${m}`;
    if (seen.has(key)) return 'Already in the chain.';
    seen.add(key);
    return undefined;
  });
  // A lone entry is the Engine's in-run fallback, which cannot share its transport slot (claude → zai); a team default has no Engine yet.
  const lone = chain.length === 1 && rows[0] === undefined ? (chain[0] as FallbackEntry).provider : undefined;
  const single = lone !== undefined && opts.primary !== '' && fallbackSlot(lone) === fallbackSlot(opts.primary);
  const list = chain.length > FALLBACK_CHAIN_MAX ? `A fallback chain holds at most ${FALLBACK_CHAIN_MAX} entries.` : single ? "A single entry on the Engine's own provider or transport (e.g. claude → zai) cannot take over; add a second entry or pick another provider." : undefined;
  return { rows, ...(list !== undefined ? { list } : {}) };
}

/** The first message of {@link fallbackChainErrors}, or undefined when the chain can be saved. */
export function firstFallbackChainError(chain: unknown, opts: { primary: string; providers?: readonly string[] }): string | undefined {
  const { rows, list } = fallbackChainErrors(chain, opts);
  return list ?? rows.find((r) => r !== undefined);
}

/** What the board answers for a project with no task source chosen: a setup step, not a failure (the app shows it as a hint). */
export const NO_TASK_SOURCE_MESSAGE = 'Set a Task Source in Settings to load the board.';

/** The hub's refusal (400) for a GitHub/GitLab operation on a repository with no git remote. Shared so the app can tell it from a failure. */
export const NO_REMOTE_MESSAGE = 'This repository has no git remote. Add one (git remote add origin <url>) and push, then try again.';

/** The numeric `AppConfig` fields that are out of range, each as a sentence naming the field and its
 * range (unset/null is always valid). One rule for the hub's `write_app_config` and the Settings form. */
export function appConfigRangeErrors(cfg: AppConfig): { concurrency?: string; budgetUsd?: string; usageCapPct?: string } {
  // A hand-edited file may hold a number as a string ("2"): it counts as that number, as the form shows it.
  const check = (label: string, v: unknown, ok: (n: number) => boolean, range: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    return ok(n) ? undefined : `${label} ${range}`;
  };
  const concurrency = check('Parallel runs', cfg.concurrency, (n) => Number.isInteger(n) && n >= 1, 'must be a whole number, 1 or more.');
  const budgetUsd = check('Budget cap per Run', cfg.budgetUsd, (n) => n >= 0, 'must be 0 or more (leave it empty for no cap).');
  const usageCapPct = check('Usage cap %', cfg.usageCapPct, (n) => n >= 1 && n <= 100, 'must be from 1 to 100 (leave it empty for no cap).');
  return {
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(usageCapPct !== undefined ? { usageCapPct } : {}),
  };
}

/** Hub-only (src/hub/browse.ts) — one subdirectory offered by `browse_dirs`, standing in for the
 * native folder dialog Tauri doesn't have in a browser. */
export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasTaskcell: boolean;
}

/** Hub-only (src/hub/browse.ts) — one `browse_dirs` page: the listed directory plus its children. */
export interface DirListing {
  path: string;
  parent?: string;
  isGitRepo?: boolean;
  entries: DirEntry[];
}

/** What `retry_paused_task` did: the trigger label re-applied. */
export interface RetryPausedResult {
  label: string;
}

/** What `start_task` did (src/hub/start-task.ts). `waitingOn` names the unmet dependencies (`owner/repo#N`) of a dependency-parked issue. */
export interface StartTaskResult {
  status: 'labelled' | 'retried';
  label: string;
  waitingOn: string[];
}

/**
 * One GitHub issue/PR waiting for a human (Hub "Needs you" — hub-only, src/hub/needs-you.ts): an
 * issue at `needs info`, or a PR at `taskcell:needs-human-review`/`taskcell:verify-failed` or with a
 * review requesting changes.
 */
export interface NeedsYouItem {
  /** `owner/repo#number` — also the id a reply targets. A `card`: the card id (`hub-4`, `gh-27`). */
  id: string;
  /** `card`: a card whose newest run's agent stopped to ask (from run records, not the tracker); `lastComment` holds its question. */
  kind: 'issue' | 'pr' | 'card';
  number: number;
  repoSlug: string;
  title: string;
  url: string;
  /** Why this item waits: the label name, or `'changes requested'` for a PR review verdict. */
  reason: string;
  /** A PR's base (target) branch, which a merge lands on. Absent for an issue. */
  baseRef?: string;
  /** The factory's own last comment, redacted; untrusted, render as plain text. Absent when it never commented. */
  lastComment?: { author: string; body: string };
  /** The branch the PR targets (a PR's base), or the one the card asks for (`taskcell:base=`). Absent when unknown. */
  baseBranch?: string;
  /** Why the hub refuses to merge this PR (set only when it would); the UI shows it instead of offering Merge. */
  mergeBlocked?: string;
  /** An issue or a card: `'too-vague'` when the factory's last comment is triage's too-vague notice, otherwise `'question'` (also when the comment was not fetched). */
  ask?: 'question' | 'too-vague';
  /** When the issue/PR last changed (ISO 8601, from the tracker); the phone shows it as an age. Absent for a card or when unknown. */
  updatedAt?: string;
}

/** A Fleet-screen spawned process (Fleet is enabled only on the desktop app's local hub). */
export interface SpawnInfo {
  pid: number;
  cwd: string;
  command: string;
}

/** Enable-factory provider seam (hub § "Enable factory"): GitHub Actions and GitLab CI are
 * implemented; Linear is "planned" in the UI and never reaches `enable_factory_*` (see
 * docs/onboarding-linear.md). */
export type FactoryProviderId = 'github' | 'gitlab' | 'linear';

/** What `enable_factory_plan` detected and what `enable_factory_apply` will do with it. */
export interface FactoryPlan {
  provider: 'github' | 'gitlab';
  /** `owner/repo` (GitHub) or the `group/subgroup/project` path (GitLab). */
  repoSlug: string;
  defaultBranch: string;
  login: string;
  packageManager: string;
  verifyCommand?: string;
  scripts: { typecheck: boolean; lint: boolean; test: boolean; build: boolean };
  /** Repo-relative paths `apply` will add or edit, e.g. `.github/workflows/taskcell-implement.yml` (GitLab: `.gitlab-ci.yml`, `.gitlab/taskcell.yml`). */
  callerFiles: string[];
  /** The callers already on the default branch, under the `taskcell-` or legacy `vanguard-` name — `apply` leaves those untouched. */
  existingCallerFiles?: string[];
  /** GitLab host selected from `origin`; passed to glab so a self-hosted project cannot fall back to another configured host. */
  gitlabHost?: string;
  /** Numeric GitLab project id; open-MR reuse requires the source project to match it, excluding fork MRs. */
  gitlabProjectId?: number;
  /** GitLab's configured CI entry point. The hub only edits the default `.gitlab-ci.yml`. */
  gitlabCiPath?: string;
  /** The CI entry point cannot be edited safely; the user must add the displayed local include. */
  gitlabManualInclude?: boolean;
  /** Runner tags written under `.taskcell-base` (`tags:`); pre-filled from the project's `default: tags`, editable, empty = no `tags:` key. */
  gitlabRunnerTags?: string[];
  /** Why `gitlabRunnerTags` starts empty: the project's `default: tags` could not be copied (e.g. a `!reference`). */
  gitlabRunnerTagsNote?: string;
  /** Top-level GitLab jobs without `rules:`; starting the doctor requires an explicit UI confirmation when non-empty. */
  gitlabUnruledJobs?: string[];
  labels: string[];
}

export interface FactoryApplyResult {
  branch: string;
  /** The pull request (GitLab: merge request) URL. */
  prUrl: string;
  labelsCreated: string[];
}

/** The secret-setup step's result: command text only — never a value, never executed by the hub. */
export interface FactorySecretStep {
  secretName: string;
  command: string;
}

export interface FactoryVerifyResult {
  dispatched: boolean;
  run?: { url: string; status: string; conclusion: string };
}

/** Which code host a project's `origin` is on, for the Enable factory dialog's run-location choice. */
export type FactoryHost = 'github' | 'gitlab' | 'other' | 'none';

/** The "Self-hosted (watch)" checklist for a repository. Names only: no credential value is ever included. */
export interface WatchWorkerChecklist {
  /** `owner/repo` or `group/project`; empty for a Linear worker whose origin names none. */
  repoSlug: string;
  source: 'github' | 'gitlab' | 'linear';
  /** Compose service for the user to run on their own machine; the hub starts nothing. */
  compose: string;
  /** The same worker as a `taskcell watch` command run from a clone of the repo. */
  command: string;
  credentials: string[];
  /** Whether run records show a watch worker at work: `unknown` = no watch-started record the hub can read, so it cannot tell. */
  seen: 'recent' | 'stale' | 'unknown';
  /** Time of the newest watch-started run record the hub could read, when any. */
  lastRunAt?: string;
}

/** The "Local hub" run location for a repository: the hub's built-in worker (src/hub/local-worker.ts). Names only: no credential value is included. */
export interface LocalWorkerState {
  /** The per-project switch; off by default. */
  enabled: boolean;
  /** The task source the worker reads, when it can serve this project; absent when it cannot (see `blocked`). */
  source?: 'github' | 'hub';
  /** Why the switch cannot be turned on, in one sentence; absent when it can. */
  blocked?: string;
  /** Credential names that would fund a run (any one is enough); `present` says whether the hub has one. */
  credentials: { names: string[]; present: boolean };
  /** The doctor checks run on this machine: when, whether they passed and the failing checks. Absent = not run yet. */
  doctor?: { at: string; ok: boolean; failed: string[] };
  /** Newest pick-up: when and what (an issue `#n` or hub task ids). */
  lastPickupAt?: string;
  lastPickup?: string;
  /** Newest pick-up error; cleared by the next successful pick-up. */
  lastError?: string;
}

/** The four steps of the in-app Enable factory checklist, in order. */
export type FactoryStepId = 'pr' | 'secret' | 'merged' | 'doctor';

export interface FactoryStep {
  id: FactoryStepId;
  status: 'done' | 'current' | 'pending' | 'failed';
}

/** A project's factory checklist as shown by the dialog and the project card. `none` = never
 * started; `setting-up` carries the current `step`; `broken` carries the `reason`. Persisted per
 * project (`factory.json` in the state dir) so progress survives the dialog and a hub restart. */
export interface FactoryState {
  state: 'none' | 'setting-up' | 'ready' | 'broken';
  /** The first step not yet done; absent when `none` or `ready`. */
  step?: FactoryStepId;
  reason?: string;
  steps: FactoryStep[];
  plan?: FactoryPlan;
  prUrl?: string;
  secret?: FactorySecretStep;
  doctor?: { url: string; status: string; conclusion: string };
  /** The doctor was dispatched but its run is not listed yet. */
  doctorPending?: boolean;
}

/**
 * Allowlisted fields for `api_complete`'s `req` (S3/Editor UX 7/7). Deliberately NOT
 * `Omit<CompleteRequest, 'baseUrl' | 'assetRoot'>`: every field here is one the renderer is
 * permitted to send across the webview boundary. A new `CompleteRequest` field must be added HERE
 * to cross that boundary — a denylist (Omit) would auto-expose it instead (review #342).
 */
export interface CompleteCallArgs {
  system?: CompleteRequest['system'];
  messages: CompleteRequest['messages'];
  model: string;
  attachments?: CompleteRequest['attachments'];
}

/** One agent CLI in the local sandbox image: installed vs latest (src/sandbox/cli-versions.ts). */
export interface CliVersionInfo {
  name: 'claude' | 'codex' | 'cursor';
  installed?: string;
  latest?: string;
  /** Newest version past the 3-day soak, when it is newer than the installed one: what the next bump PR would pin. Nothing installs it. */
  target?: string;
  publishedAt?: string;
  changelog: string;
  outdated: boolean;
  /** Outdated and a soaked, verifiable newer version exists — a bump candidate. Report only: `doctor --fix` installs the repo pin, not `target`. */
  updatable: boolean;
  reason?: string;
}
/** Base-merge (conflict) rollup from the `base_merge` metric lines: per week, plus the most-conflicted files. */
export interface ConflictStats {
  weeks: Array<{ week: string; merges: number; conflicts: number; autoResolved: number; leftForHuman: number }>;
  total: { merges: number; conflicts: number; autoResolved: number; leftForHuman: number };
  topFiles: Array<{ file: string; conflicts: number }>;
}

export interface CliVersionReport {
  enabled: boolean;
  clis: CliVersionInfo[];
}

/** First-run setup detection (hub only): what the hub host can see, never a secret value. */
export type SetupToolState = 'ready' | 'needs-login' | 'missing';
export interface SetupToolStatus {
  id: 'gh' | 'glab' | 'linear';
  state: SetupToolState;
}
export interface SetupStatus {
  tools: SetupToolStatus[];
  /** Whether a model credential is already present for each provider (a boolean, not the value).
   * A credential a hub run can use: for Codex `CODEX_AUTH_JSON`, `CODEX_API_KEY` or `OPENAI_API_KEY`, or one saved in Settings → Credentials. */
  models: { claude: boolean; codex: boolean };
  /** `codex login` left its auth file on the hub's machine. A run does not read it: it becomes usable as `CODEX_AUTH_JSON`. */
  codexSignInFile?: boolean;
  /** A value-free reason saved instance credentials could not be loaded or migrated. */
  credentialReason?: string;
}

/** The admin `per-user credentials` switch: off, user's own first then the instance's, or user's own only. */
export type CredentialPolicy = 'off' | 'user-first' | 'user-only';

/** A stored provider credential's kind: a subscription token, an API key, or a gateway auth token. */
export type AccountType = 'subscription' | 'api-key' | 'auth-token';

/** What any RPC may return about a stored credential: never its value. */
export interface CredentialAccountView {
  id: string;
  provider: string;
  name: string;
  type: AccountType;
  enabled: boolean;
  coolingUntil?: string;
}

/** Named realtime channels the wire carries (`src/hub/rpc.ts`'s `publish`, Rust's `emit_event`).
 * The desktop additionally sees a Rust-minted `run-accepted` `api:event` variant core never emits —
 * that is a desktop extension of `RunEvent`, declared desktop-side (see typedRunReducer.ts), not here. */
/** What `migrate_labels` / `taskcell migrate-labels` did (or would do, in a dry-run). */
export interface MigrateLabelsReport {
  /** `old -> new` pairs renamed (or that would be, in a dry-run). */
  renamed: { from: string; to: string }[];
  /** Old labels left alone because the new name already exists in the repo (both keep working). */
  skipped: { from: string; to: string }[];
  failed: { from: string; reason: string }[];
  dryRun: boolean;
  /** Notices to show before renaming (workflows gating on the old review trigger must accept the new one). */
  warnings: string[];
}

export interface Events {
  'api:event': { runId: string; event: RunEvent };
  'vanguard:changed': string;
  /** Hub-only clone progress. */
  'vanguard:clone-progress': { line: string };
  /** A spawned child's output line / exit (`code` is null when killed by a signal). */
  'spawn:output': { pid: number; line: string };
  'spawn:exit': { pid: number; code: number | null };
}

/**
 * Shared command catalogue for the Tauri, hub and mock adapters: the union of the hub command
 * modules (src/hub/commands/), inlined here by `pnpm gen:wire`.
 */
export interface Commands {
  read_app_config: { args: { repoPath: string }; result: AppConfig };
  read_app_config_strict: { args: { repoPath: string }; result: AppConfig };
  write_app_config: { args: { repoPath: string; config: AppConfig }; result: void };
  /** HUB_ONLY, read-only: the model ids the repository's saved doc-chat endpoint or provider offers (Settings → Fetch models). A key named by `keyEnv` stays on the hub. */
  list_chat_models: { args: { repoPath: string }; result: ChatModelList };
  /** HUB_ONLY, read-only: the approver's scorecard for a project over a period (default `90d`) — PRs judged, APPROVE/ESCALATE counts, right and wrong APPROVEs, the streak per risk class against the bar, the top escalation reasons — plus the current mode from `.taskcell/approver.json` on the base branch. Read from the metrics branch and GitHub PR state like `taskcell stats --approver`; never a model call. */
  read_approver_scorecard: { args: { repoPath: string; period?: ApproverPeriod }; result: ApproverScorecard };
  /** HUB_ONLY, read-only: what the approver decided for each PR on the metrics branch (merged, would merge, left for a human and why); no gh call. */
  read_approver_decisions: { args: { repoPath: string }; result: { decisions: ApproverPrDecision[]; mode: ApproverMode } };
  /** HUB_ONLY: open a pull request that sets `.taskcell/approver.json` to `mode` — never writes the setting itself. `act` is refused while the act switch is not offered, and below the bar unless `confirmBelowBar` is true; the PR body states the 90-day scorecard numbers at that moment (for `off`, a scorecard that cannot be read is left out rather than blocking the change). Only decisions for the project's own repository count. */
  set_approver_mode: { args: { repoPath: string; mode: 'off' | 'shadow' | 'act'; confirmBelowBar?: boolean }; result: ApproverModeChange };
  /** HUB_ONLY, admin-only (403 otherwise): the audit log newest first, optionally for one login. */
  read_audit: { args: { login?: string; limit?: number }; result: AuditEntry[] };
  /** HUB_ONLY, read-only, same gate as read_app_config: the repository's settings saves (app.json key names, flow files), newest first. */
  read_settings_history: { args: { repoPath: string; limit?: number }; result: SettingsHistoryEntry[] };
  /** HUB_ONLY, read-only: Home's activity feed across the team's repositories, newest first, at most 30 (`limit` lowers it).
   *  Run records and the audit log only (settings saves as key names): no tracker read. */
  list_activity: { args: { teamId?: string; limit?: number } | undefined; result: ActivityEvent[] };
  /** HUB_ONLY, read-only: what the caller may do on the hub and, with `repoPath`, on that project. Every `false` carries its reason. */
  caller_capabilities: { args: { repoPath?: string } | undefined; result: CallerCapabilities };
  /** HUB_ONLY, read-only: a project's cost by model and by stage for a period (default `all`), read from the metrics branch like `taskcell stats --branch`; cached, never a model call. A repo without the branch answers `status: 'no-branch'` with a setup hint. */
  read_cost_breakdown: { args: { repoPath: string; period?: CostPeriod }; result: CostBreakdown };
  /** HUB_ONLY, read-only: installed vs latest claude/codex/cursor CLI in the local sandbox image (3-day soak applied; `enabled: false`, and no lookups, when TASKCELL_CLI_VERSION_CHECK is off). Refused on a non-loopback bind without TASKCELL_HUB_ALLOW_ADD. */
  agent_cli_versions: { args: undefined; result: CliVersionReport };
  api_complete: { args: { repoPath: string; req: CompleteCallArgs; callId?: string }; result: CompleteResponse };
  api_cancel_complete: { args: { callId: string }; result: void };
  /** HUB_ONLY, hub owner or admin only (403 otherwise — one gate for the switch and every instance-credential RPC): the `per-user credentials` switch. */
  get_credential_policy: { args: undefined; result: { policy: CredentialPolicy } };
  set_credential_policy: { args: { policy: CredentialPolicy }; result: void };
  /** HUB_ONLY, hub owner or admin only: instance provider credentials. Write-only — status lists names, never values. */
  instance_credentials_status: { args: undefined; result: { names: string[]; reason?: string; accounts: CredentialAccountView[]; termsWarning?: string } };
  /** HUB_ONLY, hub owner or admin only: the instance's Claude and Codex (ChatGPT plan) accounts (up to 20 per provider, tried in list order; a limited one cools until its reset). `value` is required to create and optional to rename or switch one; it is never returned. A second enabled subscription token needs `acknowledgeTerms` (see docs/hub.md). */
  save_instance_account: { args: { id?: string; provider: 'claude' | 'codex'; name: string; type: AccountType; value?: string; enabled?: boolean; acknowledgeTerms?: boolean }; result: { id: string } };
  delete_instance_account: { args: { id: string }; result: void };
  reorder_instance_accounts: { args: { ids: string[]; provider?: 'claude' | 'codex' }; result: void };
  save_instance_credential: { args: { name: string; value: string }; result: void };
  delete_instance_credential: { args: { name: string }; result: void };
  /** HUB_ONLY: the signed-in user's OWN credentials (no RPC takes a user id). Write-only. */
  user_credentials_status: { args: undefined; result: { enabled: boolean; admin: boolean; names: string[]; accounts: CredentialAccountView[]; termsWarning?: string } };
  /** HUB_ONLY: the signed-in user's OWN Claude and Codex accounts. A second enabled subscription token needs `acknowledgeTerms`, as on the instance (see docs/hub.md). */
  save_user_account: { args: { id?: string; provider: 'claude' | 'codex'; name: string; type: AccountType; value?: string; enabled?: boolean; acknowledgeTerms?: boolean }; result: { id: string } };
  delete_user_account: { args: { id: string }; result: void };
  reorder_user_accounts: { args: { ids: string[]; provider?: 'claude' | 'codex' }; result: void };
  save_user_credential: { args: { name: string; value: string }; result: void };
  delete_user_credential: { args: { name: string }; result: void };
  list_drafts: { args: { repoPath: string }; result: string[] };
  read_draft: { args: { repoPath: string; id: string }; result: string };
  write_draft: { args: { repoPath: string; id: string; content: string }; result: void };
  delete_draft: { args: { repoPath: string; id: string }; result: void };
  write_draft_asset: { args: { repoPath: string; id: string; name: string; bytes: number[] }; result: string };
  clear_draft_assets: { args: { repoPath: string; id: string }; result: void };
  /** Which code host the project's `origin` is on (`github`, `gitlab`, `other`, or `none` without a remote): the dialog offers GitLab CI only for `gitlab`. */
  enable_factory_host: { args: { repoPath: string }; result: { host: FactoryHost } };
  /** Read-only checklist for a self-hosted `taskcell watch` worker: compose snippet, command, credential names and whether run records show it working. Starts nothing. */
  enable_factory_watch: { args: { repoPath: string }; result: WatchWorkerChecklist };
  /** HUB_ONLY: read the repo (default branch, package manager, verify command) and report what
   *  `enable_factory_apply` would change — no writes yet. GitHub Actions or GitLab CI (through `glab`);
   *  Linear has no adapter and the UI marks it planned instead of calling this. */
  enable_factory_plan: { args: { repoPath: string; provider: FactoryProviderId }; result: FactoryPlan };
  /** HUB_ONLY: create a branch, add the five caller workflows (GitLab: the include and `.gitlab-ci.yml` edit), open a PR/MR (never push to the default
   *  branch) and create the routing labels. */
  enable_factory_apply: { args: { repoPath: string; plan: FactoryPlan }; result: FactoryApplyResult };
  /** HUB_ONLY: the `gh secret set` (GitLab: `glab variable set`) command text for the user to run themselves — the hub never
   *  reads, prints or stores the secret value. */
  enable_factory_secret: { args: { repoPath: string; plan: FactoryPlan }; result: FactorySecretStep };
  /** HUB_ONLY: dispatch the doctor workflow, or start the doctor pipeline on GitLab (once the PR/MR above is merged) and report the run that dispatch created. */
  enable_factory_verify: { args: { repoPath: string; plan: FactoryPlan; confirmedJobs?: string[] }; result: FactoryVerifyResult };
  /** HUB_ONLY: start (or restart) the project's persisted checklist from a freshly derived plan —
   *  used when the callers are already on the default branch and there is no PR to open. */
  enable_factory_start: { args: { repoPath: string; plan: FactoryPlan }; result: FactoryState };
  /** The project's persisted checklist (callers PR, secret, merge, doctor) — no network. */
  factory_state: { args: { repoPath: string }; result: FactoryState };
  /** Re-check the outstanding steps (secret by name only, PR merged, doctor run status), persist and return the checklist. */
  factory_refresh: { args: { repoPath: string }; result: FactoryState };
  /** The Fleet screen's shell-spawn surface — enabled only on the desktop app's local (loopback) hub,
   * refused elsewhere (remote code execution on a reachable server). `argv[0]` is the program, run
   * WITHOUT a shell: values built from repo config travel as single arguments and can never
   * introduce shell syntax. */
  spawn_run: { args: { cwd: string; argv: string[] }; result: number };
  /** See spawn_run. */
  kill_run: { args: { pid: number }; result: void };
  /** See spawn_run. */
  list_spawns: { args: undefined; result: SpawnInfo[] };
  api_list_flows: { args: { repoPath: string }; result: { flows: RepoFlowInfo[] } };
  api_list_providers: { args: { repoPath: string }; result: { providers: RepoProviderInfo[] } };
  api_read_flow: { args: { repoPath: string; file: string }; result: { doc: FlowDoc; source: string } };
  api_write_flow: { args: { repoPath: string; file: string; doc: FlowDoc }; result: { source: string } };
  api_delete_flow: { args: { repoPath: string; file: string }; result: void };
  /** HUB_ONLY, read-only: one issue's history over the audit streams, run records and Git host events
   *  (docs/audit.md § Issue history). The hub's own audit lines are included for an admin only. */
  read_issue_history: { args: { repoPath: string; issue: number }; result: IssueHistory };
  /** HUB_ONLY, read-only: the live lessons of a repo, newest first. With `taskText`, only those a task with that text would receive.
   *  `branchFound` is false when the repo has no metrics branch (or no lessons file on it) yet. */
  list_lessons: { args: { repoPath: string; taskText?: string }; result: { lessons: RepoLesson[]; branchFound: boolean } };
  /** HUB_ONLY: dismiss a lesson (same effect as `taskcell lessons dismiss <id>`): later runs no longer receive it. */
  dismiss_lesson: { args: { repoPath: string; id: string }; result: void };
  /** The Local hub checklist: the switch, whether a credential and a task source are there, the last doctor result, last pick-up and last error. No network. */
  local_worker_state: { args: { repoPath: string }; result: LocalWorkerState };
  /** HUB_ONLY: run the doctor's preflight checks on the hub's machine and keep the result in the checklist. */
  local_worker_doctor: { args: { repoPath: string }; result: LocalWorkerState };
  /** HUB_ONLY: turn the project's built-in worker on or off. On is refused, with the reason, for a project with no servable task source or no credential. Off stops new pick-ups and leaves a running task alone. */
  local_worker_set: { args: { repoPath: string; enabled: boolean }; result: LocalWorkerState };
  /** HUB_ONLY: rename the repo's old `vanguard:*` labels to `taskcell:*` (as `taskcell migrate-labels`). Dry-run unless `apply`. */
  migrate_labels: { args: { repoPath: string; apply?: boolean }; result: MigrateLabelsReport };
  /** HUB_ONLY: the hub "Needs you" read model (src/hub/needs-you.ts) — `gh` and labels only, no model call. */
  list_needs_you: { args: { repoPath: string }; result: { items: NeedsYouItem[]; unchecked?: true } };
  /** HUB_ONLY: the factory's last comment on one waiting issue or PR (the lists carry none), for the view of the item that is opened. */
  needs_you_comment: { args: { repoPath: string; id: string; kind: 'issue' | 'pr' }; result: { lastComment?: { author: string; body: string }; ask?: 'question' | 'too-vague' } };
  /** HUB_ONLY: `list_needs_you` across every hub repository, each item stamped with its repository. */
  list_needs_you_all: { args: { teamId?: string } | undefined; result: { items: (NeedsYouItem & RepoStamp)[]; failures: RepoReadFailure[] } };
  /** HUB_ONLY: post a reply with the caller's own `gh` identity and move the item on. `card`: answer a card whose run stopped
   *  to ask (src/hub/asking.ts): a hub-board card takes the answer into its body and goes back to To do. */
  reply_needs_you: { args: { repoPath: string; id: string; kind: 'issue' | 'pr' | 'card'; body: string }; result: void };
  /** HUB_ONLY: merge a waiting PR (refused when not in "Needs you", verify failed on it, or required checks are not green). */
  merge_needs_you: { args: { repoPath: string; id: string }; result: void };
  list_projects: { args: { teamId?: string } | undefined; result: Project[] };
  add_project: { args: { path: string }; result: Project[] };
  /** HUB_ONLY: clone a repository under the browse root and register it. The owner picks `parentDir`; a hub admin
   * (`TASKCELL_HUB_ADMINS`) clones under the browse root into `teamId` (default: their first team). */
  clone_project: { args: { url: string; parentDir?: string; name?: string; teamId?: string }; result: Project };
  remove_project: { args: { path: string }; result: Project[] };
  /** HUB_ONLY: no native folder dialog in a browser (src/hub/browse.ts stands in for one). */
  browse_dirs: { args: { path?: string }; result: DirListing };
  /** HUB_ONLY: store an Expo push token for the signed-in caller (no RPC takes a user id). The hub pushes to it when something new waits for them. */
  register_push_token: { args: { token: string; platform: 'ios' | 'android' }; result: void };
  /** HUB_ONLY: remove the caller's own push token (another user's token is left alone). */
  unregister_push_token: { args: { token: string }; result: void };
  api_list_repo_files: { args: { repoPath: string }; result: { files: string[]; capped: boolean } };
  api_read_repo_file: { args: { repoPath: string; path: string }; result: { path: string; content: string; truncated: boolean } };
  api_repo_ok: { args: { repoPath: string }; result: boolean };
  /** HUB_ONLY: put an open factory PR (same-repo, factory branch, no review or revise in flight) back through review: drops
   *  `taskcell:reviewed` and the review trigger and re-adds the trigger, as the hub's `gh` identity. The review starts only
   *  if that identity is an allowed actor of the repo's review workflow, which the hub cannot check. GitHub only. */
  rereview_pr: { args: { repoPath: string; id: string }; result: void };
  api_capabilities: { args: undefined; result: Capabilities };
  api_create_run: { args: { params: CreateRunParams }; result: CreateRunResult };
  api_active_run: { args: undefined; result: { runId: string; repoPath: string } | null };
  api_run_backlog: { args: { runId: string }; result: unknown[] };
  /** HUB_ONLY: Tauri has no queue to read — it is still strictly single-in-flight, the hub's queue
   * (src/hub/run-session.ts) is what's new here. Position is 1-based, 1 = next to start. */
  api_queue: { args: undefined; result: { runId: string; repoPath: string; position: number }[] };
  /** `runId` cancels exactly that run (active or queued). The hub REQUIRES it (an id-less cancel
   * could hit another project's run); Tauri ignores it and cancels its one active run (no queue). */
  api_cancel: { args: { runId?: string }; result: void };
  list_runs: { args: { repoPath: string }; result: RunSummary[] };
  /** HUB_ONLY: `list_runs` across every hub repository, each row stamped with its repository. */
  list_runs_all: { args: { teamId?: string } | undefined; result: { runs: (RunSummary & RepoStamp)[]; failures: RepoReadFailure[] } };
  read_run: { args: { repoPath: string; taskId: string; timestamp: string; source: RunSource }; result: RunDetail };
  /** HUB_ONLY, read-only: a run's persisted event log (`.taskcell/runs/<taskId>/events-*.jsonl`), events with
   *  `id > after` (the SSE `id:`), at most `limit`; `timestamp` (a run record's, from `list_runs`) picks that run, default the newest. */
  read_run_events: {
    args: { repoPath: string; taskId: string; timestamp?: string; after?: number; limit?: number };
    result: { events: { id: number; ts: string; event: string; data: unknown }[]; nextAfter: number; hasMore: boolean; truncated: boolean };
  };
  list_remote_runs: { args: { repoPath: string }; result: RemoteRun[] };
  /** Both backends implement this: Tauri downloads+caches under the app config dir, the hub under
   * the project's `.taskcell/remote-runs/<id>` — each resolves `source: { kind: 'ci', runId }` for
   * a later `read_run` to its own root. A cache hit skips `gh run download` on both sides. */
  import_remote_run: { args: { repoPath: string; runId: number }; result: RemoteImport };
  list_active: { args: { repoPath: string }; result: ActiveRun[] };
  read_session: { args: { sessionFile: string }; result: SessionRead };
  /** HUB_ONLY, read-only: conflicts with the base per week (total, auto-resolved, left for a human) and the top conflicted files, as `taskcell stats` prints them. */
  conflict_stats: { args: { repoPath: string }; result: ConflictStats };
  /** HUB_ONLY, owner only, read-only: whether `gh`, `glab`, a Linear key and a model credential (Claude, or a Codex key or sign-in file) are present on the hub host. Booleans only — never a secret value. Spawns `gh`/`glab` on the host, so it is refused on a non-loopback bind without TASKCELL_HUB_ALLOW_ADD. */
  setup_status: { args: undefined; result: SetupStatus };
  /** HUB_ONLY, read-only: the skills of a repo (as in the hub checkout's working tree) with their lock status, upstream check and usage. */
  list_repo_skills: { args: { repoPath: string }; result: { skills: RepoSkill[] } };
  /** HUB_ONLY, owner only: `skills update <name> --pr`; the skill only ever changes on a new branch, delivered as a PR. Resolves to its URL. */
  update_skill_pr: { args: { repoPath: string; name: string }; result: { prUrl: string } };
  /** HUB_ONLY, owner only: `skills add` delivered as a PR. A failure carries the command's reason. `paths` adds several skills of
   * one repository in one PR (the folders `discover_skills` found, `ref` pinned to its commit); `source` may be a GitHub or GitLab browse link to a folder. */
  add_skill_pr: { args: { repoPath: string; source: string; ref?: string; path?: string; paths?: string[]; name?: string }; result: { prUrl: string } };
  /** HUB_ONLY, owner only (it reads the network): the skills a repository holds, from its tree listing alone. `commit` is what to pin them to. */
  discover_skills: { args: { repoPath: string; source: string; ref?: string; path?: string }; result: { commit: string; skills: DiscoveredSkill[] } };
  /** HUB_ONLY, owner only (it reads the forge): the project's open skill-add PRs, by branch prefix. GitHub only; others get an empty list. */
  list_pending_skill_prs: { args: { repoPath: string }; result: { prs: PendingSkillPr[] } };
  /** HUB_ONLY, owner only, a write: fast-forward the hub's checkout to origin's default branch, so merged skills appear. Refuses (changing nothing)
   * on a dirty tree, a branch other than the default, or a diverged history; the reason is the error. */
  pull_checkout: { args: { repoPath: string }; result: { updated: boolean } };
  /** HUB_ONLY, owner only: `skills remove` delivered as a PR. */
  remove_skill_pr: { args: { repoPath: string; name: string }; result: { prUrl: string } };
  /** `hubBoard`: the project's task source is the hub's own board (its cards are created and scheduled in the hub). */
  list_tasks: { args: { repoPath: string }; result: { tasks: BoardTask[]; capped: boolean; hubBoard?: true } };
  // Every card in both lists carries its `view` (src/hub/card-view.ts): its place on the line, its newest run, its waiting item.
  /** HUB_ONLY: `list_tasks` across every hub repository, each card stamped with its repository. `hubBoards`: the repositories whose task source is the hub board. */
  list_tasks_all: { args: { teamId?: string } | undefined; result: { tasks: (BoardTask & RepoStamp)[]; capped: boolean; failures: RepoReadFailure[]; hubBoards?: string[] } };
  fetch_spec: { args: { repoPath: string; taskId: string }; result: { spec: string } };
  /** `dependsOn`: ids of existing tasks this one depends on (`owner/repo#N`, `group/project#N`, `TEAM-N`), written as a `Depends on` line plus a native relation. */
  api_create_task: { args: { repoPath: string; title: string; body: string; baseBranch?: string; dependsOn?: string[] }; result: CreatedTask };
  /**
   * HUB_ONLY: split one piece of work into several tasks, created in order. A task's `dependsOn` lists the
   * positions (0-based) of earlier tasks in the same call; each becomes a dependency on the task just created.
   * At most 20 tasks and 40 dependencies in all per call; over either cap the call is refused before anything is created.
   */
  api_create_tasks: { args: { repoPath: string; tasks: { title: string; body: string; dependsOn?: number[] }[]; baseBranch?: string }; result: { tasks: CreatedTask[] } };
  /** HUB_ONLY, read-only: the target branches a card may name (repo default + `baseBranches` allowlist) and the configured default, for the new-card form. */
  list_branches: { args: { repoPath: string }; result: { branches: string[]; default?: string } };
  /** HUB_ONLY: add a task to the project's hub board (task source `hub`), with its dependencies and start date set before the scheduler can see it. The caller becomes the task's owner: it runs as them. */
  hub_task_create: { args: { repoPath: string; title: string; body?: string; blockedBy?: string[]; startDate?: string }; result: { id: string } };
  /** HUB_ONLY: set a hub-board task's dependencies (ids of the project's other tasks) and/or start date (`null` clears it). The caller becomes its owner. */
  hub_task_schedule: { args: { repoPath: string; id: string; blockedBy?: string[]; startDate?: string | null }; result: { id: string } };
  /** HUB_ONLY: put a failed hub-board task back to `todo`, to run as the caller; its old result is cleared. `flow`: run it with that flow (a built-in or the repo's) instead of the configured one. */
  hub_task_retry: { args: { repoPath: string; id: string; flow?: string }; result: { id: string } };
  /** Start one `todo` hub task now as the caller, even while the project's auto-run is off (the scheduler's next tick, same gates). `flow`: run it with that flow instead of the configured one. */
  hub_task_start: { args: { repoPath: string; id: string; flow?: string }; result: { id: string } };
  /** HUB_ONLY: accept the delivered result of a hub-board task that failed verification: it becomes done (its dependents may start) without a second run. */
  hub_task_accept: { args: { repoPath: string; id: string }; result: { id: string } };
  /** HUB_ONLY: move a done hub-board task to the project's archive file, freeing room on the board. */
  hub_task_archive: { args: { repoPath: string; id: string }; result: { id: string } };
  /** HUB_ONLY: delete a hub-board task that is not running. */
  hub_task_delete: { args: { repoPath: string; id: string }; result: { id: string } };
  /** HUB_ONLY: apply a trigger label to a GitHub issue of the project (src/hub/start-task.ts). */
  start_task: { args: { repoPath: string; number: number; label: string }; result: StartTaskResult };
  /** HUB_ONLY: "Retry now" on a task paused by a provider limit — remove the rate-limited label, re-apply the marker's trigger (src/hub/paused.ts). Refused where `start_task` is. */
  retry_paused_task: { args: { repoPath: string; number: number }; result: RetryPausedResult };
  /** HUB_ONLY, read-only: the ids of the skills a run of this project can load (what a hand-picked list is checked against). */
  list_skills: { args: { repoPath: string }; result: { skills: string[] } };
  /** HUB_ONLY: write a card's hand-picked skills: to its tracker task as the body's `Skills:` line, or on a hub-board task to the task itself (an empty list removes them). */
  set_task_skills: { args: { repoPath: string; taskId: string; skills: string[] }; result: { skills: string[] } };
  /** HUB_ONLY: token-only mode has exactly one team and the caller acts as its admin. */
  list_teams: { args: undefined; result: Team[] };
  /** HUB_ONLY: one team by id (`null` when unknown). */
  get_team: { args: { id: string }; result: Team | null };
  /** HUB_ONLY: the caller's role in a team they belong to (`null` otherwise); the hub owner is an admin of every team. */
  team_role: { args: { id: string }; result: TeamRole | null };
  /** HUB_ONLY, team admin only (a member is refused). */
  add_team_member: { args: { teamId: string; login: string; role: TeamRole }; result: Team };
  /** HUB_ONLY, team admin only. */
  remove_team_member: { args: { teamId: string; login: string }; result: Team };
  /** HUB_ONLY, team admin only: attach an existing hub project to a non-default team. */
  add_team_repository: { args: { teamId: string; path: string }; result: Team };
  /** HUB_ONLY, team admin only. */
  remove_team_repository: { args: { teamId: string; path: string }; result: Team };
  /** HUB_ONLY, team admin only: the team's default fallback chain (an empty list clears it). */
  set_team_fallback_chain: { args: { teamId: string; chain: FallbackEntry[] }; result: Team };
  watch_project: { args: { repoPath: string }; result: void };
  unwatch_project: { args: { repoPath: string }; result: void };
}

/** Every command name, derived from the modules in src/hub/commands/. TYPE-CHECKED against `Commands`:
 * the `satisfies` rejects a name not in `Commands`, and `_Exhaustive` rejects a missing one. */
export const COMMAND_NAMES = [
  'add_project',
  'add_skill_pr',
  'add_team_member',
  'add_team_repository',
  'agent_cli_versions',
  'api_active_run',
  'api_cancel',
  'api_cancel_complete',
  'api_capabilities',
  'api_complete',
  'api_create_run',
  'api_create_task',
  'api_create_tasks',
  'api_delete_flow',
  'api_list_flows',
  'api_list_providers',
  'api_list_repo_files',
  'api_queue',
  'api_read_flow',
  'api_read_repo_file',
  'api_repo_ok',
  'api_run_backlog',
  'api_write_flow',
  'browse_dirs',
  'caller_capabilities',
  'clear_draft_assets',
  'clone_project',
  'conflict_stats',
  'delete_draft',
  'delete_instance_account',
  'delete_instance_credential',
  'delete_user_account',
  'delete_user_credential',
  'discover_skills',
  'dismiss_lesson',
  'enable_factory_apply',
  'enable_factory_host',
  'enable_factory_plan',
  'enable_factory_secret',
  'enable_factory_start',
  'enable_factory_verify',
  'enable_factory_watch',
  'factory_refresh',
  'factory_state',
  'fetch_spec',
  'get_credential_policy',
  'get_team',
  'hub_task_accept',
  'hub_task_archive',
  'hub_task_create',
  'hub_task_delete',
  'hub_task_retry',
  'hub_task_schedule',
  'hub_task_start',
  'import_remote_run',
  'instance_credentials_status',
  'kill_run',
  'list_active',
  'list_activity',
  'list_branches',
  'list_chat_models',
  'list_drafts',
  'list_lessons',
  'list_needs_you',
  'list_needs_you_all',
  'list_pending_skill_prs',
  'list_projects',
  'list_remote_runs',
  'list_repo_skills',
  'list_runs',
  'list_runs_all',
  'list_skills',
  'list_spawns',
  'list_tasks',
  'list_tasks_all',
  'list_teams',
  'local_worker_doctor',
  'local_worker_set',
  'local_worker_state',
  'merge_needs_you',
  'migrate_labels',
  'needs_you_comment',
  'pull_checkout',
  'read_app_config',
  'read_app_config_strict',
  'read_approver_decisions',
  'read_approver_scorecard',
  'read_audit',
  'read_cost_breakdown',
  'read_draft',
  'read_issue_history',
  'read_run',
  'read_run_events',
  'read_session',
  'read_settings_history',
  'register_push_token',
  'remove_project',
  'remove_skill_pr',
  'remove_team_member',
  'remove_team_repository',
  'reorder_instance_accounts',
  'reorder_user_accounts',
  'reply_needs_you',
  'rereview_pr',
  'retry_paused_task',
  'save_instance_account',
  'save_instance_credential',
  'save_user_account',
  'save_user_credential',
  'set_approver_mode',
  'set_credential_policy',
  'set_task_skills',
  'set_team_fallback_chain',
  'setup_status',
  'spawn_run',
  'start_task',
  'team_role',
  'unregister_push_token',
  'unwatch_project',
  'update_skill_pr',
  'user_credentials_status',
  'watch_project',
  'write_app_config',
  'write_draft',
  'write_draft_asset',
] as const satisfies readonly (keyof Commands)[];
type _Exhaustive = keyof Commands extends (typeof COMMAND_NAMES)[number]
  ? true
  : ['missing from COMMAND_NAMES', Exclude<keyof Commands, (typeof COMMAND_NAMES)[number]>];
const _exhaustive: _Exhaustive = true;
void _exhaustive;

/** Every command whose hub policy declares `write: true` (HUB_POLICY), derived by `pnpm gen:wire`: demo mode refuses exactly these. */
export const WRITE_COMMAND_NAMES: readonly (typeof COMMAND_NAMES)[number][] = [
  'add_project',
  'add_skill_pr',
  'add_team_member',
  'add_team_repository',
  'api_cancel',
  'api_cancel_complete',
  'api_create_run',
  'api_create_task',
  'api_create_tasks',
  'api_delete_flow',
  'api_write_flow',
  'clear_draft_assets',
  'clone_project',
  'delete_draft',
  'delete_instance_account',
  'delete_instance_credential',
  'delete_user_account',
  'delete_user_credential',
  'dismiss_lesson',
  'enable_factory_apply',
  'enable_factory_start',
  'enable_factory_verify',
  'hub_task_accept',
  'hub_task_archive',
  'hub_task_create',
  'hub_task_delete',
  'hub_task_retry',
  'hub_task_schedule',
  'hub_task_start',
  'import_remote_run',
  'kill_run',
  'local_worker_doctor',
  'local_worker_set',
  'merge_needs_you',
  'migrate_labels',
  'pull_checkout',
  'register_push_token',
  'remove_project',
  'remove_skill_pr',
  'remove_team_member',
  'remove_team_repository',
  'reorder_instance_accounts',
  'reorder_user_accounts',
  'reply_needs_you',
  'rereview_pr',
  'retry_paused_task',
  'save_instance_account',
  'save_instance_credential',
  'save_user_account',
  'save_user_credential',
  'set_approver_mode',
  'set_credential_policy',
  'set_task_skills',
  'set_team_fallback_chain',
  'spawn_run',
  'start_task',
  'unregister_push_token',
  'unwatch_project',
  'update_skill_pr',
  'watch_project',
  'write_app_config',
  'write_draft',
  'write_draft_asset',
];
