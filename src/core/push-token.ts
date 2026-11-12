import { createSign } from 'node:crypto';
import { execa } from 'execa';
import { registerInjectedSecretValue } from './secret-scan.js';

/**
 * The credential for opening/updating PRs and pushing PR branches. When the taskcell GitHub App is
 * configured (TASKCELL_APP_CLIENT_ID + TASKCELL_APP_PRIVATE_KEY) a fresh installation token is minted
 * on every call: it lives 1 hour and an implement run lasts far longer, so it can't be minted at
 * process start. Otherwise VANGUARD_PUSH_TOKEN, otherwise undefined (the ambient credential).
 */

export interface PushTokenDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Injected clock (ms since epoch). */
  now?: () => number;
}

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
// The least the factory needs: no Workflows, no Administration, nothing beyond these three.
const PERMISSIONS = { contents: 'write', issues: 'write', pull_requests: 'write' };

const b64url = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

/** RS256 App JWT: iat backdated 60 s for clock drift, valid 9 minutes (GitHub caps at 10). */
export function signAppJwt(clientId: string, privateKey: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: clientId, iat, exp: iat + 600 - 60 }))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey);
  return `${input}.${b64url(sig)}`;
}

async function githubJson(f: typeof fetch, url: string, method: string, jwt: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await f(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
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

/** Mint a fresh installation token for `repoSlug` (owner/repo). Errors name the App and repo, never the key. */
async function mintAppToken(repoSlug: string, clientId: string, privateKey: string, deps: PushTokenDeps): Promise<string> {
  const f = deps.fetch ?? fetch;
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
  const inst = await call(`${API}/repos/${repoSlug}/installation`, 'GET');
  if (inst.status === 401 || inst.status === 403) throw fail(`GitHub rejected the App credentials (HTTP ${inst.status}); check the client ID and private key`);
  const id = inst.body.id;
  if (inst.status !== 200 || typeof id !== 'number') {
    throw fail(`no installation found for the repository (HTTP ${inst.status}); is the App installed on it?`);
  }
  // Scoped to this one repo and the three permissions the factory uses, whatever the App is granted.
  const tok = await call(`${API}/app/installations/${id}/access_tokens`, 'POST', {
    repositories: [repoSlug.split('/')[1]],
    permissions: PERMISSIONS,
  });
  const token = tok.body.token;
  if (tok.status !== 201 || typeof token !== 'string' || token === '') {
    throw fail(`installation token request failed (HTTP ${tok.status})`);
  }
  registerInjectedSecretValue(token);
  return token;
}

/** `owner/repo` for the checkout: GITHUB_REPOSITORY, else parsed from the origin URL. undefined when neither yields one. */
export async function repoSlugOf(repoPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    return /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(stdout.trim())?.[1];
  } catch {
    return undefined;
  }
}

/** See file header. `repoSlug` is `owner/repo`. */
export async function pushToken(repoSlug: string | undefined, deps: PushTokenDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const clientId = env.TASKCELL_APP_CLIENT_ID;
  const key = env.TASKCELL_APP_PRIVATE_KEY;
  if (clientId && key) {
    if (repoSlug === undefined) throw new Error(`taskcell GitHub App (client ${clientId}): cannot determine the owner/repo of this checkout to mint a token`);
    return mintAppToken(repoSlug, clientId, key.replace(/\\n/g, '\n'), deps);
  }
  return env.VANGUARD_PUSH_TOKEN || undefined;
}

/** A provider that re-resolves the credential on every call (never caches a minted token). */
export function tokenProviderFor(repoPath: string, repoSlug?: string, deps: PushTokenDeps = {}): () => Promise<string | undefined> {
  return async () => pushToken(repoSlug ?? (await repoSlugOf(repoPath, deps.env)), deps);
}
