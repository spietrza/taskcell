// Enable factory for GitLab CI (#hub): the GitLab twin of the GitHub adapter in enable-factory.ts.
// plan (read the project through `glab`), apply (branch + `.gitlab/taskcell.yml` + an include in
// `.gitlab-ci.yml` + a merge request — NEVER a push to the default branch), secret (the
// `glab variable set` command text only; the hub checks the variable NAME, never a value), verify
// (start a doctor pipeline once the MR is merged and report the pipeline it created).
// Every glab/git failure a user can hit (no remote, no sign-in, no permission) is turned into one
// plain sentence; raw command output never reaches the UI.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, parseAllDocuments, YAMLSeq } from 'yaml';
import { BadRequestError } from '../sidecar/sidecar.js';
import { gitlabProjectFromRemote, isKnownGitlabRemote, remoteHostname } from '../runners/gitlab.js';
import { encodeProject } from '../tasks/gitlab.js';
import { resolveVerifyCommand } from '../pipeline/verify.js';
import { NO_REMOTE_MESSAGE } from '../wire.js';
import { defaultExec, detectScripts, enableFactory, enableFactoryBranch, FACTORY_LABELS, VERIFY_POLL_MS, VERIFY_POLLS, type FactoryExec, type FactoryProvider } from './enable-factory.js';
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
export const GITLAB_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export const GITLAB_MR_URL = /^https?:\/\/[^/\s]+\/[^\s]+\/-\/merge_requests\/(\d+)$/;
export const GITLAB_PIPELINE_URL = /^https?:\/\/[^/\s]+\/[^\s]+\/-\/pipelines\/(\d+)$/;

const GITLAB_INCLUDE_FILE = '.gitlab/taskcell.yml';
const GITLAB_CI_FILE = '.gitlab-ci.yml';
const INCLUDE_LINES = `include:\n  - local: ${GITLAB_INCLUDE_FILE}\n`;
const TEMPLATE = new URL('../../templates/gitlab/taskcell.yml', import.meta.url);
const SECRET_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';
const LOGIN_PLACEHOLDER = 'YOUR_GITLAB_LOGIN';

/** Like `factoryPlanTargets()`: what `apply` touches, derived from this process's constants, never from a client's plan. */
export function gitlabPlanTargets(): Pick<FactoryPlan, 'callerFiles' | 'labels'> {
  return { callerFiles: [GITLAB_CI_FILE, GITLAB_INCLUDE_FILE], labels: FACTORY_LABELS.map((l) => l.name) };
}

/** An HTTP status where glab prints one (`HTTP 404`, `...: 404 {message}`), never digits inside a URL, id or branch name. */
const httpStatus = (text: string, code: number): boolean => new RegExp(`(?:\\bHTTP |: |^)${code}\\b`, 'm').test(text);

