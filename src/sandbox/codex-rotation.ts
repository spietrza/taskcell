import { appendFile, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a local run's Codex credential lives: `CODEX_AUTH_FILE`, else `$CODEX_HOME|~/.codex/auth.json`. */
const hostCodexAuthFile = (env: NodeJS.ProcessEnv): string =>
  env.CODEX_AUTH_FILE || join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');

/** CI sources CODEX_AUTH_JSON from a stored secret; there is no host file to hand a rotation back to. */
const isCi = (env: NodeJS.ProcessEnv): boolean => [env.CI, env.GITHUB_ACTIONS].some((v) => v !== undefined && v !== '' && v !== '0' && v !== 'false');

type AuthJson = { tokens?: { access_token?: unknown; refresh_token?: unknown }; last_refresh?: unknown; [k: string]: unknown };

const parse = (json: string): AuthJson | undefined => {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as AuthJson) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reports a refresh-token rotation seen in the sidecar on the host and hands the rotated credential
 * back. `rotatedJson` is the sidecar's persisted auth.json (synthetic id_token, no API key), so only its
 * access/refresh tokens and `last_refresh` are merged into the host file — everything else in that file
 * is kept. No rotation (same refresh token) → silent.
 * Local run: written atomically, 0600, to the file the credential came from (`CODEX_AUTH_FILE`, else
 * `~/.codex/auth.json`) — but only while that file still holds the refresh token this run started with,
 * so a newer sign-in is never overwritten. An exported/stored `CODEX_AUTH_JSON` copy is not touched and
 * is named as stale. CI: the stored secret is now stale; the log and the job summary say so.
 * Never throws.
 */
export async function reportRotation(rotatedJson: string, originalRefreshToken: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rotated = parse(rotatedJson);
  const refresh = rotated?.tokens?.refresh_token;
  if (typeof refresh !== 'string' || refresh === originalRefreshToken) return;
  const lines = ['taskcell: the Codex (ChatGPT) refresh token was rotated during this run.'];
  if (isCi(env)) {
    const stale = 'The stored CODEX_AUTH_JSON secret is now stale: sign in again (codex login) and re-set the secret from ~/.codex/auth.json.';
    lines.push(stale);
    const summary = env.GITHUB_STEP_SUMMARY;
    if (summary) await appendFile(summary, `\n- Note: ${stale}\n`).catch(() => {});
  } else {
    const file = hostCodexAuthFile(env);
    lines.push(await handBack(file, originalRefreshToken, rotated!));
    lines.push('Any CODEX_AUTH_JSON still exported or stored elsewhere (shell, hub credential store) holds the old token: re-export it.');
  }
  for (const l of lines) console.warn(l);
}

async function handBack(file: string, original: string, rotated: AuthJson): Promise<string> {
  let target = file;
  let tmp: string | undefined;
  try {
    target = await realpath(file); // a symlinked auth.json is updated in place, not replaced by a copy
    const current = parse(await readFile(target, 'utf8'));
    if (current?.tokens?.refresh_token !== original) {
      return `${target} no longer holds the token this run started with, so it was left alone; sign in again (codex login) if the next run is refused.`;
    }
    const merged: AuthJson = { ...current, tokens: { ...current.tokens, access_token: rotated.tokens?.access_token, refresh_token: rotated.tokens?.refresh_token } };
    if (rotated.last_refresh !== undefined) merged.last_refresh = rotated.last_refresh;
    tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, target);
    return `The rotated tokens were written back to ${target}.`;
  } catch {
    if (tmp !== undefined) await rm(tmp, { force: true }).catch(() => {});
    return `Could not write the rotated credential back to ${target}; the old token is dead — sign in again (codex login).`;
  }
}
