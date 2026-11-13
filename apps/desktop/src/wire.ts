// GENERATED from src/wire.ts — do not edit; run pnpm gen:wire
/**
 * The wire contract shared between core and the desktop app (Subsystem 7).
 *
 * RULES (enforced by src/wire.test.ts):
 * - ZERO imports, static or dynamic — this file must be safe in the Tauri webview.
 * - Syntax ceiling: interfaces, type aliases, literal unions, `const` literals only — nothing the
 *   desktop's OLDER TypeScript cannot parse (the drift guard proves byte-equality, not
 *   compilability; the ceiling is what keeps this compiling on both sides).
 * - `pnpm gen:wire` copies this file verbatim (plus a header) to apps/desktop/src/wire.ts; the
 *   drift test byte-compares them. Change here ⇒ regenerate, or root CI fails naming the fix.
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
  /** The branch this card's PR targets: its `vanguard:base=` label, else the repo default. Absent when neither is set (`main`). */
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
 * the desktop forwards `listRuns`/`readRun` over the sidecar pipe, so src-tauri/src/runs.rs keeps no
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
 * Tauri's own per-run cache dir (`src-tauri/src/remote.rs`), the hub's
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
  /** Extra branches a card's `vanguard:base=` label may select, besides the default. Unset = only the default. */
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
 * issue at `needs info`, or a PR at `vanguard:needs-human-review`/`vanguard:verify-failed` or with a
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
  /** The branch the PR targets (a PR's base), or the one the card asks for (`vanguard:base=`). Absent when unknown. */
  baseBranch?: string;
}

/** A Fleet-screen spawned process (Fleet is enabled only on the desktop app's local hub). */
export interface SpawnInfo {
  pid: number;
  cwd: string;
  command: string;
}

/** Enable-factory provider seam (hub § "Enable factory"): GitHub Actions is implemented; GitLab and
 * Linear are "coming soon" in the UI and never reach `enable_factory_*` (see docs/task-sources.md,
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
export interface CliVersionReport {
  enabled: boolean;
  clis: CliVersionInfo[];
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

/**
 * Shared command catalogue for the Tauri, hub and mock adapters. Adapter integration is separate:
 * the existing invoke wrappers and dispatchers do not yet enforce these argument/result types.
 * The parity test checks registered Rust commands and hub dispatch cases against this catalogue.
 */
