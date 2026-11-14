// Enable factory for GitLab CI (#hub): the GitLab twin of the GitHub adapter in enable-factory.ts.
// plan (read the project through `glab`), apply (branch + `.gitlab/taskcell.yml` + an include in
// `.gitlab-ci.yml` + a merge request — NEVER a push to the default branch), secret (the
// `glab variable set` command text only; the hub checks the variable NAME, never a value), verify
// (start a doctor pipeline once the MR is merged and report the pipeline it created).
// Every glab/git failure a user can hit (no remote, no sign-in, no permission) is turned into one
// plain sentence; raw command output never reaches the UI.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { gitlabProjectFromRemote, isKnownGitlabRemote, remoteHostname } from '../runners/gitlab.js';
import { encodeProject } from '../tasks/gitlab.js';
import { resolveVerifyCommand } from '../pipeline/verify.js';
import { NO_REMOTE_MESSAGE } from '../wire.js';
import { defaultExec, DISPATCH_SKEW_MS, detectScripts, enableFactory, enableFactoryBranch, FACTORY_LABELS, VERIFY_POLL_MS, VERIFY_POLLS, type FactoryExec, type FactoryProvider } from './enable-factory.js';
import type { FactoryApplyResult, FactoryHost, FactoryPlan, FactoryProviderId, FactorySecretStep, FactoryVerifyResult } from '../wire.js';
import type { FactoryRecord } from './factory-checklist.js';

export interface GitlabFactoryDeps {
  exec?: FactoryExec;
  /** Wait between `verify`'s polls for the started pipeline; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/** GitLab project path: `group/project` or `group/subgroup/project`; it reaches argv, URLs and the persisted checklist. */
export const GITLAB_PROJECT_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/;
export const GITLAB_LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
export const GITLAB_MR_URL = /^https?:\/\/[^/\s]+\/[^\s]+\/-\/merge_requests\/(\d+)$/;
export const GITLAB_PIPELINE_URL = /^https?:\/\/[^/\s]+\/[^\s]+\/-\/pipelines\/(\d+)$/;

const GITLAB_INCLUDE_FILE = '.gitlab/taskcell.yml';
const GITLAB_CI_FILE = '.gitlab-ci.yml';
const INCLUDE_LINES = `include:\n  - local: ${GITLAB_INCLUDE_FILE}\n`;
const TEMPLATE = new URL('../../templates/gitlab/taskcell.yml', import.meta.url);
const SECRET_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Like `factoryPlanTargets()`: what `apply` touches, derived from this process's constants, never from a client's plan. */
export function gitlabPlanTargets(): Pick<FactoryPlan, 'callerFiles' | 'labels'> {
  return { callerFiles: [GITLAB_CI_FILE, GITLAB_INCLUDE_FILE], labels: FACTORY_LABELS.map((l) => l.name) };
}

/** One plain sentence for a failed glab/git call; the raw output is dropped. */
function plainSentence(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  // The command's own error output only: `message` carries argv, whose ids (merge_requests/404) would read as HTTP codes.
  const text = String(e.stderr ?? '');
  console.warn('enable-factory (gitlab):', String(e.message ?? err).split('\n')[0]);
  if (e.code === 'ENOENT') return 'glab is not installed; install the GitLab CLI and run `glab auth login`, then try again.';
  if (/401|unauthori[sz]ed|not logged in|authenticat|no token|invalid token|auth login/i.test(text)) return 'glab is not signed in to GitLab; run `glab auth login`, then try again.';
  if (/403|forbidden|permission|insufficient|not allowed/i.test(text)) return 'Your GitLab account does not have permission to do this on the project (it needs Developer access or higher).';
  if (/404|not found/i.test(text)) return 'GitLab could not find the project, or your account cannot see it; check the remote and `glab auth status`.';
  return 'GitLab did not accept the request; check `glab auth status` and that your account can push to the project.';
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError(plainSentence(err));
  }
}

const glab = (exec: FactoryExec, repoPath: string, args: string[]): Promise<string> =>
  guarded(async () => (await exec('glab', args, { cwd: repoPath })).stdout.trim());

async function glabJson(exec: FactoryExec, repoPath: string, args: string[]): Promise<unknown> {
  const out = await glab(exec, repoPath, args);
  try {
    return JSON.parse(out);
  } catch {
    throw new BadRequestError('GitLab returned an unexpected answer; check `glab auth status` and try again.');
  }
}