/** One plain sentence for a failed glab/git call; the raw output is dropped. */
function plainSentence(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  // The command's own error output only: `message` carries argv, whose ids (merge_requests/404) would read as HTTP codes.
  const text = String(e.stderr ?? '');
  console.warn('enable-factory (gitlab):', String(e.message ?? err).split('\n')[0], text.trim().split('\n')[0] ?? '');
  // A local git failure (hook, index.lock, checkout conflict) is not GitLab's; fetch and push talk to GitLab, so they fall through.
  const gitCommand = (err as { gitCommand?: unknown }).gitCommand;
  if (typeof gitCommand === 'string' && e.code === 'ENOENT') return 'git is not installed or not on the hub\'s PATH; install git, then try again.';
  if (typeof gitCommand === 'string' && gitCommand !== 'fetch' && gitCommand !== 'push') return 'git could not prepare the branch; see the hub log for the details.';
  if (e.code === 'ENOENT') return 'glab is not installed; install the GitLab CLI and run `glab auth login`, then try again.';
  if (httpStatus(text, 401) || /unauthori[sz]ed|not logged in|authenticat|no token|invalid token|auth login/i.test(text)) return 'glab is not signed in to GitLab; run `glab auth login`, then try again.';
  if (httpStatus(text, 403) || /forbidden|permission|insufficient|not allowed/i.test(text)) return 'Your GitLab account does not have permission to do this on the project (it needs Developer access or higher).';
  if (httpStatus(text, 404) || /not found/i.test(text)) return 'GitLab could not find the project, or your account cannot see it; check the remote and `glab auth status`.';
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

/** Every `glab` call goes to the host `origin` is on, whatever GITLAB_HOST or other remotes the hub's environment has. */
const onHost = (exec: FactoryExec, host: string | undefined): FactoryExec => (file, args, options) =>
  exec(file, args, file === 'glab' ? { ...options, env: { GITLAB_HOST: host ?? 'gitlab.com' } } : options);

/** `glab label|mr|ci` resolve the project from the checkout's remotes unless told: always name the plan's project. */
const glabProject = (exec: FactoryExec, repoPath: string, plan: FactoryPlan, args: string[]): Promise<string> =>
  glab(exec, repoPath, [...args, '--repo', plan.repoSlug]);

async function glabJson(exec: FactoryExec, repoPath: string, args: string[]): Promise<unknown> {
  const out = await glab(exec, repoPath, args);
  try {
    return JSON.parse(out);
  } catch {
    throw new BadRequestError('GitLab returned an unexpected answer; check `glab auth status` and try again.');
  }
}

const gitRaw = async (exec: FactoryExec, repoPath: string, args: string[]): Promise<string> => {
  try {
    return (await exec('git', args, { cwd: repoPath })).stdout;
  } catch (err) {
    if (typeof err === 'object' && err !== null) (err as { gitCommand?: string }).gitCommand = args[0] ?? '';
    throw err;
  }
};
const git = async (exec: FactoryExec, repoPath: string, args: string[]): Promise<string> => (await gitRaw(exec, repoPath, args)).trim();

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** The `origin` URL: null when the project has no remote at all, '' when it has remotes but no `origin`. */
export async function readOrigin(exec: FactoryExec, repoPath: string): Promise<string | null> {
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
  return hostOfOrigin(await readOrigin(deps.exec ?? defaultExec, repoPath));
}

/** {@link factoryHostOf} for an origin already read with {@link readOrigin}. */
export function hostOfOrigin(url: string | null): FactoryHost {
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
async function baseState(exec: FactoryExec, repoPath: string, base: string, ciPath = GITLAB_CI_FILE): Promise<BaseState> {
  const show = (file: string): Promise<string | undefined> => gitRaw(exec, repoPath, ['show', `origin/${base}:${file}`]).catch(() => undefined);
  const [inc, ci] = await Promise.all([show(GITLAB_INCLUDE_FILE), show(ciPath)]);
  return { includeFile: inc !== undefined, ...(ci !== undefined ? { ci } : {}) };
}

function pipelineYaml(ci: string): ReturnType<typeof parseAllDocuments> | undefined {
  const docs = parseAllDocuments(ci);
  if (docs.length === 0 || docs.some((doc) => doc.errors.length > 0) || !isMap(docs.at(-1)?.contents)) return undefined;
  return docs;
}

/** The value of a top-level key of the pipeline document (`undefined` when absent or the document is not a usable map). */
function rootValue(ci: string | undefined, key: string): unknown {
  const root = ci === undefined ? undefined : pipelineYaml(ci)?.at(-1)?.contents;
  return isMap(root) ? root.items.find((pair) => isScalar(pair.key) && pair.key.value === key)?.value : undefined;
}

function isTaskcellPath(value: unknown): boolean {
  return typeof value === 'string' && value.replace(/^\//, '') === GITLAB_INCLUDE_FILE;
}

/** The pipeline document's top-level `include` names the Taskcell file, never a comment or a similarly shaped job field. */
const wired = (ci: string | undefined): boolean => {
  const include = rootValue(ci, 'include');
  if (isScalar(include)) return isTaskcellPath(include.value);
  if (isSeq(include)) {
    return include.items.some((item) => {
      if (isScalar(item)) return isTaskcellPath(item.value);
      if (!isMap(item)) return false;
      return item.items.some((pair) => isScalar(pair.key) && pair.key.value === 'local' && isScalar(pair.value) && isTaskcellPath(pair.value.value));
    });
  }
  return isMap(include) && include.items.some((pair) => isScalar(pair.key) && pair.key.value === 'local' && isScalar(pair.value) && isTaskcellPath(pair.value.value));
};

const GLOBAL_CI_KEYS = new Set([
  'after_script', 'before_script', 'cache', 'default', 'image', 'include', 'pages', 'services',
  'stages', 'types', 'variables', 'workflow',
]);

/** A stage for the factory jobs: `test` (GitLab's default) unless the project declares `stages:` without it. */
function factoryStage(ci: string | undefined): string {
  const stages = rootValue(ci, 'stages');
  if (!isSeq(stages)) return 'test';
  const names = stages.items.flatMap((item) => (isScalar(item) && typeof item.value === 'string' ? [item.value] : []));
  if (names.length === 0 || names.includes('test')) return 'test';
  return names.find((name) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) ?? 'test';
}

/** One runner tag: non-empty, at most 255 characters, no edge whitespace, and none of `,`, `"`, `\`, control characters or line separators (the tags are written double-quoted, comma-separated in the field). */
export const GITLAB_RUNNER_TAG = /^[^\s",\\\x00-\x1f\x7f-\x9f\u2028\u2029](?:[^",\\\x00-\x1f\x7f-\x9f\u2028\u2029]{0,253}[^\s",\\\x00-\x1f\x7f-\x9f\u2028\u2029])?$/;
/** GitLab's own limit on tags per job. */
const MAX_RUNNER_TAGS = 50;
export const RUNNER_TAGS_RULE = `runner tags must be non-empty, at most 255 characters, at most ${MAX_RUNNER_TAGS} in all, with no leading or trailing space and none of , " \\, control characters or line separators`;

/** The validated tag list, or an error naming the rule. */
export function validateRunnerTags(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RUNNER_TAGS || !raw.every((t) => typeof t === 'string' && GITLAB_RUNNER_TAG.test(t))) throw new BadRequestError(RUNNER_TAGS_RULE);
  return raw as string[];
}

/** A GitLab `!reference` node: its value lives elsewhere (another job, an include), so it is never copied as literal tags. */
class CiReference {}
const resolveReference = (): CiReference => new CiReference();
const REFERENCE_TAGS = [
  { tag: '!reference', collection: 'seq' as const, resolve: resolveReference },
  { tag: '!reference', resolve: resolveReference },
];
const RUNNER_TAGS_UNREADABLE = 'The project\'s `default: tags` could not be copied (not a plain list of valid tags, e.g. a `!reference`), so the field starts empty: enter the tags of the runners that should take the jobs.';

/** `default: tags:` of the project's own CI file (top-level `default:` only, aliases and merge keys resolved, no includes).
 * A value the hub cannot copy faithfully is never trimmed (dropping a tag would widen the runners that take the jobs):
 * the field starts empty with a note and the plan goes on, since the tags only matter for a new jobs file. */
function defaultTags(ci: string | undefined): { tags: string[]; note?: string } {
  if (ci === undefined || pipelineYaml(ci) === undefined) return { tags: [] };
  try {
    const field = (obj: unknown, key: string): unknown => (typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined);
    const tags = field(field(parseAllDocuments(ci, { customTags: REFERENCE_TAGS, merge: true }).at(-1)?.toJS(), 'default'), 'tags');
    return { tags: tags === undefined || tags === null ? [] : validateRunnerTags(tags) };
  } catch {
    return { tags: [], note: RUNNER_TAGS_UNREADABLE };
  }
}

function unruledJobs(ci: string | undefined): string[] {
  if (ci === undefined) return [];
  const root = pipelineYaml(ci)?.at(-1)?.contents;
  if (!isMap(root)) return [];
  return root.items.flatMap((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value.startsWith('.') || GLOBAL_CI_KEYS.has(pair.key.value) || !isMap(pair.value)) return [];
    const hasRules = pair.value.items.some((field) => isScalar(field.key) && field.key.value === 'rules');
    return hasRules ? [] : [pair.key.value];
  });
}

export async function planGitlabFactory(repoPath: string, deps: GitlabFactoryDeps = {}): Promise<FactoryPlan> {
  const origin = await originUrl(deps.exec ?? defaultExec, repoPath);
  if (!isKnownGitlabRemote(origin)) {
    throw new BadRequestError('This project\'s remote is not on GitLab (gitlab.com, or the host named by GITLAB_HOST), so GitLab CI cannot be enabled for it.');
  }
  const repoSlug = gitlabProjectFromRemote(origin) ?? '';
  const gitlabHost = remoteHostname(origin) ?? '';
  if (!GITLAB_PROJECT_PATH.test(repoSlug)) throw new BadRequestError('Could not read the GitLab project (group/project) from the `origin` remote; fix the remote and try again.');
  if (!GITLAB_HOSTNAME.test(gitlabHost)) throw new BadRequestError('Could not read the GitLab host from the `origin` remote; fix the remote and try again.');
  const exec = onHost(deps.exec ?? defaultExec, gitlabHost);

  const user = obj(await glabJson(exec, repoPath, ['api', 'user']));
  const project = obj(await glabJson(exec, repoPath, ['api', `projects/${encodeProject(repoSlug)}`]));
  const login = str(user.username);
  const defaultBranch = str(project.default_branch);
  const gitlabProjectId = typeof project.id === 'number' ? project.id : 0;
  const configuredCiPath = str(project.ci_config_path) || GITLAB_CI_FILE;
  const gitlabCiPath = configuredCiPath.startsWith('/') || configuredCiPath.split('/').includes('..') ? '' : configuredCiPath;
  if (login === '') throw new BadRequestError('glab is not signed in to GitLab; run `glab auth login`, then try again.');
  if (defaultBranch === '') throw new BadRequestError('The GitLab project has no default branch yet; push one first, then try again.');
  if (gitlabProjectId <= 0) throw new BadRequestError('GitLab did not return the project id; check `glab auth status` and try again.');
  if (gitlabCiPath === '' || gitlabCiPath === GITLAB_INCLUDE_FILE) throw new BadRequestError('The project has an unsupported custom CI configuration path; choose a regular project-relative CI file, then try again.');
  // Refresh the remote-tracking ref so a change made on GitLab since the last fetch (the include added by hand) shows up; offline keeps the local ref.
  if (/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    await exec('git', ['fetch', 'origin', defaultBranch], { cwd: repoPath, timeout: 30_000 }).catch(() => undefined);
  }
  const [{ packageManager, scripts }, verifyCommand, base] = await Promise.all([
    detectScripts(repoPath),
    resolveVerifyCommand(repoPath),
    baseState(exec, repoPath, defaultBranch, gitlabCiPath).catch((): BaseState => ({ includeFile: false })),
  ]);
  const isWired = wired(base.ci);
  const unruled = unruledJobs(base.ci);
  const runnerTags = defaultTags(base.ci);
  const autoDevopsWithoutFile = project.auto_devops_enabled === true && base.ci === undefined;
  const gitlabManualInclude = !isWired && (
    gitlabCiPath !== GITLAB_CI_FILE || autoDevopsWithoutFile || (base.ci !== undefined && withInclude(base.ci) === undefined)
  );
  return {
    provider: 'gitlab',
    repoSlug,
    defaultBranch,
    login,
    gitlabHost,
    gitlabProjectId,
    gitlabCiPath,
    ...(gitlabManualInclude ? { gitlabManualInclude: true } : {}),
    gitlabRunnerTags: runnerTags.tags,
    ...(runnerTags.note !== undefined ? { gitlabRunnerTagsNote: runnerTags.note } : {}),
    ...(unruled.length > 0 ? { gitlabUnruledJobs: unruled } : {}),
    packageManager,
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    scripts,
    callerFiles: [gitlabCiPath, GITLAB_INCLUDE_FILE],
    labels: FACTORY_LABELS.map((label) => label.name),
    existingCallerFiles: [...(base.includeFile ? [GITLAB_INCLUDE_FILE] : []), ...(isWired ? [gitlabCiPath] : [])],
  };
}

/** The open MR from the factory branch into the default branch, '' when there is none. */
async function openMr(exec: FactoryExec, repoPath: string, plan: FactoryPlan, branch: string): Promise<string> {
  const q = `state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(plan.defaultBranch)}`;
  const list = await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/merge_requests?${q}`]);
  const match = Array.isArray(list) ? list.find((row) => obj(row).source_project_id === plan.gitlabProjectId) : undefined;
  const url = str(obj(match).web_url);
  return GITLAB_MR_URL.test(url) ? url : '';
}

/** The `.gitlab-ci.yml` text with the include added; `undefined` when its `include:` is in a form not safe to edit (the MR then adds only the include file and says so). */
function withInclude(ci: string): string | undefined {
  const edited = spliceInclude(ci);
  if (edited === undefined) return undefined;
  // The edit must parse, wire the file and leave no empty entry; an indented or flow-style root can break the textual splice.
  const include = rootValue(edited, 'include');
  const hasNull = isSeq(include) && include.items.some((item) => item === null || (isScalar(item) && item.value === null));
  return wired(edited) && !hasNull ? edited : undefined;
}

function spliceInclude(ci: string): string | undefined {
  if (ci.trim() === '') return INCLUDE_LINES;
  const docs = pipelineYaml(ci);
  const doc = docs?.at(-1);
  const root = doc?.contents;
  if (docs === undefined || doc === undefined || !isMap(root)) return undefined;
  const pair = root.items.find((item) => isScalar(item.key) && item.key.value === 'include');
  const entry = doc.createNode({ local: GITLAB_INCLUDE_FILE });
  if (pair === undefined) {
    const at = root.range?.[0];
    if (at === undefined) return undefined;
    return `${ci.slice(0, at)}${INCLUDE_LINES}\n${ci.slice(at)}`;
  } else if (isSeq(pair.value)) {
    if (pair.value.flow !== true) {
      const at = pair.value.range?.[0];
      if (at === undefined) return undefined;
      const lineStart = ci.lastIndexOf('\n', at - 1) + 1;
      const indent = ci.slice(lineStart, at);
      return `${ci.slice(0, at)}- local: ${GITLAB_INCLUDE_FILE}\n${indent}${ci.slice(at)}`;
    }
    pair.value.add(entry);
  } else if (pair.value === null || (isScalar(pair.value) && pair.value.value === null)) {
    // `include:` with no value: nothing to keep.
    const include = new YAMLSeq();
    include.items = [entry];
    pair.value = include;
  } else if (isScalar(pair.value) && pair.value.range && !ci.slice(pair.value.range[0], pair.value.range[1]).includes('\n')) {
    // `include: x.yml`: only the value becomes a list, the rest of the file stays byte for byte.
    const [from, to] = pair.value.range;
    return `${ci.slice(0, from).trimEnd()}\n  - ${ci.slice(from, to)}\n  - local: ${GITLAB_INCLUDE_FILE}${ci.slice(to)}`;
  } else {
    // A mapping or an inline list: rewritten through the YAML library, which may restyle the file.
    const include = new YAMLSeq();
    include.items = [pair.value, entry];
    pair.value = include;
  }
  return docs.map((item) => item.toString({ lineWidth: 0 })).join('');
}

/** Refuse when the checked-out base has `.gitlab`, `.gitlab/taskcell.yml` or `.gitlab-ci.yml` as a symlink (or the wrong
 * kind of entry): a committed link would make `apply` write through it to a path outside the ones it owns. */
async function assertNoLinks(repoPath: string): Promise<void> {
  for (const [path, kind] of [['.gitlab', 'directory'], [GITLAB_INCLUDE_FILE, 'file'], [GITLAB_CI_FILE, 'file']] as const) {
    const st = await lstat(join(repoPath, path)).catch(() => undefined);
    // lstat does not follow links, so a symlink is neither a directory nor a file here.
    if (st !== undefined && !(kind === 'directory' ? st.isDirectory() : st.isFile())) {
      throw new BadRequestError(`\`${path}\` on the default branch is a symlink or not a regular ${kind}; the hub will not write through it. Replace it with a real ${kind}, then try again.`);
    }
  }
}

