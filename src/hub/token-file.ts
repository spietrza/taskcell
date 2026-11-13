// Persistent hub token (server mode): `--token-file` / `TASKCELL_HUB_TOKEN_FILE`. The file holds one
// token, at least 32 random bytes as hex or base64url, readable by the owner only.
import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 32+ bytes: 64 hex chars, or 43 base64url chars. */
const TOKEN_RE = /^(?:[0-9a-f]{64,}|[A-Za-z0-9_-]{43,})$/i;

function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Read the token from `path`, or create the file (mode 0600) with a fresh token when it is missing.
 * Refuses a file that is group/world accessible or holds less than 32 bytes of entropy. */
export async function loadOrCreateToken(path: string): Promise<string> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true });
    // Write a private temp file, then link it into place: the target appears complete or not at all,
    // so a concurrent launch never reads a half-written token, and the loser of a race keeps the winner's.
    const token = newToken();
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await link(tmp, path);
      return token;
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
      mode = (await stat(path)).mode;
    } finally {
      await unlink(tmp);
    }
  }
  // Windows reports 0o666 for every regular file; POSIX permission bits mean nothing there.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error(
      `Taskcell Hub: token file ${path} is readable by group or others (mode ${(mode & 0o777).toString(8)}) — run: chmod 600 ${path}`,
    );
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!TOKEN_RE.test(token)) {
    throw new Error(
      `Taskcell Hub: token file ${path} must hold at least 32 bytes of entropy as hex or base64url — run: taskcell hub rotate-token --token-file ${path}`,
    );
  }
  return token;
}

/** Replace the token in `path` (mode 0600) with a fresh one, and return it. A running hub keeps its
 * old token until it restarts. The directory must already exist. */
export async function rotateToken(path: string): Promise<string> {
  const token = newToken();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
  return token;
}