const gitRaw = async (exec: FactoryExec, repoPath: string, args: string[]): Promise<string> => (await exec('git', args, { cwd: repoPath })).stdout;
const git = async (exec: FactoryExec, repoPath: string, args: string[]): Promise<string> => (await gitRaw(exec, repoPath, args)).trim();

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** The `origin` URL: null when the project has no remote at all, '' when it has remotes but no `origin`. */
async function readOrigin(exec: FactoryExec, repoPath: string): Promise<string | null> {
  const remotes = await git(exec, repoPath, ['remote']).catch(() => '');
  if (remotes === '') return null;
  return git(exec, repoPath, ['remote', 'get-url', 'origin']).catch(() => '');
}

/** The `origin` URL, or a plain refusal when the project has no remote. */
async function originUrl(exec: FactoryExec, repoPath: string): Promise<string> {
  const url = await readOrigin(exec, repoPath);
  if (url === null) throw new BadRequestError(NO_REMOTE_MESSAGE);
  if (url === '') throw new BadRequestError('This project has no `origin` remote; add one that points at GitLab, then try again.');
  return url;
}

/** Which code host `origin` is on — drives which run locations the dialog offers. GitLab = gitlab.com or the GITLAB_HOST host. */
export async function factoryHostOf(repoPath: string, deps: GitlabFactoryDeps = {}): Promise<FactoryHost> {
  const exec = deps.exec ?? defaultExec;
  const url = await readOrigin(exec, repoPath);
  if (url === null) return 'none';
  if (url === '') return 'other';
  if (isKnownGitlabRemote(url)) return 'gitlab';
  return remoteHostname(url) === 'github.com' ? 'github' : 'other';
}

/** Mapped onto the GitHub-style status/conclusion the checklist already derives its state from. */
export function pipelineResult(status: string): { status: string; conclusion: string } {
  switch (status) {
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failed':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
    case 'canceling':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'skipped':
      return { status: 'completed', conclusion: 'skipped' };
    case 'running':
      return { status: 'in_progress', conclusion: '' };
    default:
      return { status: 'queued', conclusion: '' };
  }
}

interface BaseState {
  includeFile: boolean;
  /** `.gitlab-ci.yml` on the base, `undefined` when there is none. */
  ci?: string;
}

/** What the default branch already has — read from the local remote-tracking ref, no network. */
async function baseState(exec: FactoryExec, repoPath: string, base: string): Promise<BaseState> {
  const show = (file: string): Promise<string | undefined> => gitRaw(exec, repoPath, ['show', `origin/${base}:${file}`]).catch(() => undefined);
  const [inc, ci] = await Promise.all([show(GITLAB_INCLUDE_FILE), show(GITLAB_CI_FILE)]);
  return { includeFile: inc !== undefined, ...(ci !== undefined ? { ci } : {}) };
}

