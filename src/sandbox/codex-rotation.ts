import { appendFile, chmod, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a local run's Codex credential lives: `CODEX_AUTH_FILE`, else `$CODEX_HOME|~/.codex/auth.json`. */
const hostCodexAuthFile = (env: NodeJS.ProcessEnv): string =>
  env.CODEX_AUTH_FILE || join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');

/** CI sources CODEX_AUTH_JSON from a stored secret; there is no host file to hand a rotation back to. */
export const isCi = (env: NodeJS.ProcessEnv): boolean => [env.CI, env.GITHUB_ACTIONS].some((v) => v !== undefined && v !== '' && v !== '0' && v !== 'false');

// C0/C1 controls (U+009B is CSI on some terminals), line/paragraph separators and bidi overrides.
// Keep llm-proxy-server.mjs (a standalone sidecar script that cannot import this) in step.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `v` without control, separator and bidi-override characters. */
export const stripControlChars = (v: string): string => v.replace(CONTROL_CHARS, '');

const MAX_TOKEN = 8192;
const MAX_LAST_REFRESH = 64;
const clean = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TOKEN && /^[\x21-\x7e]+$/.test(v);
const cleanTimestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_LAST_REFRESH && /^[\x20-\x7e]+$/.test(v);

type AuthJson = { tokens?: { access_token?: unknown; refresh_token?: unknown }; last_refresh?: unknown; [k: string]: unknown };

const parse = (json: string): AuthJson | undefined => {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as AuthJson) : undefined;
  } catch {
    return undefined;
  }
};

/** `current` with the rotated access/refresh tokens and `last_refresh` merged in; undefined when `rotated` lacks a printable-ASCII, bounded-length string access/refresh token or has a malformed `last_refresh`. */
const merge = (current: AuthJson, rotated: AuthJson): AuthJson | undefined => {
  const access = rotated.tokens?.access_token;
  const refresh = rotated.tokens?.refresh_token;
  if (!clean(access) || !clean(refresh)) return undefined;
  if (rotated.last_refresh !== undefined && !cleanTimestamp(rotated.last_refresh)) return undefined;
  const merged: AuthJson = { ...current, tokens: { ...current.tokens, access_token: access, refresh_token: refresh } };
  if (rotated.last_refresh !== undefined) merged.last_refresh = rotated.last_refresh;
  return merged;
};

/**
 * Reports a refresh-token rotation seen in the sidecar on the host and hands the rotated credential
 * back. `rotatedJson` is the sidecar's persisted auth.json (synthetic id_token, no API key), so only its
 * access/refresh tokens and `last_refresh` are merged — everything else in the target is kept. No
 * rotation (same refresh token) → silent.
 * This process: a `CODEX_AUTH_JSON` in `env` that still holds the token the run started with is updated
 * in memory, so a later run of the same process (`taskcell watch`, a second stage) is not refused.
 * Local run: written atomically, 0600, to the file the credential came from (`CODEX_AUTH_FILE`, else
 * `~/.codex/auth.json`; a symlink is resolved once) — but only while that file still holds the refresh
 * token this run started with, so a newer sign-in is never overwritten. A `CODEX_AUTH_JSON` copy held
 * anywhere else (another shell, the hub credential store) is not touched and is named as stale.
 * `storedCredential` (a hub run on a user's stored credential): no host file is written, even one that
 * happens to hold the same refresh token.
 * CI: the stored secret is now stale; the log and the job summary say so.
 * Never throws.
 */
export async function reportRotation(
  rotatedJson: string,
  originalRefreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { storedCredential?: boolean } = {},
): Promise<void> {
  const rotated = parse(rotatedJson);
  const refresh = rotated?.tokens?.refresh_token;
  if (rotated === undefined || typeof refresh !== 'string' || refresh === originalRefreshToken) return;
  const lines = ['taskcell: the Codex (ChatGPT) refresh token was rotated during this run.'];
  const held = parse(env.CODEX_AUTH_JSON ?? '');
  const inMemory = held?.tokens?.refresh_token === originalRefreshToken ? merge(held, rotated) : undefined;
  if (inMemory !== undefined) env.CODEX_AUTH_JSON = JSON.stringify(inMemory);
  if (isCi(env)) {
    const stale = 'The stored CODEX_AUTH_JSON secret is now stale: sign in again (codex login) and re-set the secret from ~/.codex/auth.json.';
    lines.push(stale);
    const summary = env.GITHUB_STEP_SUMMARY;
    if (summary) await appendFile(summary, `\n- Note: ${stale}\n`).catch(() => {});
  } else {
    const later = inMemory !== undefined ? 'Later runs of this process use the rotated token. ' : '';
    const written = opts.storedCredential === true ? undefined : await handBack(hostCodexAuthFile(env), originalRefreshToken, rotated);
    // No local file held this credential (a hub run on a stored one, an export from elsewhere): name no
    // path on this machine and no local sign-in — the copy it came from is what must be replaced.
    lines.push(written ?? `${later}The credential this run started with did not come from a local auth file, so nothing was written back. The stored copy it came from (hub Settings → Credentials, an exported CODEX_AUTH_JSON) holds the old token: save a current credential there again.`);
    if (written !== undefined) lines.push(`${later}Any CODEX_AUTH_JSON exported or stored elsewhere (another shell, the hub credential store) holds the old token: set it again from the auth file.`);
  }
  for (const l of lines) console.warn(l);
}

/**
 * Merges the rotated tokens into `file`, at least as safely as the sidecar's own persist: a symlinked
 * `file` (dotfile managers) is resolved once and every check is made on the target, which must be a
 * regular file still holding the refresh token this run started with (so it is the file the credential
 * came from, not a newer sign-in). Written via a fresh `O_EXCL` sibling temp file chmod'd 0600
 * explicitly (the `mode:` option is masked by umask) and renamed over the target. Returns the line to log, or undefined when `file`
 * is not where this run's credential came from (missing, not a regular file, or holding another token):
 * it is then left alone.
 */
async function handBack(file: string, original: string, rotated: AuthJson): Promise<string | undefined> {
  let tmp: string | undefined;
  let held = false;
  try {
    const target = await realpath(file);
    const before = await lstat(target);
    if (!before.isFile()) return undefined;
    const current = parse(await readFile(target, 'utf8'));
    if (current?.tokens?.refresh_token !== original) return undefined; // not this run's source, or a newer sign-in: left alone
    held = true;
    const merged = merge(current, rotated);
    if (merged === undefined) throw new Error('rotated credential has no access token');
    // Set before the write so a write that fails half-way (ENOSPC) is still removed; the name is ours alone.
    tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); // wx: O_EXCL, never follows a planted link
    await chmod(tmp, 0o600);
    // The target must be the file that was read, untouched: not swapped (inode) and not rewritten in
    // place by a concurrent `codex` (mtime/size). Codex takes no lock, so a write landing between this
    // check and the rename can still be lost.
    const now = await lstat(target);
    if (!now.isFile() || now.ino !== before.ino || now.dev !== before.dev || now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      throw new Error('auth file changed during write-back');
    }
    await rename(tmp, target);
    return `The rotated tokens were written back to ${target}.`;
  } catch {
    if (tmp !== undefined) await rm(tmp, { force: true }).catch(() => {});
    if (!held) return undefined; // missing or unreadable: not where the credential came from
    return `Could not write the rotated credential back to ${file}; the old token is dead — sign in again (codex login).`;
  }
}
