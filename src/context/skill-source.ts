import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { TaskcellError } from '../core/errors.js';
import { hostGitArgs } from '../worktree/host-git.js';

const execFileP = promisify(execFile);

const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

/** The upstream could not be reached or the commit not fetched: update keeps the pin. */
export class SkillFetchError extends TaskcellError {}

/**
 * Where a skill's upstream lives. Host-only: the real one shells out to git; tests stub it. `resolve`
 * maps a ref (default: the head of the default branch) to a full commit sha, undefined when the ref
 * does not exist, and throws a SkillFetchError when git itself fails; `fetch` checks that commit out
 * into a fresh directory the caller removes.
 */
export interface SkillSource {
  resolve(source: string, ref?: string): Promise<string | undefined>;
  fetch(source: string, commit: string): Promise<string>;
}

/** A source must be https without credentials: they would be written to the lock and printed. */
export function assertHttpsSource(source: string): void {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new TaskcellError(`"${source}" is not a URL; a skill source must be an https git URL.`);
  }
  if (url.protocol !== 'https:') throw new TaskcellError(`Refusing source ${source}: only https git URLs are supported.`);
  if (url.username !== '' || url.password !== '') throw new TaskcellError('Refusing a source URL with credentials (user:password@).');
}

/** A path inside a repo: relative, no `..` segment. Returns it normalized ('.' for the root). */
export function assertRepoPath(path: string): string {
  const rel = normalize(path);
  if (path === '' || isAbsolute(path) || rel === '..' || rel.startsWith(`..${sep}`) || path.includes('\0')) {
    throw new TaskcellError(`Refusing path "${path}": it must stay inside the repository.`);
  }
  return rel.length > 1 ? rel.replace(/[\\/]+$/, '') : rel;
}

const firstLine = (cause: unknown): string => (cause instanceof Error ? cause.message.split('\n')[0] ?? '' : String(cause));

/**
 * Host git over one protocol (https; tests pass 'file' for a local repo). The allow-list is explicit
 * so a URL rewrite (`url.<base>.insteadOf`) or a redirect cannot reach ssh, ext or file transports.
 */
export function createGitSkillSource(protocol: 'https' | 'file' = 'https'): SkillSource {
  const git = async (args: string[], cwd?: string): Promise<string> =>
    (
      await execFileP('git', hostGitArgs(['-c', 'protocol.allow=never', '-c', `protocol.${protocol}.allow=always`, ...args]), {
        ...(cwd !== undefined ? { cwd } : {}),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120_000,
      })
    ).stdout;
  const check = (source: string): void => {
    if (protocol === 'https') assertHttpsSource(source);
  };
  return {
    async resolve(source, ref) {
      check(source);
      if (ref !== undefined && /^[0-9a-f]{40}$/.test(ref)) return ref;
      const names = ref === undefined ? ['HEAD'] : [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`];
      let out: string;
      try {
        out = await git(['ls-remote', source, ...names]);
      } catch (cause) {
        throw new SkillFetchError(`git ls-remote ${source} failed: ${firstLine(cause)}`);
      }
      const lines = out.split('\n').filter((l) => l !== '');
      // An annotated tag's peeled commit (^{}) wins over the tag object; a tag over a same-named branch.
      const pick = lines.find((l) => l.endsWith('^{}')) ?? lines.find((l) => l.includes('refs/tags/')) ?? lines[0];
      const sha = pick?.split(/\s/)[0];
      return sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
    },
    async fetch(source, commit) {
      check(source);
      const dir = await mkdtemp(join(tmpdir(), 'vg-skill-'));
      try {
        await git(['init', '-q'], dir);
        await git(['fetch', '-q', '--depth', '1', source, commit], dir);
        // Symlinks are checked out as symlinks (never followed) so readSkillFiles can refuse them.
        await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
        return dir;
      } catch (cause) {
        await rm(dir, { recursive: true, force: true });
        throw new SkillFetchError(`Could not fetch ${source} @ ${commit.slice(0, 7)}: ${firstLine(cause)}`);
      }
    },
  };
}

export const gitSkillSource: SkillSource = createGitSkillSource();

/** Files of one skill: path relative to the skill directory (posix) -> bytes. */
export type SkillFiles = Map<string, Buffer>;

/**
 * Read the skill at `path` inside a directory. Only that directory's regular files are taken; a
 * symlink anywhere (the path itself, a parent, or a file inside), a path that escapes the tree, or a
 * missing SKILL.md is refused. Returns undefined when the directory does not exist.
 */
export async function readSkillFiles(tree: string, path: string): Promise<SkillFiles | undefined> {
  const rel = assertRepoPath(path);
  let cur = tree;
  for (const part of rel.split(sep).filter((p) => p !== '' && p !== '.')) {
    cur = join(cur, part);
    const info = await lstat(cur).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
      throw err;
    });
    if (info === undefined) return undefined;
    if (info.isSymbolicLink()) throw new TaskcellError(`Refusing path "${path}": ${part} is a symlink.`);
  }
  const root = cur;
  if (!(await lstat(root)).isDirectory()) throw new TaskcellError(`Refusing path "${path}": not a directory.`);
  const files: SkillFiles = new Map();
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new TaskcellError(`Refusing skill: ${name} is a symlink.`);
      if (entry.isDirectory()) await walk(full, `${name}/`);
      else if (entry.isFile()) {
        bytes += (await lstat(full)).size;
        if (files.size >= MAX_FILES || bytes > MAX_BYTES) throw new TaskcellError(`Refusing skill: more than ${MAX_FILES} files or ${MAX_BYTES} bytes.`);
        files.set(name, await readFile(full));
      } else throw new TaskcellError(`Refusing skill: ${name} is not a regular file.`);
    }
  };
  await walk(root, '');
  if (!files.has('SKILL.md')) throw new TaskcellError(`No SKILL.md at "${path}".`);
  return files;
}

export interface LineDiff {
  added: number;
  removed: number;
  /** The hunks of a unified diff (from the first `@@`); '' when equal. */
  text: string;
}

/** Line diff by `git diff --no-index`: the hunks and the +/- counts. */
export async function lineDiff(before: string, after: string): Promise<LineDiff> {
  if (before === after) return { added: 0, removed: 0, text: '' };
  const dir = await mkdtemp(join(tmpdir(), 'vg-diff-'));
  try {
    await writeFile(join(dir, 'a'), before);
    await writeFile(join(dir, 'b'), after);
    // Exit status 1 means "differs".
    const out = await new Promise<string>((resolve, reject) => {
      execFile('git', hostGitArgs(['diff', '--no-index', '--no-color', '--text', '--no-ext-diff', '--no-textconv', '--', 'a', 'b']), { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
        err !== null && (err as { code?: number }).code !== 1 ? reject(err) : resolve(stdout),
      );
    });
    const body = out.slice(Math.max(0, out.indexOf('\n@@') + 1)).trimEnd();
    const changed = body.split('\n').filter((l) => !l.startsWith('\\'));
    return {
      added: changed.filter((l) => l.startsWith('+')).length,
      removed: changed.filter((l) => l.startsWith('-')).length,
      text: body,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
