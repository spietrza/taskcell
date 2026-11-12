import { defaultDockerRunner, isOlderVersion, resolveSandboxImageVia, type DockerRunner } from './docker.js';
import type { CliVersionInfo, CliVersionReport } from '../wire.js';

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

// The timeout covers the body too: the codex packument alone is ~19 MB.
const defaultFetch: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(60_000) });

/** The check is on unless VANGUARD_CLI_VERSION_CHECK is `off`/`0`/`false`/`no`. */
function cliVersionCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  return !['off', '0', 'false', 'no'].includes((env.VANGUARD_CLI_VERSION_CHECK ?? '').trim().toLowerCase());
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

/** Versions of the CLIs inside the local sandbox image (one container, no network). Missing/unrunnable ones are absent. */
export async function installedCliVersions(opts: Pick<CheckCliVersionsOptions, 'cwd' | 'env' | 'run' | 'image'>): Promise<Installed> {
  const run = opts.run ?? defaultDockerRunner;
  try {
    const image = opts.image ?? (await resolveSandboxImageVia(run, opts.cwd, opts.env));
    const script = 'for b in claude codex agent; do echo "$b $($b --version 2>/dev/null | head -n 1)"; done';
    const { stdout } = await run('docker', ['run', '--rm', image, 'sh', '-c', script], { cwd: opts.cwd });
    const line = (bin: string): string => stdout.split('\n').find((l) => l.startsWith(`${bin} `)) ?? '';
    const semver = (bin: string): string | undefined => /\d+\.\d+\.\d+/.exec(line(bin))?.[0];
    const claude = semver('claude');
    const codex = semver('codex');
    const cursor = CURSOR_VERSION.exec(line('agent'))?.[0];
    return { ...(claude !== undefined ? { claude } : {}), ...(codex !== undefined ? { codex } : {}), ...(cursor !== undefined ? { cursor } : {}) };
  } catch {
    return {};
  }
}

// Lookups are cached per fetcher (the default one is a singleton) so a polling hub does not
// re-download multi-MB packuments, and concurrent callers share one request.
const lookupCache = new WeakMap<Fetcher, Map<string, { at: number; value: Promise<unknown> }>>();
function cached<T>(fetcher: Fetcher, key: string, now: number, load: () => Promise<T>): Promise<T> {
  let byKey = lookupCache.get(fetcher);
  if (byKey === undefined) lookupCache.set(fetcher, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit !== undefined && now - hit.at < LOOKUP_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  byKey.set(key, { at: now, value });
  value.catch(() => byKey.delete(key));
  return value;
}

interface NpmRelease {
  latest: string;
  publishedAt: string;
  /** Newest version published at least SOAK_DAYS ago. */
  soaked?: string;
}

async function npmRelease(fetcher: Fetcher, pkg: string, cutoff: number): Promise<NpmRelease | undefined> {
  const res = await fetcher(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!res.ok) return undefined;
  const time = ((await res.json()) as { time?: Record<string, string> }).time ?? {};
  const newest = (versions: string[]): string | undefined =>
    versions.reduce<string | undefined>((best, v) => (best === undefined || isOlderVersion(best, v) ? v : best), undefined);
  const stable = Object.keys(time).filter((v) => SEMVER.test(v));
  const latest = newest(stable);
  const soaked = newest(stable.filter((v) => Date.parse(time[v] ?? '') <= cutoff));
  return latest === undefined ? undefined : { latest, publishedAt: time[latest] ?? '', ...(soaked !== undefined ? { soaked } : {}) };
}

async function cursorLatest(fetcher: Fetcher): Promise<string | undefined> {
  const res = await fetcher('https://cursor.com/install');
  return res.ok ? CURSOR_VERSION.exec(await res.text())?.[0] : undefined;
}

/**
 * Installed vs latest for the claude, codex and cursor CLIs in the local sandbox image. When the
 * VANGUARD_CLI_VERSION_CHECK switch is off it returns at once with no lookups of any kind. Never
 * throws: a failed lookup leaves `latest` unset with a `reason`. `target` is the newest version past
 * the 3-day soak (what an update installs); `latest` may be newer but is shown only.
 */
export async function checkCliVersions(opts: CheckCliVersionsOptions): Promise<CliVersionReport> {
  const env = opts.env ?? process.env;
  if (!cliVersionCheckEnabled(env)) return { enabled: false, clis: [] };
  const fetcher = opts.fetch ?? defaultFetch;
  const now = opts.now ?? Date.now();
  const cutoff = now - SOAK_DAYS * 864e5;
  const installed = await installedCliVersions({ ...opts, env });

  const npmInfo = async (name: 'claude' | 'codex'): Promise<CliVersionInfo> => {
    const have = installed[name];
    const rel = await cached(fetcher, name, now, () => npmRelease(fetcher, NPM_PACKAGES[name], cutoff)).catch(() => undefined);
    const outdated = have !== undefined && rel !== undefined && isOlderVersion(have, rel.latest);
    const updatable = outdated && rel.soaked !== undefined && isOlderVersion(have, rel.soaked);
    return {
      name,
      ...(have !== undefined ? { installed: have } : {}),
      ...(rel !== undefined ? { latest: rel.latest, publishedAt: rel.publishedAt } : {}),
      ...(updatable ? { target: rel.soaked } : {}),
      changelog: CHANGELOGS[name],
      outdated,
      updatable,
      ...(rel === undefined ? { reason: 'version lookup failed' } : {}),
      ...(outdated && !updatable ? { reason: `newest release is less than ${SOAK_DAYS} days old; not offered for update yet` } : {}),
    };
  };
  // Opt-in in the image: no cursor CLI installed, nothing to report (and no lookup).
  const cursorInfo = async (): Promise<CliVersionInfo[]> => {
    const have = installed.cursor;
    if (have === undefined) return [];
    const latest = await cached(fetcher, 'cursor', now, () => cursorLatest(fetcher)).catch(() => undefined);
    const day = (v: string): string => v.split('-')[0] ?? v;
    const outdated = latest !== undefined && isOlderVersion(day(have), day(latest));
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