/** `.gitlab-ci.yml` includes the file: a line naming it as an include entry, not a comment or an unrelated key. */
const WIRED = /^[ \t]*(?:-[ \t]+)?(?:include:[ \t]*)?(?:local:[ \t]*)?['"]?\/?\.gitlab\/taskcell\.yml['"]?[ \t]*$/m;
const wired = (ci: string | undefined): boolean => ci !== undefined && WIRED.test(ci);

export async function planGitlabFactory(repoPath: string, deps: GitlabFactoryDeps = {}): Promise<FactoryPlan> {
  const exec = deps.exec ?? defaultExec;
  const origin = await originUrl(exec, repoPath);
  if (!isKnownGitlabRemote(origin)) {
    throw new BadRequestError('This project\'s remote is not on GitLab (gitlab.com, or the host named by GITLAB_HOST), so GitLab CI cannot be enabled for it.');
  }
  const repoSlug = gitlabProjectFromRemote(origin) ?? '';
  if (!GITLAB_PROJECT_PATH.test(repoSlug)) throw new BadRequestError('Could not read the GitLab project (group/project) from the `origin` remote; fix the remote and try again.');

  const user = obj(await glabJson(exec, repoPath, ['api', 'user']));
  const project = obj(await glabJson(exec, repoPath, ['api', `projects/${encodeProject(repoSlug)}`]));
  const login = str(user.username);
  const defaultBranch = str(project.default_branch);
  if (login === '') throw new BadRequestError('glab is not signed in to GitLab; run `glab auth login`, then try again.');
  if (defaultBranch === '') throw new BadRequestError('The GitLab project has no default branch yet; push one first, then try again.');
  const [{ packageManager, scripts }, verifyCommand, base] = await Promise.all([
    detectScripts(repoPath),
    resolveVerifyCommand(repoPath),
    baseState(exec, repoPath, defaultBranch).catch((): BaseState => ({ includeFile: false })),
  ]);
  return {
    provider: 'gitlab',
    repoSlug,
    defaultBranch,
    login,
    packageManager,
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    scripts,
    ...gitlabPlanTargets(),
    existingCallerFiles: [...(base.includeFile ? [GITLAB_INCLUDE_FILE] : []), ...(wired(base.ci) ? [GITLAB_CI_FILE] : [])],
  };
}

/** The open MR from the factory branch into the default branch, '' when there is none. */
async function openMr(exec: FactoryExec, repoPath: string, plan: FactoryPlan, branch: string): Promise<string> {
  const q = `state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(plan.defaultBranch)}`;
  const list = await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/merge_requests?${q}`]);
  const url = Array.isArray(list) ? str(obj(list[0]).web_url) : '';
  return GITLAB_MR_URL.test(url) ? url : '';
}

/** The `.gitlab-ci.yml` text with the include added; `undefined` when its `include:` is in a form not safe to edit (the MR then adds only the include file and says so). */
function withInclude(ci: string): string | undefined {
  const top = /^include[ \t]*:/m.exec(ci);
  if (top === undefined || top === null) {
    const doc = /^---[^\n]*\n/.exec(ci)?.[0] ?? '';
    return `${doc}${INCLUDE_LINES}\n${ci.slice(doc.length)}`;
  }
  // A block list directly under `include:`: add an entry at the list's own indent.
  const lineEnd = ci.indexOf('\n', top.index);
  const header = ci.slice(top.index, lineEnd === -1 ? undefined : lineEnd);
  const next = lineEnd === -1 ? undefined : /^([ \t]*)- /.exec(ci.slice(lineEnd + 1));
  if (!/^include[ \t]*:[ \t]*(#.*)?$/.test(header) || next === undefined || next === null) return undefined;
  return `${ci.slice(0, lineEnd + 1)}${next[1]}- local: ${GITLAB_INCLUDE_FILE}\n${ci.slice(lineEnd + 1)}`;
}

/**
 * Branch from `origin/<default>`, add `.gitlab/taskcell.yml` and the include in `.gitlab-ci.yml` (what
 * the base lacks), push the branch and open a merge request into the default branch (never push TO
 * it). Re-runnable: the branch is reset, the commit skipped when nothing changed, an open MR reused,
 * labels created idempotently. The checked-out branch is restored afterwards.
 */
export async function applyGitlabFactory(repoPath: string, plan: FactoryPlan, deps: GitlabFactoryDeps = {}): Promise<FactoryApplyResult> {
  const exec = deps.exec ?? defaultExec;
  const branch = enableFactoryBranch();
  if (branch === plan.defaultBranch) throw new BadRequestError('refusing to use the default branch as the enable-factory branch');

  if ((await git(exec, repoPath, ['status', '--porcelain', '--untracked-files=no'])) !== '') {
    throw new BadRequestError('the working tree has uncommitted changes; commit or stash them before enabling the factory');
  }
  const { callerFiles } = gitlabPlanTargets();
  const local = await git(exec, repoPath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', ...callerFiles]);
  if (local !== '') {
    throw new BadRequestError(`uncommitted CI files at the factory paths would be overwritten:\n${local}\ncommit, move or delete them before enabling the factory`);
  }
  const head = await git(exec, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const original = head === 'HEAD' ? await git(exec, repoPath, ['rev-parse', 'HEAD']) : head;

  await guarded(() => git(exec, repoPath, ['fetch', 'origin', plan.defaultBranch]));
  const base = await baseState(exec, repoPath, plan.defaultBranch);
  let changed: boolean;
  let manualInclude = false;
  await guarded(() => git(exec, repoPath, ['checkout', '-B', branch, `origin/${plan.defaultBranch}`]));
  try {
    const written: string[] = [];
    if (!base.includeFile) {
      await mkdir(join(repoPath, '.gitlab'), { recursive: true });
      await writeFile(join(repoPath, GITLAB_INCLUDE_FILE), await readFile(TEMPLATE, 'utf8'));
      written.push(GITLAB_INCLUDE_FILE);
    }
    const edited = wired(base.ci) ? undefined : base.ci === undefined ? INCLUDE_LINES : withInclude(base.ci);
    manualInclude = !wired(base.ci) && edited === undefined;
    if (edited !== undefined) {
      await writeFile(join(repoPath, GITLAB_CI_FILE), edited);
      written.push(GITLAB_CI_FILE);
    }
    if (written.length > 0) await git(exec, repoPath, ['add', ...written]);
    changed = written.length > 0 && (await git(exec, repoPath, ['status', '--porcelain', '--', ...written])) !== '';
    if (changed) {
      await guarded(() => git(exec, repoPath, ['commit', '-m', 'feat: enable the Taskcell factory (GitLab CI)', '--', ...written]));
      // The hub's own fixed branch, never plan.defaultBranch; --force replaces an earlier apply's commit.
      await guarded(() => git(exec, repoPath, ['push', '--force', '-u', 'origin', branch]));
    }
  } finally {
    await git(exec, repoPath, ['checkout', '-f', original]);
  }

  const labelsCreated: string[] = [];
  for (const label of FACTORY_LABELS) {
    try {
      await exec('glab', ['label', 'create', '--name', label.name, '--color', `#${label.color}`], { cwd: repoPath });
    } catch (err) {
      // A label that already exists is what we want; anything else (permission, sign-in) is not.
      const text = `${String((err as { stderr?: unknown }).stderr ?? '')} ${String((err as { message?: unknown }).message ?? '')}`;
      if (!/already|taken|exists/i.test(text)) throw new BadRequestError(plainSentence(err));
    }
    labelsCreated.push(label.name);
  }

  const open = await openMr(exec, repoPath, plan, branch);
  if (open !== '') return { branch, prUrl: open, labelsCreated };
  if (!changed) throw new BadRequestError(`the factory jobs are already on ${plan.defaultBranch}; nothing to open a merge request for`);

  await glab(exec, repoPath, [
    'mr', 'create',
    '--source-branch', branch,
    '--target-branch', plan.defaultBranch,
    '--title', 'feat: enable the Taskcell factory (GitLab CI)',
    '--description', `Adds the Taskcell factory jobs (doctor, implement, review) as \`${GITLAB_INCLUDE_FILE}\`, included from \`${GITLAB_CI_FILE}\`. Set the masked CI/CD variables \`${SECRET_NAME}\` and \`GITLAB_TOKEN\` before running the doctor pipeline.${manualInclude ? ` Your \`.gitlab-ci.yml\` has an \`include:\` the hub does not edit: add \`- local: ${GITLAB_INCLUDE_FILE}\` to it by hand before merging.` : ''} See docs/hub.md.`,
    '--yes',
  ]);
  const prUrl = await openMr(exec, repoPath, plan, branch);
  if (prUrl === '') throw new BadRequestError('The merge request was created but GitLab did not list it; open the project on GitLab to find it.');
  return { branch, prUrl, labelsCreated };
}

/** The variable step: command text only. No `exec` here — it cannot run `glab variable set`, so the hub never handles the value. */
export function gitlabSecretCommand(plan: FactoryPlan): FactorySecretStep {
  // glab does not prompt for the value: it reads stdin, so the token is read silently and piped.
  return { secretName: SECRET_NAME, command: `read -rsp 'Token: ' T && printf %s "$T" | glab variable set ${SECRET_NAME} --masked --repo ${plan.repoSlug}` };
}

/** Whether the project has the CI/CD variable, by NAME: one GET for that key (404 = absent); the body is not read. Needs Maintainer access, so a Developer's check fails and the doctor passing marks the step instead. */
export async function gitlabVariableExists(repoPath: string, plan: FactoryPlan, exec: FactoryExec = defaultExec): Promise<boolean> {
  try {
    await exec('glab', ['api', `projects/${encodeProject(plan.repoSlug)}/variables/${SECRET_NAME}`], { cwd: repoPath });
    return true;
  } catch (err) {
    if (/404/.test(String((err as { stderr?: unknown }).stderr ?? ''))) return false;
    throw new BadRequestError(plainSentence(err));
  }
}

/** The MR's state: merged / closed / opened. */
async function gitlabMrState(repoPath: string, plan: FactoryPlan, mrUrl: string, exec: FactoryExec = defaultExec): Promise<string> {
  const iid = GITLAB_MR_URL.exec(mrUrl)?.[1];
  if (iid === undefined) return '';
  return str(obj(await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/merge_requests/${iid}`])).state);
}