/**
 * Branch from `origin/<default>`, add `.gitlab/taskcell.yml` and the include in `.gitlab-ci.yml` (what
 * the base lacks), push the branch and open a merge request into the default branch (never push TO
 * it). Re-runnable: the branch is reset, the commit skipped when nothing changed, an open MR reused,
 * labels created idempotently. The checked-out branch is restored afterwards.
 */
export async function applyGitlabFactory(repoPath: string, plan: FactoryPlan, deps: GitlabFactoryDeps = {}): Promise<FactoryApplyResult> {
  const exec = onHost(deps.exec ?? defaultExec, plan.gitlabHost);
  const branch = enableFactoryBranch();
  const ciPath = plan.gitlabCiPath ?? GITLAB_CI_FILE;
  if (branch === plan.defaultBranch) throw new BadRequestError('refusing to use the default branch as the enable-factory branch');

  if ((await guarded(() => git(exec, repoPath, ['status', '--porcelain', '--untracked-files=no']))) !== '') {
    throw new BadRequestError('the working tree has uncommitted changes; commit or stash them before enabling the factory');
  }
  const callerFiles = [ciPath, GITLAB_INCLUDE_FILE];
  const local = await guarded(() => git(exec, repoPath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', ...callerFiles]));
  if (local !== '') {
    throw new BadRequestError('uncommitted CI files at the factory paths would be overwritten; commit, move or delete them before enabling the factory');
  }
  const head = await guarded(() => git(exec, repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']));
  const original = head === 'HEAD' ? await guarded(() => git(exec, repoPath, ['rev-parse', 'HEAD'])) : head;

  await guarded(() => git(exec, repoPath, ['fetch', 'origin', plan.defaultBranch]));
  const base = await baseState(exec, repoPath, plan.defaultBranch, ciPath);
  const tags = plan.gitlabRunnerTags ?? [];
  const tagsLine = tags.length > 0 ? `\n  tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]` : '';
  let changed: boolean;
  let manualInclude = false;
  await guarded(() => git(exec, repoPath, ['checkout', '-B', branch, `origin/${plan.defaultBranch}`]));
  try {
    await assertNoLinks(repoPath);
    const written: string[] = [];
    if (!base.includeFile) {
      await mkdir(join(repoPath, '.gitlab'), { recursive: true });
      await writeFile(join(repoPath, GITLAB_INCLUDE_FILE), (await readFile(TEMPLATE, 'utf8')).replaceAll(LOGIN_PLACEHOLDER, () => plan.login).replace(/^ {2}stage: test$/m, () => `  stage: ${factoryStage(base.ci)}${tagsLine}`));
      written.push(GITLAB_INCLUDE_FILE);
    }
    const canEditCi = ciPath === GITLAB_CI_FILE && plan.gitlabManualInclude !== true;
    const edited = wired(base.ci) || !canEditCi ? undefined : base.ci === undefined ? INCLUDE_LINES : withInclude(base.ci);
    manualInclude = !wired(base.ci) && edited === undefined;
    if (edited !== undefined) {
      await writeFile(join(repoPath, ciPath), edited);
      written.push(ciPath);
    }
    if (written.length > 0) await guarded(() => git(exec, repoPath, ['add', ...written]));
    changed = written.length > 0 && (await guarded(() => git(exec, repoPath, ['status', '--porcelain', '--', ...written]))) !== '';
    if (changed) {
      await guarded(() => git(exec, repoPath, ['commit', '-m', 'feat: enable the Taskcell factory (GitLab CI)', '--', ...written]));
      // The hub's own fixed branch, never plan.defaultBranch; --force replaces an earlier apply's commit.
      await guarded(() => git(exec, repoPath, ['push', '--force', '-u', 'origin', branch]));
    }
  } finally {
    await guarded(() => git(exec, repoPath, ['checkout', '-f', original]));
  }

  const labelsCreated: string[] = [];
  for (const label of FACTORY_LABELS) {
    try {
      await exec('glab', ['label', 'create', '--name', label.name, '--color', `#${label.color}`, '--repo', plan.repoSlug], { cwd: repoPath });
    } catch (err) {
      // A label that already exists is what we want; anything else (permission, sign-in) is not.
      // stderr only: `message` carries argv, and a project path such as `team/mistaken` would match.
      const text = String((err as { stderr?: unknown }).stderr ?? '');
      if (!/already|taken|exists/i.test(text)) throw new BadRequestError(plainSentence(err));
    }
    labelsCreated.push(label.name);
  }

  const open = await openMr(exec, repoPath, plan, branch);
  if (open !== '') return { branch, prUrl: open, labelsCreated };
  if (!changed && manualInclude) {
    throw new BadRequestError(`the factory jobs file is already on ${plan.defaultBranch}, but the hub cannot edit ${ciPath} automatically; add \`- local: ${GITLAB_INCLUDE_FILE}\` under its top-level \`include:\`, then try again`);
  }
  if (!changed) throw new BadRequestError(`the factory jobs are already on ${plan.defaultBranch}; nothing to open a merge request for`);

  await glabProject(exec, repoPath, plan, [
    'mr', 'create',
    '--source-branch', branch,
    '--target-branch', plan.defaultBranch,
    '--title', 'feat: enable the Taskcell factory (GitLab CI)',
    '--description', `Adds the Taskcell factory jobs (doctor, implement, review) as \`${GITLAB_INCLUDE_FILE}\`. Set the masked and protected CI/CD variables \`${SECRET_NAME}\` and \`GITLAB_TOKEN\` before running the doctor pipeline.${manualInclude ? ` The hub cannot edit \`${ciPath}\` automatically: add \`- local: ${GITLAB_INCLUDE_FILE}\` under its top-level \`include:\` by hand before merging.` : ` They are included from \`${ciPath}\`.`} See docs/hub.md.`,
    '--yes',
  ]);
  const prUrl = await openMr(exec, repoPath, plan, branch);
  if (prUrl === '') throw new BadRequestError('The merge request was created but GitLab did not list it; open the project on GitLab to find it.');
  return { branch, prUrl, labelsCreated };
}

/** The variable step: command text only. No `exec` here — it cannot run `glab variable set`, so the hub never handles the value. */
export function gitlabSecretCommand(plan: FactoryPlan): FactorySecretStep {
  // bash and zsh both take this form (`read -p` is bash-only). `set` fails on an existing variable, so `update` follows
  // it; each gets the value on stdin. The value only crosses the pipe into glab; the hub never runs this.
  const glabVar = (verb: string): string => `printf %s "$T" | GITLAB_HOST=${plan.gitlabHost ?? 'gitlab.com'} glab variable ${verb} ${SECRET_NAME} --masked --protected --repo ${plan.repoSlug}`;
  return {
    secretName: SECRET_NAME,
    command: `printf 'Token: '; IFS= read -rs T; echo; ${glabVar('set')} 2>/dev/null || ${glabVar('update')}; unset T`,
  };
}

/** Whether the project has the CI/CD variable, by NAME: one HEAD request for that key (404 = absent). A HEAD response
 * has no body (glab's Go HTTP client never reads one), so unlike a GET the value cannot reach this process.
 * Needs Maintainer access, so a Developer's check fails and the doctor passing marks the step instead. */
export async function gitlabVariableExists(repoPath: string, plan: FactoryPlan, exec: FactoryExec = defaultExec): Promise<boolean> {
  try {
    await onHost(exec, plan.gitlabHost)('glab', ['api', '--method', 'HEAD', `projects/${encodeProject(plan.repoSlug)}/variables/${SECRET_NAME}`], { cwd: repoPath });
    return true;
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    if (httpStatus(`${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`, 404)) return false;
    throw new BadRequestError(plainSentence(err));
  }
}

/** The MR's state: merged / closed / opened. */
async function gitlabMrState(repoPath: string, plan: FactoryPlan, mrUrl: string, exec: FactoryExec = defaultExec): Promise<string> {
  const iid = GITLAB_MR_URL.exec(mrUrl)?.[1];
  if (iid === undefined) return '';
  return str(obj(await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/merge_requests/${iid}`])).state);
}

/** Every page of the pipeline's jobs: the doctor job of a large pipeline is not always on the first one. */
async function pipelineJobs(exec: FactoryExec, repoPath: string, plan: FactoryPlan, id: string | number): Promise<unknown[] | undefined> {
  const jobs: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const answer = await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/pipelines/${id}/jobs?per_page=100&page=${page}`]);
    if (!Array.isArray(answer)) return undefined;
    jobs.push(...answer);
    if (answer.length < 100) return jobs;
  }
  return jobs;
}

/** Conclusion of a finished pipeline that had no `taskcell-doctor` job (the include is not wired, or its rule did not match). */
export const NO_DOCTOR_JOB = 'had no taskcell-doctor job';

/** The doctor's own result: the status of its `taskcell-doctor` job, so the project's other jobs in the same pipeline do
 * not decide it. Only that job can pass the step: until it is seen the pipeline's progress is shown, never its success,
 * and a finished pipeline without the job fails the step. */
async function doctorResult(exec: FactoryExec, repoPath: string, plan: FactoryPlan, id: string | number, pipelineStatus: string): Promise<{ status: string; conclusion: string }> {
  let jobs: unknown;
  try {
    jobs = await pipelineJobs(exec, repoPath, plan, id);
  } catch { /* not known yet: the next refresh asks again */ }
  const job = Array.isArray(jobs) ? jobs.find((j) => obj(j).name === 'taskcell-doctor') : undefined;
  if (job !== undefined) return pipelineResult(str(obj(job).status));
  const pipeline = pipelineResult(pipelineStatus);
  if (pipeline.status !== 'completed') return pipeline;
  // Finished: with the job list read, no doctor job ran; without it the result is not known yet.
  return Array.isArray(jobs) ? { status: 'completed', conclusion: NO_DOCTOR_JOB } : { status: 'in_progress', conclusion: '' };
}

/** Start the doctor pipeline (`TASKCELL_DOCTOR=true` on the default branch) and report the pipeline that start created. */
export async function verifyGitlabFactory(repoPath: string, plan: FactoryPlan, deps: GitlabFactoryDeps = {}): Promise<FactoryVerifyResult> {
  const exec = onHost(deps.exec ?? defaultExec, plan.gitlabHost);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dispatched = await glabProject(exec, repoPath, plan, ['ci', 'run', '--branch', plan.defaultBranch, '--variables', 'TASKCELL_DOCTOR:true']);
  // Only the pipeline this call created is followed (never "the newest one", which may be other tooling's).
  const id = /\(id:\s*(\d+)/.exec(dispatched)?.[1];
  if (id === undefined) throw new BadRequestError('GitLab started the doctor pipeline but glab did not report its id; open the project\'s pipelines page to find it.');
  const printed = /weburl:\s*(https?:\/\/[^\s)]+)/.exec(dispatched)?.[1] ?? '';
  const url = GITLAB_PIPELINE_URL.test(printed) ? printed : `https://${plan.gitlabHost ?? 'gitlab.com'}/${plan.repoSlug}/-/pipelines/${id}`;
  for (let attempt = 0; attempt < VERIFY_POLLS; attempt++) {
    await sleep(VERIFY_POLL_MS);
    try {
      const pipeline = obj(await glabJson(exec, repoPath, ['api', `projects/${encodeProject(plan.repoSlug)}/pipelines/${id}`]));
      const status = str(pipeline.status);
      if (status !== '') return { dispatched: true, run: { url, ...(await doctorResult(exec, repoPath, plan, id, status)) } };
    } catch { /* the exact dispatched id is not readable yet; poll it again */ }
  }
  return { dispatched: true, run: { url, status: 'queued', conclusion: '' } };
}

/** The facts `refreshFactory` learns for a GitLab record; a failed check leaves its step as it was. */
export async function gitlabFound(repoPath: string, rec: FactoryRecord, baseExec: FactoryExec = defaultExec): Promise<Partial<FactoryRecord>> {
  const exec = onHost(baseExec, rec.plan.gitlabHost);
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
