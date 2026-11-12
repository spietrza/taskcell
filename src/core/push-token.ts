import { createSign } from 'node:crypto';
import { execa } from 'execa';
import { forgetInjectedSecretValue, registerInjectedSecretValue } from './secret-scan.js';
import { hostGitArgs } from '../worktree/host-git.js';

/**
 * The credential for opening/updating PRs and pushing PR branches. When the taskcell GitHub App is
 * configured (TASKCELL_APP_CLIENT_ID + TASKCELL_APP_PRIVATE_KEY) a fresh installation token is minted
 * on every call: it lives 1 hour and an implement run lasts far longer, so it can't be minted at
 * process start. A failed mint (after one retry) falls back to VANGUARD_PUSH_TOKEN; without the App,
 * VANGUARD_PUSH_TOKEN, otherwise undefined (the ambient credential). Callers release a minted token
 * (releaseToken) right after its one use, which revokes it.
 */

export interface PushTokenDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Injected clock (ms since epoch). */
  now?: () => number;
  /** Where a mint failure that falls back to VANGUARD_PUSH_TOKEN is reported; default stderr. */
  warn?: (msg: string) => void;
}

const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
// The least the factory uses the token for (git push, gh pr create, gh pr ready): no Issues, no Workflows.
const PERMISSIONS = { contents: 'write', pull_requests: 'write' };
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

const b64url = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

/** RS256 App JWT: iat backdated 60 s for clock drift, exp 9 minutes after iat (8 from now; GitHub caps at 10). */
export function signAppJwt(clientId: string, privateKey: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: clientId, iat, exp: iat + 540 }))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey);
  return `${input}.${b64url(sig)}`;
}

/** A PEM passed through an env var with literal \\n line breaks. */
const unescapePem = (key: string): string => key.replace(/\\n/g, '\n');

/**
 * The App private key, read once from process.env and then removed from it, so the `docker`, `git`
 * and `gh` children of a long run do not inherit it. Registered for redaction (whole and per line,
 * since a PEM can leak a line at a time) because no env var holds it any more.
 */
let takenAppKey: string | undefined;
export function takeAppKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.TASKCELL_APP_PRIVATE_KEY;
  if (raw !== undefined) {
    takenAppKey = unescapePem(raw);
    for (const v of [raw, takenAppKey, ...takenAppKey.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('-----'))]) {
      registerInjectedSecretValue(v);
    }
    delete env.TASKCELL_APP_PRIVATE_KEY;
  }
  return takenAppKey;
}

function appKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  if (env === process.env) return takeAppKey(env);
  const raw = env.TASKCELL_APP_PRIVATE_KEY;
  return raw === undefined ? undefined : unescapePem(raw);
}

function apiBase(env: NodeJS.ProcessEnv): string {
  return (env.GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, '');
}