interface PipelineRow { id: number; url: string; status: string; createdAt: string }

async function listPipelines(exec: FactoryExec, repoPath: string, plan: FactoryPlan): Promise<PipelineRow[]> {
  const q = `ref=${encodeURIComponent(plan.defaultBranch)}&source=api&per_page=20`;
  const list = await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/pipelines?${q}`]);
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({ id: typeof obj(p).id === 'number' ? (obj(p).id as number) : 0, url: str(obj(p).web_url), status: str(obj(p).status), createdAt: str(obj(p).created_at) }))
    .filter((p) => p.id > 0 && GITLAB_PIPELINE_URL.test(p.url));
}

/** The doctor's own result: the status of its `taskcell-doctor` job, so the project's other jobs in the same pipeline do not decide it; the pipeline's status until that job exists. */
async function doctorResult(exec: FactoryExec, repoPath: string, plan: FactoryPlan, id: string | number, pipelineStatus: string): Promise<{ status: string; conclusion: string }> {
  try {
    const jobs = await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/pipelines/${id}/jobs?per_page=100`]);
    const job = Array.isArray(jobs) ? jobs.find((j) => obj(j).name === 'taskcell-doctor') : undefined;
    if (job !== undefined) return pipelineResult(str(obj(job).status));
  } catch { /* fall back to the pipeline */ }
  return pipelineResult(pipelineStatus);
}

