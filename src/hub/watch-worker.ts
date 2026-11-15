// Enable factory, "Self-hosted (watch)": the checklist for a worker the user runs themselves
// (`taskcell watch`). Read-only — the hub never starts or installs anything on another machine; it
// renders the compose snippet and command for this repo, names the credentials (never values) and
// says whether run records show the worker picking up work lately.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitlabProjectFromRemote } from '../runners/gitlab.js';
import type { WatchWorkerChecklist, WatchWorkerSeen, RunSummary } from '../wire.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { readAppConfig } from './app-config.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';

const run = promisify(execFile);

/** A worker counts as recently seen when a run record is newer than this. */
export const WORKER_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

type Source = 'github' | 'gitlab' | 'linear';

/** `owner/repo` from a github.com remote URL, or undefined. */
function githubSlug(remote: string): string | undefined {
  return remote.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

/** Credential names the worker needs (names only) for a task source. */
export function workerCredentials(source: Source): string[] {
  const tracker = source === 'linear' ? ['LINEAR_API_KEY'] : [];
  return ['CLAUDE_CODE_OAUTH_TOKEN', source === 'gitlab' ? 'GITLAB_TOKEN' : 'GH_TOKEN', ...tracker];
}

/** The `taskcell watch` arguments for this repo; `repoDir` is where the worker has the clone. */
export function watchArgs(source: Source, slug: string, repoDir: string): string[] {
  const target = source === 'github' ? [`--github-repo=${slug}`] : source === 'gitlab' ? [`--gitlab-project=${slug}`] : [];
  // Linear and GitLab loops need an ownership label; GitHub routes on its ready-for-* labels.
  const label = source === 'github' ? [] : ['--label=vanguard'];
  return ['watch', '--loop-v1', `--source=${source}`, ...target, ...label, `--repo=${repoDir}`, '--interval=120', '--llm-proxy'];
}

/** Compose service for one repo, shaped like docker/compose.yaml's `vanguard-watch` (credentials by name, values from `.env`). */
export function composeSnippet(source: Source, slug: string): string {
  const env = workerCredentials(source).map((n) => `      ${n}: \${${n}}`);
  const command = watchArgs(source, slug, '/work/repo').map((a) => `      - ${a}`);
  return [
    'services:',
    '  taskcell-watch:',
    '    image: vanguard-runner:latest # docker/build.sh',
    '    restart: unless-stopped',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '      - ./target-repo:/work/repo # a git clone of this repository',
    '    environment:',
    ...env,
    '    command:',
    ...command,
  ].join('\n');
}

/** Worker-seen state from run records: newest non-hub run → recent / not recent; no records → unknown. */
export function workerSeen(runs: ReadonlyArray<RunSummary>, now: number = Date.now()): { seen: WatchWorkerSeen; lastRunAt?: string } {
  // Runs the hub itself started carry `startedBy`; they say nothing about a watch worker.
  const stamps = runs.filter((r) => r.startedBy === undefined && r.source !== 'ci').map((r) => r.timestamp).sort();
  const lastRunAt = stamps[stamps.length - 1];
  if (lastRunAt === undefined) return { seen: 'unknown' };
  const at = Date.parse(lastRunAt);
  return { seen: Number.isFinite(at) && now - at <= WORKER_RECENT_MS ? 'recent' : 'stale', lastRunAt };
}

export async function watchWorkerChecklist(repoPath: string, now: number = Date.now()): Promise<WatchWorkerChecklist> {
  const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).then((r) => r.stdout.trim(), () => '');
  if (origin === '') throw new BadRequestError('This project has no `origin` remote; add one, then try again.');
  const cfg = await readAppConfig(repoPath);
  const gh = githubSlug(origin);
  const gl = gh === undefined ? gitlabProjectFromRemote(origin) : undefined;
  const source: Source | undefined = cfg.taskSource === 'linear' || cfg.source === 'linear' ? 'linear' : gh !== undefined ? 'github' : gl !== undefined ? 'gitlab' : undefined;
  const slug = gh ?? gl;
  if (source === undefined || slug === undefined) throw new BadRequestError('Could not read a GitHub or GitLab project from `origin`.');
  const runs = await listRunSummaries(defaultRunsRoot(repoPath)).catch(() => []);
  return {
    repoSlug: slug,
    source,
    compose: composeSnippet(source, slug),
    command: `taskcell ${watchArgs(source, slug, '.').join(' ')}`,
    credentials: workerCredentials(source),
    ...workerSeen(runs, now),
  };
}
