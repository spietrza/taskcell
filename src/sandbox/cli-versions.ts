import { defaultDockerRunner, isOlderVersion, resolveSandboxImageVia, type DockerRunner } from './docker.js';
import type { CliVersionInfo, CliVersionReport } from '../wire.js';
import { readEnv } from '../core/env.js';

/** Same soak as scripts/bump-agent-clis.sh. */
const SOAK_DAYS = 3;
const LOOKUP_TTL_MS = 60 * 60_000;

const CHANGELOGS = {
  claude: 'https://github.com/anthropics/claude-code/releases',
  codex: 'https://github.com/openai/codex/releases',
  cursor: 'https://cursor.com/changelog',
} as const;
const NPM_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' } as const;
const SEMVER = /^\d+\.\d+\.\d+$/;
const CURSOR_VERSION = /\d{4}\.\d+\.\d+-[a-f0-9]+/;

export type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

// The timeout covers the body too: the codex packument alone is ~19 MB. Kept short — doctor awaits it.
const defaultFetch: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(20_000) });
/** Cap on the probe container: the docker client is killed on expiry, and `--init` lets the container stop with it. */
const PROBE_TIMEOUT_MS = 30_000;

/** The check is on unless TASKCELL_CLI_VERSION_CHECK is `off`/`0`/`false`/`no`. */
function cliVersionCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  return !['off', '0', 'false', 'no'].includes((readEnv('TASKCELL_CLI_VERSION_CHECK', env) ?? '').trim().toLowerCase());
}

export interface CheckCliVersionsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  run?: DockerRunner;
  image?: string;
  now?: number;
}

type Installed = Partial<Record<CliVersionInfo['name'], string>>;

