// Enable factory, "Self-hosted (watch)": the checklist for a worker the user runs themselves
// (`taskcell watch`). Read-only — the hub never starts or installs anything on another machine; it
// renders the compose snippet and command for this repo, names the credentials (never values) and
// says whether run records show the worker picking up work lately.
import { parseGitlabProjectFromRemote, remoteHostname } from '../runners/gitlab.js';
import { shellQuote } from '../agents/shell.js';
import { NO_REMOTE_MESSAGE, type RunSummary, type WatchWorkerChecklist } from '../wire.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { readAppConfig } from './app-config.js';
import { defaultExec, GITHUB_REPO_SLUG, type FactoryExec } from './enable-factory.js';
import { GITLAB_HOSTNAME, GITLAB_PROJECT_PATH, hostOfOrigin, readOrigin } from './enable-factory-gitlab.js';
import { resolveTaskSource } from './projects.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';

/** A worker counts as recently seen when a run record is newer than this. */
export const WORKER_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Where the worker reads tasks (`source`) and where its runs publish (`forge`); `slug` is the repo on that forge. */
export interface WatchTarget {
  source: WatchWorkerChecklist['source'];
  forge: 'github' | 'gitlab';
  slug: string;
  /** A self-hosted GitLab host the worker's `glab` must be pointed at (GITLAB_HOST); absent for gitlab.com. */
  gitlabHost?: string;
}

/** Credential names the worker needs (names only): the agent, the forge its runs publish to, and Linear when it reads tasks there. */
export function workerCredentials(t: Pick<WatchTarget, 'source' | 'forge'>): string[] {
  const tracker = t.source === 'linear' ? ['LINEAR_API_KEY'] : [];
  return ['CLAUDE_CODE_OAUTH_TOKEN', t.forge === 'gitlab' ? 'GITLAB_TOKEN' : 'GH_TOKEN', ...tracker];
}

/** The `taskcell watch` arguments for this repo; `repoDir` is where the worker has the clone. */
export function watchArgs(t: WatchTarget, repoDir: string): string[] {
  const target = t.source === 'github' ? [`--github-repo=${t.slug}`] : t.source === 'gitlab' ? [`--gitlab-project=${t.slug}`] : [];
  // Linear and GitLab loops need an ownership label; GitHub routes on its ready-for-* labels.
  const label = t.source === 'github' ? [] : ['--label=vanguard'];
  return ['watch', '--loop-v1', `--source=${t.source}`, ...target, ...label, `--repo=${repoDir}`, '--interval=120', '--llm-proxy'];
}

/** The same worker as one shell line; every argument is quoted unless it is plainly safe. */
export function watchCommandLine(t: WatchTarget): string {
  const env = t.gitlabHost !== undefined ? [`GITLAB_HOST=${shellQuote(t.gitlabHost)}`] : [];
  return [...env, 'taskcell', ...watchArgs(t, '.').map((a) => (/^[A-Za-z0-9_./=:-]+$/.test(a) ? a : shellQuote(a)))].join(' ');
}

/** Compose service for one repo, shaped like docker/compose.yaml's `vanguard-watch` (credentials by name, values from `.env`; same host guards). */
export function composeSnippet(t: WatchTarget): string {
  const env = workerCredentials(t).map((n) => `      ${n}: \${${n}}`);
  const command = watchArgs(t, '/work/repo').map((a) => `      - ${a}`);
  return [
    'services:',
    '  taskcell-watch:',
    '    image: vanguard-runner:latest # docker/build.sh',
    '    restart: unless-stopped',
    '    mem_limit: 1024m # bound the controller on a small host',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '      - ./target-repo:/work/repo # a git clone of this repository',
    '    environment:',
    ...env,
    ...(t.gitlabHost !== undefined ? [`      GITLAB_HOST: ${JSON.stringify(t.gitlabHost)}`] : []),
    '      VANGUARD_MAX_SANDBOXES: "1" # cap to host RAM (1 per ~3GB free)',
    '    command:',
    ...command,
  ].join('\n');
}

