/**
 * The wire contract shared between core and the desktop app (Subsystem 7).
 *
 * RULES (enforced by src/wire.test.ts):
 * - ZERO imports, static or dynamic — this file must be safe in the Tauri webview.
 * - Syntax ceiling: interfaces, type aliases, literal unions, `const` literals only — nothing the
 *   desktop's OLDER TypeScript cannot parse (the drift guard proves byte-equality, not
 *   compilability; the ceiling is what keeps this compiling on both sides).
 * - `pnpm gen:wire` copies this file (plus a header, and the `Commands`/`COMMAND_NAMES` derived from the
 *   hub command modules in src/hub/commands/) to apps/desktop/src/wire.ts; the drift test compares them. Change here ⇒ regenerate, or root CI fails naming the fix.
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
  /** Hub only: who started the run. Set server-side from the request's actor, never from the client. */
  startedBy?: string;
}

/** Hub-only, server-set (never part of the client's params): the credential a run uses. `env` holds
 * the secret values and must never be persisted or logged; only `source` reaches the run record. */
export interface RunCredential {
  source: 'instance' | 'user';
  env: Record<string, string>;
}

/** Result of the sidecar `createRun` method. */
export interface CreateRunResult {
  prUrl?: string;
  secretBlocked?: boolean;
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
  /** Host env var NAME holding the key (read at dispatch, never stored). */
  keyEnv: string;
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
  /** Waiting for the factory: carries a trigger label and is still `queued`. Absent when false. */
  waiting?: boolean;
  /** Current pipeline stage of a running task (from the run's stage marker). Absent ⇒ unknown. */
  stage?: string;
  /** Latest run's per-stage/gate verdicts. Absent ⇒ no run record for this task. */
  chips?: BoardChip[];
  /** The branch this card's PR targets: its `taskcell:base=` label, else the repo default. Absent when neither is set (`main`). */
  baseBranch?: string;
  /** The tracker the card came from; names the "Open in …" link. */
  source?: 'github' | 'gitlab' | 'linear';
  /** The issue's address in that tracker, as the tracker returned it. Absent ⇒ no link. */
  url?: string;
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
 * Persisted run-record shapes. ONE producer: src/core/run-store.ts — the hub reads it directly and
 * the desktop forwards `listRuns`/`readRun` over the sidecar pipe, so the desktop shell keeps no
 * reader and no hand-mirror of these structs (pinned by `src/wire.test.ts`).
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
  diffOmitted?: 'secret-blocked' | 'secret-scan';
  /** Hub login (or `token`) that started the run from the hub; absent for CLI/CI runs. */
  startedBy?: string;
  /** Verdict-bearing stages (reviewer, conformance) only: the merge gate's own reading of this
   *  stage's reply, persisted so the hub and the PR body never re-derive it. */
  verdict?: ReviewVerdict;
  /** The `<findings>` block this stage emitted (the shape the repair gate consumes). Absent when
   *  the stage emitted none, and withheld entirely when `diffOmitted` is set. */
  findings?: Finding[];
  /** The branch the run's PR targets. Absent on records written before the target branch was recorded. */
  baseBranch?: string;
  /** Agent calls folded into this stage (auto-resumes and gate repairs); absent when the stage ran once. */
  attempts?: number;
  /** Ids of the lessons injected into this run's prompts (`taskcell lessons list` counts them). */
  lessonIds?: string[];
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
  /** `'merged'` when the run's card is done (its pull request merged); set by the hub's list commands, absent when unknown or not merged. */
  prState?: 'merged';
  /** `'ci'` for a run known only from the metrics branch (no local record to open); `prUrl` links its PR/MR. */
  source?: 'ci';
  /** The run's metrics carry no cost data, so `totalCostUsd` (0) is not a cost: show "unknown", not $0. */
  costUnknown?: true;
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
  byModel: CostRow[];
  byStage: CostRow[];
}

export interface StageDetail {
  record: RunRecord;
  diff?: string;
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
 * Where one run's records live, resolved to a root by whichever backend answers `read_run` —
 * Tauri's own per-run cache dir (formerly in the desktop shell), the hub's
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
  | 'settings-change'
  | 'needs-reply'
  | 'needs-merge'
  | 'task-create'
  | 'enable-factory';
export type AuditOutcome = 'ok' | 'refused' | 'failed';

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
  /** Opaque JSON preserved by Rust and the hub, including invalid entries and unknown keys — see
   * `CustomProviderSpec` for the shape a valid entry has. */
  customProviders?: unknown;
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
  entries: DirEntry[];
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
  /** `owner/repo#number` — also the id a reply targets. */
  id: string;
  kind: 'issue' | 'pr';
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
}

/** A Fleet-screen spawned process (Fleet is enabled only on the desktop app's local hub). */
export interface SpawnInfo {
  pid: number;
  cwd: string;
  command: string;
}

/** Enable-factory provider seam (hub § "Enable factory"): GitHub Actions is implemented; GitLab and
 * Linear are "planned" in the UI and never reach `enable_factory_*` (see docs/task-sources.md,
 * docs/onboarding-linear.md). */
export type FactoryProviderId = 'github' | 'gitlab' | 'linear';

/** What `enable_factory_plan` detected and what `enable_factory_apply` will do with it. */
export interface FactoryPlan {
  provider: 'github';
  repoSlug: string;
  defaultBranch: string;
  login: string;
  packageManager: string;
  verifyCommand?: string;
  scripts: { typecheck: boolean; lint: boolean; test: boolean; build: boolean };
  /** Repo-relative paths `apply` will add, e.g. `.github/workflows/taskcell-implement.yml`. */
  callerFiles: string[];
  /** The callers already on the default branch, under the `taskcell-` or legacy `vanguard-` name — `apply` leaves those untouched. */
  existingCallerFiles?: string[];
  labels: string[];
}

export interface FactoryApplyResult {
  branch: string;
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
  /** Whether a model credential is already present for each provider (a boolean, not the value). Codex counts an `OPENAI_API_KEY` or a Codex sign-in (the auth file exists; never read). */
  models: { claude: boolean; codex: boolean };
}

/** Instance provider credentials (hub only, write-only: a value is never returned). */
export type CredentialProvider = 'claude' | 'codex' | 'zai' | 'openrouter';
export interface CredentialStatus {
  provider: CredentialProvider;
  set: boolean;
  last4?: string;
  env: boolean;
}
export interface CredentialsSummary {
  enabled: boolean;
  reason?: string;
  providers: CredentialStatus[];
}

/** The admin `per-user credentials` switch: off, user's own first then the instance's, or user's own only. */
export type CredentialPolicy = 'off' | 'user-first' | 'user-only';

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
}

export interface Events {
  'api:event': { runId: string; event: RunEvent };
  'vanguard:changed': string;
  /** Hub-only clone progress. */
  'vanguard:clone-progress': { line: string };
}