export interface Commands {
  list_runs: { args: { repoPath: string }; result: RunSummary[] };
  read_run: { args: { repoPath: string; taskId: string; timestamp: string; source: RunSource }; result: RunDetail };
  /** HUB_ONLY, read-only: a run's persisted event log (`.taskcell/runs/<taskId>/events-*.jsonl`), events with
   *  `id > after` (the SSE `id:`), at most `limit`; `timestamp` (a run record's, from `list_runs`) picks that run, default the newest. */
  read_run_events: {
    args: { repoPath: string; taskId: string; timestamp?: string; after?: number; limit?: number };
    result: { events: { id: number; ts: string; event: string; data: unknown }[]; nextAfter: number; hasMore: boolean; truncated: boolean };
  };
  list_projects: { args: { teamId?: string } | undefined; result: Project[] };
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
  add_project: { args: { path: string }; result: Project[] };
  remove_project: { args: { path: string }; result: Project[] };
  list_active: { args: { repoPath: string }; result: ActiveRun[] };
  read_session: { args: { sessionFile: string }; result: SessionRead };
  read_app_config: { args: { repoPath: string }; result: AppConfig };
  read_app_config_strict: { args: { repoPath: string }; result: AppConfig };
  write_app_config: { args: { repoPath: string; config: AppConfig }; result: void };
  /** HUB_ONLY: instance provider credentials (src/hub/credentials.ts) — write-only; reads return set + last four. */
  get_credentials: { args: undefined; result: CredentialsSummary };
  set_credential: { args: { provider: CredentialProvider; value: string }; result: CredentialsSummary };
  delete_credential: { args: { provider: CredentialProvider }; result: CredentialsSummary };
  list_drafts: { args: { repoPath: string }; result: string[] };
  read_draft: { args: { repoPath: string; id: string }; result: string };
  write_draft: { args: { repoPath: string; id: string; content: string }; result: void };
  delete_draft: { args: { repoPath: string; id: string }; result: void };
  write_draft_asset: { args: { repoPath: string; id: string; name: string; bytes: number[] }; result: string };
  clear_draft_assets: { args: { repoPath: string; id: string }; result: void };
  list_remote_runs: { args: { repoPath: string }; result: RemoteRun[] };
  /** Both backends implement this: Tauri downloads+caches under the app config dir, the hub under
   * the project's `.taskcell/remote-runs/<id>` — each resolves `source: { kind: 'ci', runId }` for
   * a later `read_run` to its own root. A cache hit skips `gh run download` on both sides. */
  import_remote_run: { args: { repoPath: string; runId: number }; result: RemoteImport };
  list_tasks: { args: { repoPath: string }; result: { tasks: BoardTask[]; capped: boolean } };
  /** HUB_ONLY: `list_tasks` across every hub repository, each card stamped with its repository. */
  list_tasks_all: { args: { teamId?: string } | undefined; result: { tasks: (BoardTask & RepoStamp)[]; capped: boolean; failures: RepoReadFailure[] } };
  /** HUB_ONLY: `list_runs` across every hub repository, each row stamped with its repository. */
  list_runs_all: { args: { teamId?: string } | undefined; result: { runs: (RunSummary & RepoStamp)[]; failures: RepoReadFailure[] } };
  fetch_spec: { args: { repoPath: string; taskId: string }; result: { spec: string } };
  watch_project: { args: { repoPath: string }; result: void };
  unwatch_project: { args: { repoPath: string }; result: void };
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
  api_create_task: { args: { repoPath: string; title: string; body: string; baseBranch?: string }; result: CreatedTask };
  api_list_flows: { args: { repoPath: string }; result: { flows: RepoFlowInfo[] } };
  api_list_providers: { args: { repoPath: string }; result: { providers: RepoProviderInfo[] } };
  api_read_flow: { args: { repoPath: string; file: string }; result: { doc: FlowDoc; source: string } };
  api_write_flow: { args: { repoPath: string; file: string; doc: FlowDoc }; result: { source: string } };
  api_delete_flow: { args: { repoPath: string; file: string }; result: void };
  api_list_repo_files: { args: { repoPath: string }; result: { files: string[]; capped: boolean } };
  api_read_repo_file: { args: { repoPath: string; path: string }; result: { path: string; content: string; truncated: boolean } };
  api_repo_ok: { args: { repoPath: string }; result: boolean };
  api_complete: { args: { repoPath: string; req: CompleteCallArgs; callId?: string }; result: CompleteResponse };
  api_cancel_complete: { args: { callId: string }; result: void };
  /** HUB_ONLY: no native folder dialog in a browser (src/hub/browse.ts stands in for one). */
  browse_dirs: { args: { path?: string }; result: DirListing };
  /** HUB_ONLY: clone a repository under the browse root and register it. */
  clone_project: { args: { url: string; parentDir: string; name?: string }; result: Project };
  /** HUB_ONLY: the hub "Needs you" read model (src/hub/needs-you.ts) — `gh` and labels only, no model call. */
  list_needs_you: { args: { repoPath: string }; result: { items: NeedsYouItem[] } };
  /** HUB_ONLY: `list_needs_you` across every hub repository, each item stamped with its repository. */
  list_needs_you_all: { args: { teamId?: string } | undefined; result: { items: (NeedsYouItem & RepoStamp)[]; failures: RepoReadFailure[] } };
  /** HUB_ONLY: post a reply with the caller's own `gh` identity and move the item on. */
  reply_needs_you: { args: { repoPath: string; id: string; kind: 'issue' | 'pr'; body: string }; result: void };
  /** HUB_ONLY: merge a waiting PR (refused when not in "Needs you" or required checks are not green). */
  merge_needs_you: { args: { repoPath: string; id: string }; result: void };
  /** HUB_ONLY: apply a trigger label to a GitHub issue of the project (src/hub/start-task.ts). */
  start_task: { args: { repoPath: string; number: number; label: string }; result: StartTaskResult };
  /** The Fleet screen's shell-spawn surface — enabled only on the desktop app's local (loopback) hub,
   * refused elsewhere (remote code execution on a reachable server). `argv[0]` is the program, run
   * WITHOUT a shell: values built from repo config travel as single arguments and can never
   * introduce shell syntax. */
  spawn_run: { args: { cwd: string; argv: string[] }; result: number };
  /** See spawn_run. */
  kill_run: { args: { pid: number }; result: void };
  /** See spawn_run. */
  list_spawns: { args: undefined; result: SpawnInfo[] };
  /** HUB_ONLY: read the repo (default branch, package manager, verify command) and report what
   *  `enable_factory_apply` would change — no writes yet. GitHub only; `provider` is accepted for
   *  forward compatibility with GitLab/Linear, which the UI marks "coming soon" instead of calling this. */
  enable_factory_plan: { args: { repoPath: string; provider: FactoryProviderId }; result: FactoryPlan };
  /** HUB_ONLY: create a branch, add the five caller workflows, open a PR (never push to the default
   *  branch) and create the routing labels. */
  enable_factory_apply: { args: { repoPath: string; plan: FactoryPlan }; result: FactoryApplyResult };
  /** HUB_ONLY: the `gh secret set` command text for the user to run themselves — the hub never
   *  reads, prints or stores the secret value. */
  enable_factory_secret: { args: { repoPath: string; plan: FactoryPlan }; result: FactorySecretStep };
  /** HUB_ONLY: dispatch the doctor workflow (once the PR above is merged) and report the run that dispatch created. */
  enable_factory_verify: { args: { repoPath: string; plan: FactoryPlan }; result: FactoryVerifyResult };
  /** HUB_ONLY, read-only: the target branches a card may name (repo default + `baseBranches` allowlist) and the configured default, for the new-card form. */
  list_branches: { args: { repoPath: string }; result: { branches: string[]; default?: string } };
  /** HUB_ONLY, read-only: installed vs latest claude/codex/cursor CLI in the local sandbox image (3-day soak applied; `enabled: false`, and no lookups, when VANGUARD_CLI_VERSION_CHECK is off). Refused on a non-loopback bind without VANGUARD_HUB_ALLOW_ADD. */
  agent_cli_versions: { args: undefined; result: CliVersionReport };
  /** HUB_ONLY, admin-only (403 otherwise): the audit log newest first, optionally for one login. */
  read_audit: { args: { login?: string; limit?: number }; result: AuditEntry[] };
}

