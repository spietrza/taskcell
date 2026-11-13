// The Enable factory checklist (#hub): callers PR opened -> secret set -> PR merged -> doctor passed.
// `deriveFactoryState` is the pure state machine over a persisted `FactoryRecord`; `refreshFactory`
// re-checks the outstanding steps against GitHub (secret by NAME only — the hub never reads a secret
// value; PR state; doctor run status) and persists the result, so progress survives the dialog and a
// hub restart. The record lives in the hub's config dir, not in the repo: it never dirties the user's
// working tree and no committed file can feed it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultHubConfigDir } from './audit.js';
import { defaultExec, GITHUB_REPO_SLUG, githubSecretCommand, type FactoryExec } from './enable-factory.js';
import { listRemoteRuns } from './remote.js';
import type { FactoryPlan, FactoryState, FactoryStep, FactoryStepId } from '../wire.js';

/** What is persisted: facts only; the step statuses are always derived. */
export interface FactoryRecord {
  plan: FactoryPlan;
  /** The caller PR; absent when every caller was already on the default branch. */
  prUrl?: string;
  /** The PR was closed without merging. */
  prClosed?: boolean;
  secretSet: boolean;
  /** The callers are on the default branch (PR merged, or they were there already). */
  merged: boolean;
  doctor?: { url: string; status: string; conclusion: string };
  /** When the doctor workflow was dispatched (ISO); its run may not be listed yet. */
  doctorDispatchedAt?: string;
}

const STEP_ORDER: readonly FactoryStepId[] = ['pr', 'secret', 'merged', 'doctor'];

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\/actions\/runs\/(\d+)$/;

/** Every caller already on the default branch (under either name): no PR to open or merge. */
export function callersPresent(plan: FactoryPlan): boolean {
  const callers = new Set(plan.existingCallerFiles ?? []);
  return plan.callerFiles.every((f) => callers.has(f) || callers.has(f.replace('/taskcell-', '/vanguard-')));
}

export function newFactoryRecord(plan: FactoryPlan): FactoryRecord {
  return { plan, secretSet: false, merged: callersPresent(plan) };
}

/** Pure: the checklist a record means. `null` = never started. */
export function deriveFactoryState(rec: FactoryRecord | null): FactoryState {
  if (rec === null) {
    return { state: 'none', steps: STEP_ORDER.map((id) => ({ id, status: 'pending' as const })) };
  }
  const doctorDone = rec.doctor?.status === 'completed';
  const doctorPassed = doctorDone && rec.doctor?.conclusion === 'success';
  const failed: { id: FactoryStepId; reason: string } | undefined =
    rec.prClosed === true && !rec.merged
      ? { id: 'merged', reason: 'the callers PR was closed without merging' }
      : doctorDone && !doctorPassed
        ? { id: 'doctor', reason: `the doctor run ${rec.doctor?.conclusion || 'did not pass'}` }
        : undefined;
  const done: Record<FactoryStepId, boolean> = {
    pr: rec.prUrl !== undefined || rec.merged,
    // A passing doctor proves the secret works, even an org-level one `gh secret list --repo` cannot see.
    secret: rec.secretSet || doctorPassed,
    merged: rec.merged,
    doctor: doctorPassed,
  };
  const current = STEP_ORDER.find((id) => !done[id]);
  const steps: FactoryStep[] = STEP_ORDER.map((id) => ({
    id,
    status: failed?.id === id ? 'failed' : done[id] ? 'done' : id === current ? 'current' : 'pending',
  }));
  const base = {
    steps,
    plan: rec.plan,
    ...(rec.prUrl !== undefined ? { prUrl: rec.prUrl } : {}),
    secret: githubSecretCommand(rec.plan),
    ...(rec.doctor !== undefined ? { doctor: rec.doctor } : {}),
    ...(rec.doctorDispatchedAt !== undefined && rec.doctor === undefined ? { doctorPending: true } : {}),
  };
  if (failed !== undefined) return { state: 'broken', step: failed.id, reason: failed.reason, ...base };
  if (current === undefined) return { state: 'ready', ...base };
  return { state: 'setting-up', step: current, ...base };
}

function recordPath(repoPath: string): string {
  const key = createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 32);
  return join(defaultHubConfigDir(), 'factory', `${key}.json`);
}

/** The record is trusted input to a copy-ready shell command and to hrefs, so re-check the shapes on
 * read (a hand-edited or corrupt file reads as "never started"). */
function validRecord(raw: unknown): raw is FactoryRecord {
  const r = raw as Partial<FactoryRecord> | null;
  if (typeof r !== 'object' || r === null || typeof r.plan !== 'object' || r.plan === null) return false;
  const p = r.plan;
  if (typeof p.repoSlug !== 'string' || !GITHUB_REPO_SLUG.test(p.repoSlug)) return false;
  if (typeof r.secretSet !== 'boolean' || typeof r.merged !== 'boolean') return false;
  if (r.prUrl !== undefined && !(typeof r.prUrl === 'string' && PR_URL.test(r.prUrl))) return false;
  if (r.doctor !== undefined) {
    const d = r.doctor;
    if (typeof d !== 'object' || d === null || typeof d.url !== 'string' || !RUN_URL.test(d.url) || typeof d.status !== 'string' || typeof d.conclusion !== 'string') return false;
  }
  return true;
}

