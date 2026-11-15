// Enable factory, "Local hub": the hub's built-in worker. Per project there is one switch (off by default). While it is on, every
// scheduler tick picks up work for that project and hands it to the run session: a GitHub project's open issues carrying the
// trigger label (as `taskcell watch` would), or a hub-board project's tasks (the board scheduler, src/hub/task-scheduler.ts).
// Both go through the same run session as a run started by hand, so the parallel-run limit and the credential policy apply.
// The switch and the last pick-up / error live in the hub's config dir (`local-worker.json`), never in the repo.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { keyedLock } from '../core/keyed-lock.js';
import { hasLabel } from '../core/labels.js';
import { DEFAULT_GITHUB_AGENT_LABEL, parseCli } from '../cli/args.js';
import { runPreflight, type PreflightCommand } from '../cli/preflight.js';
import { GITHUB_RATE_LIMITED_LABEL, GITHUB_WAITING_LABEL } from '../github-labels.js';
import { parseGitlabProjectFromRemote } from '../runners/gitlab.js';
import { BadRequestError, type CreateRunResult } from '../sidecar/sidecar.js';
import { defaultGhRunner, isTrustedIssueAuthor, type GhRunner } from '../tasks/github.js';
import type { LocalWorkerState } from '../wire.js';
import { configuredFlow, readAppConfig } from './app-config.js';
import { PROVIDER_NAMES, type CredentialService } from './credentials.js';
import { defaultExec, GITHUB_REPO_SLUG, type FactoryExec } from './enable-factory.js';
import { hostOfOrigin, readOrigin } from './enable-factory-gitlab.js';
import { parallelLimit } from './hub-board.js';
import { failureMessage, resolveTaskSource } from './projects.js';
import type { ProjectAllowlist } from './allowlist.js';
import type { RunSession } from './run-session.js';
import { STARTED_LABELS } from './start-task.js';

/** Persisted per project (keyed by the allowlisted real path). `enabled` is the switch; absent = never switched (distinct from an explicit off). */
interface LocalWorkerRecord {
  enabled?: boolean;
  lastPickupAt?: string;
  lastPickup?: string;
  lastError?: string;
  doctor?: { at: string; ok: boolean; failed: string[] };
}

/** Issues one tick reads per project. */
const ISSUE_LIMIT = 50;
/** The login a worker-started run is recorded under. */
export const LOCAL_WORKER_LOGIN = 'local-worker';

const storeFile = (configDir: string): string => join(configDir, 'local-worker.json');
const lock = keyedLock();

async function readAll(configDir: string): Promise<Record<string, LocalWorkerRecord>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storeFile(configDir), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, LocalWorkerRecord>) : {};
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return {};
    // A corrupt file reads as "everything off": the worker never starts work on a guess.
    return {};
  }
}

/** One project's record; a never-switched project reads as off (`enabled: false`) but is stored without `enabled`. */
export async function readLocalWorker(configDir: string, repoPath: string): Promise<LocalWorkerRecord & { enabled: boolean }> {
  const rec = (await readAll(configDir))[repoPath];
  return typeof rec === 'object' && rec !== null ? { ...rec, enabled: rec.enabled === true } : { enabled: false };
}

/** Read-modify-write one project's record; temp file + rename so a reader never sees half a write. */
export function updateLocalWorker(configDir: string, repoPath: string, edit: (r: LocalWorkerRecord) => LocalWorkerRecord): Promise<LocalWorkerRecord> {
  return lock(configDir, async () => {
    const all = await readAll(configDir);
    const next = edit(all[repoPath] ?? {});
    const file = storeFile(configDir);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...all, [repoPath]: next }, null, 2), { mode: 0o600 });
    await rename(tmp, file);
    return next;
  });
}

/** Projects with the switch on. */
async function enabledProjects(configDir: string): Promise<string[]> {
  return Object.entries(await readAll(configDir)).filter(([, r]) => r?.enabled === true).map(([p]) => p);
}