/** Every command name, for the hub dispatch parity test and friends. TYPE-CHECKED (not just asserted)
 * against `Commands`: the `satisfies` below rejects a typo or a name not in `Commands`, and
 * `_Exhaustive` rejects a missing one — adding a command to `Commands` without adding it here is a
 * compile error. */
export const COMMAND_NAMES = [
  'list_runs',
  'get_credentials',
  'set_credential',
  'delete_credential',
  'read_run',
  'read_run_events',
  'list_projects',
  'list_teams',
  'get_team',
  'team_role',
  'add_team_member',
  'remove_team_member',
  'add_team_repository',
  'remove_team_repository',
  'add_project',
  'remove_project',
  'list_active',
  'read_session',
  'read_app_config',
  'read_app_config_strict',
  'write_app_config',
  'list_drafts',
  'read_draft',
  'write_draft',
  'delete_draft',
  'write_draft_asset',
  'clear_draft_assets',
  'list_remote_runs',
  'import_remote_run',
  'list_tasks',
  'fetch_spec',
  'watch_project',
  'unwatch_project',
  'api_capabilities',
  'api_create_run',
  'api_active_run',
  'api_run_backlog',
  'api_queue',
  'api_cancel',
  'api_create_task',
  'api_list_flows',
  'api_list_providers',
  'api_read_flow',
  'api_write_flow',
  'api_delete_flow',
  'api_list_repo_files',
  'api_read_repo_file',
  'api_repo_ok',
  'api_complete',
  'api_cancel_complete',
  'browse_dirs',
  'clone_project',
  'list_needs_you',
  'list_needs_you_all',
  'list_tasks_all',
  'list_runs_all',
  'reply_needs_you',
  'merge_needs_you',
  'start_task',
  'spawn_run',
  'kill_run',
  'list_spawns',
  'enable_factory_plan',
  'enable_factory_apply',
  'enable_factory_secret',
  'enable_factory_verify',
  'agent_cli_versions',
  'list_branches',
  'read_audit',
] as const satisfies readonly (keyof Commands)[];
type _Exhaustive = keyof Commands extends (typeof COMMAND_NAMES)[number]
  ? true
  : ['missing from COMMAND_NAMES', Exclude<keyof Commands, (typeof COMMAND_NAMES)[number]>];
const _exhaustive: _Exhaustive = true;
void _exhaustive;

/** Named realtime channels the wire carries (`src/hub/rpc.ts`'s `publish`, Rust's `emit_event`).
 * The desktop additionally sees a Rust-minted `run-accepted` `api:event` variant core never emits —
 * that is a desktop extension of `RunEvent`, declared desktop-side (see typedRunReducer.ts), not here. */
export interface Events {
  'api:event': { runId: string; event: RunEvent };
  'vanguard:changed': string;
  /** Hub-only clone progress. */
  'vanguard:clone-progress': { line: string };
}
