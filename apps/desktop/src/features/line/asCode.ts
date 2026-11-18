import type { AppConfig } from '../../taskcell-output';

const MASK = '***';

/** A URL with userinfo and query values hidden: either can carry a credential. Not a URL: hidden whole. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username) u.username = MASK;
    if (u.password) u.password = MASK;
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, MASK);
    return decodeURIComponent(u.toString());
  } catch {
    return MASK;
  }
}

const KNOWN = new Set(['name', 'baseUrl', 'keyEnv', 'model']);

/** What Publish writes, safe to display: URLs masked, unknown custom-provider keys hidden. `keyEnv` is a variable name, shown. */
export function asCode(cfg: AppConfig): string {
  const safe: Record<string, unknown> = { ...cfg };
  if (typeof cfg.chatBaseUrl === 'string') safe.chatBaseUrl = maskUrl(cfg.chatBaseUrl);
  if (Array.isArray(cfg.customProviders)) {
    safe.customProviders = cfg.customProviders.map((row: unknown) => {
      if (typeof row !== 'object' || row === null) return MASK;
      return Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, k === 'baseUrl' && typeof v === 'string' ? maskUrl(v) : KNOWN.has(k) ? v : MASK]),
      );
    });
  }
  return JSON.stringify(safe, null, 2);
}