/** Start the doctor pipeline (`TASKCELL_DOCTOR=true` on the default branch) and report the pipeline that start created. */
export async function verifyGitlabFactory(repoPath: string, plan: FactoryPlan, deps: GitlabFactoryDeps = {}): Promise<FactoryVerifyResult> {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seen = new Set((await listPipelines(exec, repoPath, plan)).map((p) => p.id));
  await glab(exec, repoPath, ['ci', 'run', '--branch', plan.defaultBranch, '--variables', 'TASKCELL_DOCTOR:true']);
  for (let attempt = 0; attempt < VERIFY_POLLS; attempt++) {
    await sleep(VERIFY_POLL_MS);
    const created = (await listPipelines(exec, repoPath, plan)).find((p) => !seen.has(p.id));
    if (created !== undefined) return { dispatched: true, run: { url: created.url, ...(await doctorResult(exec, repoPath, plan, created.id, created.status)) } };
  }
  return { dispatched: true };
}

/** The facts `refreshFactory` learns for a GitLab record; a failed check leaves its step as it was. */
export async function gitlabFound(repoPath: string, rec: FactoryRecord, exec: FactoryExec = defaultExec): Promise<Partial<FactoryRecord>> {
  const found: Partial<FactoryRecord> = {};
  if (!rec.secretSet) {
    try {
      if (await gitlabVariableExists(repoPath, rec.plan, exec)) found.secretSet = true;
    } catch { /* keep as is */ }
  }
  if (!rec.merged && rec.prUrl !== undefined) {
    try {
      const state = await gitlabMrState(repoPath, rec.plan, rec.prUrl, exec);
      if (state === 'merged') found.merged = true;
      found.prClosed = state === 'closed';
    } catch { /* keep as is */ }
  }
  if (rec.doctor !== undefined && rec.doctor.status !== 'completed') {
    const id = GITLAB_PIPELINE_URL.exec(rec.doctor.url)?.[1];
    try {
      const status = id === undefined ? '' : str(obj(await glabJson(exec, repoPath, ['api', `projects/${encodeProject(rec.plan.repoSlug)}/pipelines/${id}`])).status);
      if (status !== '' && id !== undefined) found.doctor = { url: rec.doctor.url, ...(await doctorResult(exec, repoPath, rec.plan, id, status)) };
    } catch { /* keep as is */ }
  } else if (rec.doctor === undefined && rec.doctorDispatchedAt !== undefined) {
    try {
      const since = Date.parse(rec.doctorDispatchedAt) - DISPATCH_SKEW_MS;
      const run = (await listPipelines(exec, repoPath, rec.plan)).find((p) => Date.parse(p.createdAt) >= since);
      if (run !== undefined) found.doctor = { url: run.url, ...(await doctorResult(exec, repoPath, rec.plan, run.id, run.status)) };
    } catch { /* keep as is */ }
  }
  return found;
}

function gitlabFactoryProvider(repoPath: string, deps: GitlabFactoryDeps = {}): FactoryProvider {
  return {
    plan: () => planGitlabFactory(repoPath, deps),
    apply: (plan) => applyGitlabFactory(repoPath, plan, deps),
    secretCommand: (plan) => gitlabSecretCommand(plan),
    verify: (plan) => verifyGitlabFactory(repoPath, plan, deps),
  };
}

/** The adapter for `provider`: GitHub Actions or GitLab CI (Linear has none yet, and `enableFactory` says so). */
export function factoryProviderFor(repoPath: string, provider: FactoryProviderId): FactoryProvider {
  return provider === 'gitlab' ? gitlabFactoryProvider(repoPath) : enableFactory(repoPath, provider);
}