export interface LocalWorkerDeps {
  exec?: FactoryExec;
  gh?: GhRunner;
  /** The environment the hub's own credentials are read from. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** What the worker can serve and why not: GitHub Issues (the repo's `origin` on github.com) or the hub board. */
async function sourceOf(repoPath: string, exec: FactoryExec): Promise<{ source?: 'github' | 'hub'; slug?: string; blocked?: string }> {
  const configured = resolveTaskSource(await readAppConfig(repoPath));
  if (configured === undefined) return { blocked: 'This project has no task source; pick one in Settings → Task source.' };
  if (configured === 'hub') return { source: 'hub' };
  if (configured !== 'github') {
    return { blocked: 'The local worker reads GitHub Issues or the hub board; this project\'s task source is another one. Use a run location that serves it, or change the task source.' };
  }
  const origin = await readOrigin(exec, repoPath);
  const slug = origin ? parseGitlabProjectFromRemote(origin) : undefined;
  if (hostOfOrigin(origin) !== 'github' || slug === undefined || !GITHUB_REPO_SLUG.test(slug)) {
    return { blocked: 'This project\'s task source is GitHub Issues, but `origin` is not a github.com repository.' };
  }
  return { source: 'github', slug };
}

/** Whether the hub holds a credential for the project's provider: its own environment or an instance credential (never user-scoped ones: the worker has no user). */
async function credentialsOf(repoPath: string, creds: CredentialService | undefined, env: NodeJS.ProcessEnv): Promise<LocalWorkerState['credentials']> {
  const configured = (await readAppConfig(repoPath)).provider;
  const provider = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'claude';
  const names = [...(PROVIDER_NAMES[provider] ?? PROVIDER_NAMES.claude!)];
  const stored = new Set((await creds?.instanceStatus().catch(() => undefined))?.names ?? []);
  return { names, present: names.some((n) => (env[n] ?? '') !== '' || stored.has(n)) };
}

/** The Enable factory checklist for the Local hub location. No network, nothing started. */
export async function localWorkerState(configDir: string, repoPath: string, creds: CredentialService | undefined, deps: LocalWorkerDeps = {}): Promise<LocalWorkerState> {
  const rec = await readLocalWorker(configDir, repoPath);
  const { source, blocked } = await sourceOf(repoPath, deps.exec ?? defaultExec);
  return {
    enabled: rec.enabled,
    ...(source !== undefined ? { source } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
    credentials: await credentialsOf(repoPath, creds, deps.env ?? process.env),
    ...(rec.doctor !== undefined ? { doctor: rec.doctor } : {}),
    ...(rec.lastPickupAt !== undefined ? { lastPickupAt: rec.lastPickupAt } : {}),
    ...(rec.lastPickup !== undefined ? { lastPickup: rec.lastPickup } : {}),
    ...(rec.lastError !== undefined ? { lastError: rec.lastError } : {}),
  };
}

/** Turn the switch on or off. Turning it on is refused (nothing is stored) without a servable task source or a credential; off always works. */
export async function setLocalWorker(configDir: string, repoPath: string, enabled: boolean, creds: CredentialService | undefined, deps: LocalWorkerDeps = {}): Promise<LocalWorkerState> {
  if (enabled) {
    const state = await localWorkerState(configDir, repoPath, creds, deps);
    if (state.blocked !== undefined) throw new BadRequestError(state.blocked);
    if (!state.credentials.present) {
      throw new BadRequestError(`The hub has no provider credential to run on: set ${state.credentials.names.join(' or ')} in the hub's environment or add one in Settings → Credentials.`);
    }
  }
  await updateLocalWorker(configDir, repoPath, (r) => ({ ...r, enabled }));
  return localWorkerState(configDir, repoPath, creds, deps);
}

/** The `taskcell doctor` command for a GitHub project, run against the project (not the hub's working directory). */
export function localDoctorCommand(repoPath: string, slug: string, trigger: string, provider?: string): PreflightCommand {
  const parsed = parseCli(['doctor', '--source', 'github', '--github-repo', slug, '--label', trigger, ...(provider !== undefined ? ['--provider', provider] : [])], repoPath);
  if (parsed.kind !== 'doctor') throw new BadRequestError(`could not build the doctor command: ${'message' in parsed ? String(parsed.message) : parsed.kind}`);
  return parsed as PreflightCommand;
}

/** Run the doctor's preflight checks on this machine and keep the result for the checklist. */
export async function runLocalDoctor(configDir: string, repoPath: string, creds: CredentialService | undefined, deps: LocalWorkerDeps = {}): Promise<LocalWorkerState> {
  const { source, slug, blocked } = await sourceOf(repoPath, deps.exec ?? defaultExec);
  if (blocked !== undefined) throw new BadRequestError(blocked);
  // shortcut: a hub-board project has no tracker for the doctor to check; give it the sandbox-only checks when the doctor grows them.
  if (source !== 'github' || slug === undefined) throw new BadRequestError('Run doctor checks a GitHub Issues project; a hub-board project is run by the board scheduler and has no doctor here yet.');
  const config = await readAppConfig(repoPath);
  const trigger = config.label?.trim() || DEFAULT_GITHUB_AGENT_LABEL;
  const provider = typeof config.provider === 'string' && config.provider.trim() !== '' ? config.provider.trim() : undefined;
  const report = await runPreflight(localDoctorCommand(repoPath, slug, trigger, provider), deps.env !== undefined ? { env: deps.env } : {});
  const doctor = { at: (deps.now?.() ?? new Date()).toISOString(), ok: report.ok, failed: report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.reason ?? 'failed'}`) };
  await updateLocalWorker(configDir, repoPath, (r) => ({ ...r, doctor }));
  return localWorkerState(configDir, repoPath, creds, deps);
}

/** Runs this hub holds for the worker, `repoPath\n#n`; they are not picked up twice, and count against the project's limit. */
export interface LocalWorkerMemory {
  live: Set<string>;
  /** Issues already handed to the session by this hub process: a run that left the trigger label behind is not retried in a loop. */
  seen: Set<string>;
}
export const localWorkerMemory = (): LocalWorkerMemory => ({ live: new Set(), seen: new Set() });

export interface LocalWorkerContext {
  configDir: string;
  runSession: RunSession;
  userCredentials?: CredentialService;
  allowlist: ProjectAllowlist;
  memory: LocalWorkerMemory;
  deps?: LocalWorkerDeps;
}

/** Hand one issue to the run session; resolves with the run id once the session took it, or the refusal. */
async function startIssue(ctx: LocalWorkerContext, repoPath: string, number: number, done: (r: CreateRunResult | Error) => void): Promise<string | Error> {
  const config = await readAppConfig(repoPath);
  const configured = config.provider;
  const provider = typeof configured === 'string' && configured.trim() !== '' ? configured : undefined;
  const flow = configuredFlow(config);
  let run!: Promise<CreateRunResult>;
  return new Promise<string | Error>((resolve) => {
    void (async () => {
      try {
        const credential = ctx.userCredentials !== undefined ? await ctx.userCredentials.resolveForRun(undefined, provider) : undefined;
        run = ctx.runSession.createRun(
          { issueRef: String(number), repoPath, transport: 'github', startedBy: LOCAL_WORKER_LOGIN, ...(provider !== undefined ? { provider } : {}), ...(flow !== undefined ? { flow } : {}) },
          { onStarted: (id) => resolve(id), onQueued: (id) => resolve(id) },
          credential,
        );
        run.then((r) => { resolve(''); done(r); }, (e: unknown) => { const err = e instanceof Error ? e : new Error(String(e)); resolve(err); done(err); });
      } catch (e) {
        resolve(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

/** One GitHub project: pick up open issues with the trigger label, as many as the project's limit leaves room for. Returns the numbers picked up. */
export async function pickUpIssues(ctx: LocalWorkerContext, repoPath: string, slug: string): Promise<number[]> {
  const { live, seen } = ctx.memory;
  const prefix = `${repoPath}\n`;
  const running = [...live].filter((k) => k.startsWith(prefix)).length;
  const room = (await parallelLimit(repoPath)) - running;
  if (room <= 0) return [];
  const trigger = (await readAppConfig(repoPath)).label?.trim() || DEFAULT_GITHUB_AGENT_LABEL;
  const gh = ctx.deps?.gh ?? defaultGhRunner;
  const issues = JSON.parse(await gh(['issue', 'list', '--repo', slug, '--label', trigger, '--state', 'open', '--json', 'number,labels', '--limit', String(ISSUE_LIMIT)])) as { number: number; labels: { name: string }[] }[];
  const picked: number[] = [];
  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    if (picked.length >= room) break;
    const names = issue.labels.map((l) => l.name);
    const key = `${prefix}#${issue.number}`;
    if (live.has(key) || seen.has(key)) continue;
    if (names.some((n) => STARTED_LABELS.some((s) => s.toLowerCase() === n.toLowerCase())) || hasLabel(names, GITHUB_WAITING_LABEL) || hasLabel(names, GITHUB_RATE_LIMITED_LABEL)) continue;
    // A label alone is not consent (as `taskcell watch`): an issue template can label an outsider's issue. A failed lookup fails closed.
    const author = await isTrustedIssueAuthor(slug, issue.number, undefined, gh);
    if (!author.trusted) {
      if (author.error !== undefined) {
        await updateLocalWorker(ctx.configDir, repoPath, (r) => ({ ...r, lastError: `#${issue.number}: author lookup failed: ${author.error}` }));
      } else {
        seen.add(key); // an untrusted author is not re-checked every tick
      }
      continue;
    }
    const admission = await startIssue(ctx, repoPath, issue.number, (end) => {
      live.delete(key);
      if (end instanceof Error) void updateLocalWorker(ctx.configDir, repoPath, (r) => ({ ...r, lastError: `#${issue.number}: ${failureMessage(end)}` })).catch(() => undefined);
    });
    if (typeof admission !== 'string') {
      // Refused before the session took it (no credential, queue full): retried next tick.
      await updateLocalWorker(ctx.configDir, repoPath, (r) => ({ ...r, lastError: failureMessage(admission) }));
      break;
    }
    live.add(key);
    seen.add(key);
    picked.push(issue.number);
    await recordPickup(ctx, repoPath, `#${issue.number}`);
  }
  return picked;
}

/** The record after a successful pick-up: it clears the last error. */
const withPickup = (r: LocalWorkerRecord, at: Date, what: string): LocalWorkerRecord => {
  const { lastError: _cleared, ...rest } = r;
  return { ...rest, lastPickupAt: at.toISOString(), lastPickup: what };
};

const recordPickup = (ctx: LocalWorkerContext, repoPath: string, what: string): Promise<unknown> =>
  updateLocalWorker(ctx.configDir, repoPath, (r) => withPickup(r, ctx.deps?.now?.() ?? new Date(), what));

/**
 * One worker pass over the projects whose switch is on. A project is served only while it is still registered and its task
 * source is still servable; a failure on one project is recorded on it and never stops the others.
 */
export async function sweepLocalWorkers(ctx: LocalWorkerContext): Promise<void> {
  for (const repoPath of await enabledProjects(ctx.configDir)) {
    try {
      if ((await ctx.allowlist.assertAllowed(repoPath).catch(() => undefined)) !== repoPath) continue;
      const { source, slug, blocked } = await sourceOf(repoPath, ctx.deps?.exec ?? defaultExec);
      if (blocked !== undefined || source === undefined) throw new BadRequestError(blocked ?? 'no task source');
      // A hub-board project is served by the board scheduler (sweepHubBoards), which reports its pick-ups through `recordBoardPickup`.
      if (source === 'github') await pickUpIssues(ctx, repoPath, slug!);
    } catch (e) {
      await updateLocalWorker(ctx.configDir, repoPath, (r) => ({ ...r, lastError: failureMessage(e) })).catch(() => undefined);
    }
  }
}

/** The board sweep serves every hub-board project it always did, except one whose worker switch was set off explicitly. */
export async function boardServed(configDir: string, repoPath: string): Promise<boolean> {
  return (await readAll(configDir))[repoPath]?.enabled !== false;
}

/** The board scheduler started tasks of a project whose switch is on: show them as the last pick-up. */
export async function recordBoardPickup(configDir: string, repoPath: string, ids: string[], now: Date = new Date()): Promise<void> {
  if (ids.length === 0 || !(await readLocalWorker(configDir, repoPath)).enabled) return;
  await updateLocalWorker(configDir, repoPath, (r) => withPickup(r, now, ids.join(', ')));
}