export async function readFactoryRecord(repoPath: string): Promise<FactoryRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath(repoPath), 'utf8'));
    return validRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Temp file + rename: a reader never sees a half-written record. */
async function writeFactoryRecordFile(repoPath: string, rec: FactoryRecord): Promise<void> {
  const path = recordPath(repoPath);
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

// Read-modify-write is serialised per repo, so a refresh cannot clobber a concurrent apply/verify.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath);
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => undefined));
  return run;
}

export function writeFactoryRecord(repoPath: string, rec: FactoryRecord): Promise<void> {
  return withLock(repoPath, () => writeFactoryRecordFile(repoPath, rec));
}

/** Read-modify-write one project's record (creating it from `plan` when absent). */
export function updateFactoryRecord(repoPath: string, plan: FactoryPlan, change: (r: FactoryRecord) => FactoryRecord): Promise<FactoryRecord> {
  return withLock(repoPath, async () => {
    const next = change((await readFactoryRecord(repoPath)) ?? newFactoryRecord(plan));
    await writeFactoryRecordFile(repoPath, next);
    return next;
  });
}

export async function factoryState(repoPath: string): Promise<FactoryState> {
  return deriveFactoryState(await readFactoryRecord(repoPath));
}

/** Clock skew allowance when matching a dispatched doctor run by creation time. */
const DISPATCH_SKEW_MS = 60_000;

/** Re-check what is outstanding, persist, and return the new state. A check that fails (offline,
 * `gh` signed out) leaves its step as it was: the checklist never goes backwards on a network error. */
export async function refreshFactory(repoPath: string, deps: { exec?: FactoryExec } = {}): Promise<FactoryState> {
  const exec = deps.exec ?? defaultExec;
  const rec = await readFactoryRecord(repoPath);
  if (rec === null) return deriveFactoryState(null);
  // Only the facts learned here are applied, onto a fresh read, so a concurrent update is not lost.
  const found: Partial<FactoryRecord> = {};

  if (!rec.secretSet) {
    try {
      // Names only: `gh secret list` never returns a value.
      const { stdout } = await exec('gh', ['secret', 'list', '--repo', rec.plan.repoSlug, '--json', 'name'], { cwd: repoPath });
      const names = (JSON.parse(stdout) as Array<{ name?: unknown }>).map((s) => s.name);
      if (names.includes(githubSecretCommand(rec.plan).secretName)) found.secretSet = true;
    } catch { /* keep as is */ }
  }

  if (!rec.merged && rec.prUrl !== undefined) {
    try {
      const { stdout } = await exec('gh', ['pr', 'view', rec.prUrl, '--json', 'state'], { cwd: repoPath });
      const state = (JSON.parse(stdout) as { state?: unknown }).state;
      if (state === 'MERGED') found.merged = true;
      found.prClosed = state === 'CLOSED';
    } catch { /* keep as is */ }
  }

  if (rec.doctor !== undefined && rec.doctor.status !== 'completed') {
    const id = RUN_URL.exec(rec.doctor.url)?.[1];
    try {
      const run = (await listRemoteRuns(repoPath, exec)).find((r) => r.url === rec.doctor?.url);
      if (run !== undefined) {
        found.doctor = { url: run.url, status: run.status, conclusion: run.conclusion };
      } else if (id !== undefined) {
        // Older than the newest runs `gh run list` returns: ask for it by id.
        const { stdout } = await exec('gh', ['run', 'view', id, '--json', 'status,conclusion'], { cwd: repoPath });
        const v = JSON.parse(stdout) as { status?: unknown; conclusion?: unknown };
        if (typeof v.status === 'string') found.doctor = { url: rec.doctor.url, status: v.status, conclusion: typeof v.conclusion === 'string' ? v.conclusion : '' };
      }
    } catch { /* keep as is */ }
  } else if (rec.doctor === undefined && rec.doctorDispatchedAt !== undefined) {
    // Dispatched, but the run was not listed yet when verify gave up: pick it up now.
    try {
      const since = Date.parse(rec.doctorDispatchedAt) - DISPATCH_SKEW_MS;
      const run = (await listRemoteRuns(repoPath, exec)).find(
        (r) => (r.workflow === 'Taskcell Doctor' || r.workflow === 'Vanguard Doctor') && r.event === 'workflow_dispatch' && Date.parse(r.createdAt) >= since && RUN_URL.test(r.url),
      );
      if (run !== undefined) found.doctor = { url: run.url, status: run.status, conclusion: run.conclusion };
    } catch { /* keep as is */ }
  }

  const next = await updateFactoryRecord(repoPath, rec.plan, (fresh) => {
    const merged = fresh.merged || found.merged === true;
    return {
      ...fresh,
      secretSet: fresh.secretSet || found.secretSet === true,
      merged,
      ...(found.prClosed !== undefined && !merged && fresh.prUrl === rec.prUrl ? { prClosed: found.prClosed } : {}),
      // Never overwrite a doctor result from a newer dispatch that landed meanwhile.
      ...(found.doctor !== undefined && (fresh.doctor === undefined || fresh.doctor.url === found.doctor.url) ? { doctor: found.doctor } : {}),
    };
  });
  return deriveFactoryState(next);
}