// Lookups and image probes are cached per fetcher/runner (the defaults are singletons) so a polling
// hub neither re-downloads multi-MB packuments nor starts a container per call, and concurrent
// callers share one request. Only successes are kept: a failure rejects and is evicted at once.
const lookupCache = new WeakMap<object, Map<string, { at: number; value: Promise<unknown> }>>();
function cached<T>(owner: object, key: string, now: number, load: () => Promise<T>): Promise<T> {
  let byKey = lookupCache.get(owner);
  if (byKey === undefined) lookupCache.set(owner, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit !== undefined && now - hit.at < LOOKUP_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  byKey.set(key, { at: now, value });
  // Evict only this entry: a late rejection must not drop a newer one stored under the same key.
  value.catch(() => {
    if (byKey.get(key)?.value === value) byKey.delete(key);
  });
  return value;
}

async function probeImage(run: DockerRunner, cwd: string, image: string): Promise<Installed> {
  const script = 'for b in claude codex agent; do echo "$b $($b --version 2>/dev/null | head -n 1)"; done';
  const args = ['run', '--rm', '--init', '--pull=never', '--network', 'none', image, 'sh', '-c', script];
  const { stdout } = await run('docker', args, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  const line = (bin: string): string => stdout.split('\n').find((l) => l.startsWith(`${bin} `)) ?? '';
  const semver = (bin: string): string | undefined => /\d+\.\d+\.\d+/.exec(line(bin))?.[0];
  const claude = semver('claude');
  const codex = semver('codex');
  const cursor = CURSOR_VERSION.exec(line('agent'))?.[0];
  return { ...(claude !== undefined ? { claude } : {}), ...(codex !== undefined ? { codex } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

/**
 * Versions of the CLIs inside the local sandbox image: one container with no network that never
 * pulls (an image not present locally reports nothing). Missing/unrunnable CLIs are absent. With
 * `cache`, the probe is shared per image ID, so a re-committed (refreshed) image is probed afresh.
 */
export async function installedCliVersions(
  opts: Pick<CheckCliVersionsOptions, 'cwd' | 'env' | 'run' | 'image'> & { cache?: { now: number } },
): Promise<Installed> {
  const run = opts.run ?? defaultDockerRunner;
  try {
    const image = opts.image ?? (await resolveSandboxImageVia(run, opts.cwd, opts.env));
    // Also the existence guard: a failed inspect means no local image, so nothing is run or pulled.
    const { stdout: id } = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { cwd: opts.cwd });
    const probe = (): Promise<Installed> => probeImage(run, opts.cwd, image);
    return await (opts.cache !== undefined ? cached(run, `image:${image}@${id.trim()}`, opts.cache.now, probe) : probe());
  } catch {
    return {};
  }
}

interface NpmRelease {
  latest: string;
  publishedAt: string;
  /** Newest version published at least SOAK_DAYS ago. */
  soaked?: string;
}

/** Throws on any failure, so nothing but a usable answer is cached. */
async function npmRelease(fetcher: Fetcher, pkg: string, cutoff: number): Promise<NpmRelease> {
  const res = await fetcher(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!res.ok) throw new Error(`${pkg}: registry lookup failed`);
  const doc = (await res.json()) as { time?: Record<string, string>; versions?: Record<string, { deprecated?: unknown }> };
  const time = doc.time ?? {};
  const versions = doc.versions ?? {};
  const newest = (vs: string[]): string | undefined =>
    vs.reduce<string | undefined>((best, v) => (best === undefined || isOlderVersion(best, v) ? v : best), undefined);
  // `time` keeps unpublished versions: count only ones still installable and not deprecated.
  const stable = Object.keys(time).filter((v) => SEMVER.test(v) && versions[v] !== undefined && versions[v].deprecated === undefined);
  const latest = newest(stable);
  if (latest === undefined) throw new Error(`${pkg}: no stable version`);
  const soaked = newest(stable.filter((v) => Date.parse(time[v] ?? '') <= cutoff));
  return { latest, publishedAt: time[latest] ?? '', ...(soaked !== undefined ? { soaked } : {}) };
}

async function cursorLatest(fetcher: Fetcher): Promise<string> {
  const res = await fetcher('https://cursor.com/install');
  const version = res.ok ? CURSOR_VERSION.exec(await res.text())?.[0] : undefined;
  if (version === undefined) throw new Error('cursor.com/install: no version found');
  return version;
}

/**
 * Installed vs latest for the claude, codex and cursor CLIs in the local sandbox image. Report only:
 * nothing here installs anything. When the TASKCELL_CLI_VERSION_CHECK switch is off it returns at once
 * with no lookups of any kind, and a CLI that is not installed in the image is not looked up. Never
 * throws: a failed lookup leaves `latest` unset with a `reason`. `target` is the newest version past
 * the 3-day soak (what the next bump PR would pin); `latest` may be newer.
 */
export async function checkCliVersions(opts: CheckCliVersionsOptions): Promise<CliVersionReport> {
  const env = opts.env ?? process.env;
  if (!cliVersionCheckEnabled(env)) return { enabled: false, clis: [] };
  const fetcher = opts.fetch ?? defaultFetch;
  const now = opts.now ?? Date.now();
  const cutoff = now - SOAK_DAYS * 864e5;
  const installed = await installedCliVersions({ ...opts, env, cache: { now } });

  const npmInfo = async (name: 'claude' | 'codex'): Promise<CliVersionInfo> => {
    const have = installed[name];
    if (have === undefined) return { name, changelog: CHANGELOGS[name], outdated: false, updatable: false };
    const rel = await cached(fetcher, name, now, () => npmRelease(fetcher, NPM_PACKAGES[name], cutoff)).catch(() => undefined);
    const outdated = rel !== undefined && isOlderVersion(have, rel.latest);
    const updatable = outdated && rel.soaked !== undefined && isOlderVersion(have, rel.soaked);
    return {
      name,
      installed: have,
      ...(rel !== undefined ? { latest: rel.latest, publishedAt: rel.publishedAt } : {}),
      ...(updatable ? { target: rel.soaked } : {}),
      changelog: CHANGELOGS[name],
      outdated,
      updatable,
      ...(rel === undefined ? { reason: 'version lookup failed' } : {}),
      ...(outdated && !updatable ? { reason: `newest release is less than ${SOAK_DAYS} days old; not a bump candidate yet` } : {}),
    };
  };
  // Opt-in in the image: no cursor CLI installed, nothing to report (and no lookup).
  const cursorInfo = async (): Promise<CliVersionInfo[]> => {
    const have = installed.cursor;
    if (have === undefined) return [];
    const latest = await cached(fetcher, 'cursor', now, () => cursorLatest(fetcher)).catch(() => undefined);
    const day = (v: string): string => v.split('-')[0] ?? v;
    // Builds are ordered by day only, so a different build of the same day counts as newer too.
    const outdated = latest !== undefined && latest !== have && !isOlderVersion(day(latest), day(have));
    return [
      {
        name: 'cursor',
        installed: have,
        ...(latest !== undefined ? { latest } : {}),
        changelog: CHANGELOGS.cursor,
        outdated,
        // Cursor publishes no checksums: an update needs the new per-arch sha256 from a human.
        updatable: false,
        ...(latest === undefined ? { reason: 'version lookup failed' } : {}),
        ...(outdated ? { reason: 'Cursor publishes no checksums: update needs the new per-arch sha256 (CURSOR_CLI_SHA256_X64 / _ARM64); not installing unverified' } : {}),
      },
    ];
  };

  const [claude, codex, cursor] = await Promise.all([npmInfo('claude'), npmInfo('codex'), cursorInfo()]);
  return { enabled: true, clis: [claude, codex, ...cursor] };
}

/** One doctor line per CLI that is installed or has a known latest. */
export function formatCliVersions(report: CliVersionReport): string[] {
  return report.clis
    .filter((c) => c.installed !== undefined || c.latest !== undefined)
    .map((c) => {
      const base = `cli versions: ${c.name} installed ${c.installed ?? 'unknown'}, latest ${c.latest ?? 'unknown'}`;
      const note = c.outdated ? ` — newer available (${c.changelog})` : '';
      return `${base}${note}${c.reason !== undefined ? `; ${c.reason}` : ''}`;
    });
}