/** Worker-seen state from run records: newest run a watch worker started → recent / not recent; none, or an unreadable time → unknown. */
export function workerSeen(runs: ReadonlyArray<RunSummary>, now: number = Date.now()): { seen: WatchWorkerChecklist['seen']; lastRunAt?: string } {
  const stamps = runs.filter((r) => r.trigger === 'watch').map((r) => Date.parse(r.timestamp)).filter(Number.isFinite);
  if (stamps.length === 0) return { seen: 'unknown' };
  const at = Math.max(...stamps);
  return { seen: now - at <= WORKER_RECENT_MS ? 'recent' : 'stale', lastRunAt: new Date(at).toISOString() };
}

/**
 * Which worker serves this project: its configured task source (the code host only when none is set) and the forge
 * `origin` is on, detected exactly like `enable_factory_host`. Refuses, in one sentence, a source a watch worker cannot
 * serve and a slug outside its forge's charset, so nothing unchecked reaches the copy-paste command.
 */
export function watchTarget(origin: string | null, configured: string | undefined): WatchTarget {
  const host = hostOfOrigin(origin);
  if (origin === null || host === 'none') throw new BadRequestError(NO_REMOTE_MESSAGE);
  if (configured === 'hub') throw new BadRequestError('A `taskcell watch` worker cannot read the hub board; the hub runs its own tasks.');
  if (configured === 'github-project') {
    throw new BadRequestError('A watch worker reads a GitHub Project with `taskcell watch --source project --project <number>`, and the hub does not know the project number; run that by hand (docs/deploy.md).');
  }
  const source = configured === 'github' || configured === 'gitlab' || configured === 'linear' ? configured : host === 'gitlab' ? 'gitlab' : 'github';
  // Linear publishes to GitLab exactly when origin is a known GitLab remote (runners/linear.ts), otherwise through gh.
  const forge = host === 'gitlab' ? 'gitlab' : 'github';
  if (configured === undefined && host === 'other') {
    throw new BadRequestError('No task source is set and `origin` is on neither github.com nor GitLab (gitlab.com or GITLAB_HOST); pick a task source in Settings, or point `origin` at GitHub or GitLab.');
  }
  if (source !== 'linear' && source !== host) {
    throw new BadRequestError(`This project's task source is ${source === 'github' ? 'GitHub Issues' : 'GitLab Issues'}, but \`origin\` is not on ${source === 'github' ? 'github.com' : 'GitLab (gitlab.com or GITLAB_HOST)'}.`);
  }
  const path = parseGitlabProjectFromRemote(origin) ?? '';
  const valid = forge === 'gitlab' ? GITLAB_PROJECT_PATH.test(path) : GITHUB_REPO_SLUG.test(path);
  // Linear needs no slug; anything else must match the forge's charset before it reaches a shell line.
  if (!valid && source !== 'linear') throw new BadRequestError(`Could not read the ${forge === 'gitlab' ? 'GitLab project (group/project)' : 'GitHub repository (owner/repo)'} from \`origin\`; fix the remote and try again.`);
  const gitlabHost = forge === 'gitlab' ? workerGitlabHost(remoteHostname(origin)) : undefined;
  return { source, forge, slug: valid ? path : '', ...(gitlabHost !== undefined ? { gitlabHost } : {}) };
}

/** A self-hosted origin host matched the hub's GITLAB_HOST, so the worker gets that value as written (port, scheme); gitlab.com needs none. */
function workerGitlabHost(host: string | undefined): string | undefined {
  if (host === undefined || host === 'gitlab.com') return undefined;
  const configured = (process.env.GITLAB_HOST ?? '').trim();
  if (/^(?:https?:\/\/)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?\/?$/.test(configured)) return configured;
  return GITLAB_HOSTNAME.test(host) ? host : undefined;
}

export async function watchWorkerChecklist(repoPath: string, exec: FactoryExec = defaultExec, now: number = Date.now()): Promise<WatchWorkerChecklist> {
  const target = watchTarget(await readOrigin(exec, repoPath), resolveTaskSource(await readAppConfig(repoPath)));
  const runs = await listRunSummaries(defaultRunsRoot(repoPath)).catch(() => []);
  return {
    repoSlug: target.slug,
    source: target.source,
    compose: composeSnippet(target),
    command: watchCommandLine(target),
    credentials: workerCredentials(target),
    ...workerSeen(runs, now),
  };
}