async function githubJson(f: typeof fetch, url: string, method: string, auth: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await f(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${auth}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'taskcell',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed: unknown = await res.json().catch(() => null);
  return { status: res.status, body: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
}

/** GitHub's own error message, bounded, for the diagnostic. */
function ghMessage(body: Record<string, unknown>): string {
  return typeof body.message === 'string' && body.message !== '' ? `: ${body.message.slice(0, 200)}` : '';
}

/** Minted tokens still live, with the API base that revokes them. */
const minted = new Map<string, { api: string; fetch: typeof fetch }>();

/** Mint a fresh installation token for `repoSlug` (owner/repo). Errors name the App and repo, never the key. */
async function mintAppToken(repoSlug: string, clientId: string, privateKey: string, env: NodeJS.ProcessEnv, deps: PushTokenDeps): Promise<string> {
  const f = deps.fetch ?? fetch;
  const api = apiBase(env);
  const fail = (why: string): Error => new Error(`taskcell GitHub App (client ${clientId}): cannot mint a token for ${repoSlug}: ${why}`);
  let jwt: string;
  try {
    jwt = signAppJwt(clientId, privateKey, (deps.now ?? Date.now)());
  } catch {
    throw fail('TASKCELL_APP_PRIVATE_KEY is not a valid RSA private key (PEM)');
  }
  const call = async (url: string, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    try {
      return await githubJson(f, url, method, jwt, body);
    } catch (cause) {
      throw fail(`GitHub API request failed (${cause instanceof Error ? cause.name : 'error'})`);
    }
  };
  const inst = await call(`${api}/repos/${repoSlug}/installation`, 'GET');
  if (inst.status === 401) throw fail(`GitHub rejected the App credentials (HTTP 401); check the client ID and private key${ghMessage(inst.body)}`);
  if (inst.status === 403) throw fail(`GitHub refused the request (HTTP 403: rate limit, suspended installation or missing access)${ghMessage(inst.body)}`);
  const id = inst.body.id;
  if (inst.status !== 200 || typeof id !== 'number') {
    throw fail(`no installation found for the repository (HTTP ${inst.status}); is the App installed on it?${ghMessage(inst.body)}`);
  }
  // Scoped to this one repo and the permissions the factory uses, whatever the App is granted.
  const tok = await call(`${api}/app/installations/${id}/access_tokens`, 'POST', {
    repositories: [repoSlug.split('/')[1]],
    permissions: PERMISSIONS,
  });
  const token = tok.body.token;
  if (tok.status !== 201 || typeof token !== 'string' || token === '') {
    throw fail(`installation token request failed (HTTP ${tok.status})${ghMessage(tok.body)}`);
  }
  registerInjectedSecretValue(token);
  minted.set(token, { api, fetch: f });
  return token;
}

/**
 * Revoke a token pushToken minted and drop it from the redaction set (revoked, it grants nothing).
 * A no-op for a PAT, the ambient credential or undefined; a failed revoke is ignored (it expires in 1 h).
 */
export async function releaseToken(token: string | undefined): Promise<void> {
  if (token === undefined) return;
  const entry = minted.get(token);
  if (entry === undefined) return;
  minted.delete(token);
  try {
    const res = await githubJson(entry.fetch, `${entry.api}/installation/token`, 'DELETE', token);
    if (res.status === 204) forgetInjectedSecretValue(token);
  } catch { /* still expires within the hour, and stays redacted */ }
}

/** Which credential `token` is, for logs (never its value): ' (taskcell App token)', ' (VANGUARD_PUSH_TOKEN)' or ''. */
export function credentialLabel(token: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (token === undefined || token === '') return '';
  if (minted.has(token)) return ' (taskcell App token)';
  return token === env.VANGUARD_PUSH_TOKEN ? ' (VANGUARD_PUSH_TOKEN)' : '';
}

/** `owner/repo` for the checkout: parsed from its origin URL (where `gh pr create` opens the PR), else GITHUB_REPOSITORY. */
export async function repoSlugOf(repoPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  try {
    const { stdout } = await execa('git', hostGitArgs(['remote', 'get-url', 'origin']), { cwd: repoPath });
    const slug = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(stdout.trim())?.[1];
    if (slug !== undefined) return slug;
  } catch { /* not a checkout, or no origin */ }
  return env.GITHUB_REPOSITORY || undefined;
}

/** See file header. `repoSlug` is `owner/repo`. */
export async function pushToken(repoSlug: string | undefined, deps: PushTokenDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const clientId = env.TASKCELL_APP_CLIENT_ID;
  const key = clientId ? appKeyOf(env) : undefined;
  const pat = env.VANGUARD_PUSH_TOKEN || undefined;
  if (!clientId || !key) return pat;
  let lastError: unknown;
  if (repoSlug === undefined || !SLUG_RE.test(repoSlug) || repoSlug.split('/').some((s) => s === '.' || s === '..')) {
    lastError = new Error(`taskcell GitHub App (client ${clientId}): cannot determine a valid owner/repo for this checkout to mint a token`);
  } else {
    // One retry: a transient API failure must not cost the PR its CI trigger.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await mintAppToken(repoSlug, clientId, key, env, deps);
      } catch (cause) {
        lastError = cause;
      }
    }
  }
  if (pat === undefined) throw lastError;
  (deps.warn ?? ((m: string): void => console.error(`taskcell: ${m}`)))(
    `${lastError instanceof Error ? lastError.message : String(lastError)}; using VANGUARD_PUSH_TOKEN`,
  );
  return pat;
}

/** A provider that re-resolves the credential on every call (never caches a minted token). */
export function tokenProviderFor(repoPath: string, repoSlug?: string, deps: PushTokenDeps = {}): () => Promise<string | undefined> {
  return async () => pushToken(repoSlug ?? (await repoSlugOf(repoPath, deps.env)), deps);
}
