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
const TOO_BIG = `Refusing skill: more than ${MAX_FILES} files or ${MAX_BYTES} bytes.`;

/** The upstream could not be reached or the commit not fetched: update keeps the pin. */
export class SkillFetchError extends TaskcellError {}

/**
 * Where a skill's upstream lives. Host-only: the real one shells out to git; tests stub it. `resolve`
 * maps a ref (default: the head of the default branch) to a full commit sha, undefined when the ref
 * does not exist, and throws a SkillFetchError when git itself fails; `fetch` checks out `path`
 * (default: the whole repo) of that commit and returns the tree's root. The source owns the trees it
 * fetched and may hand the same one out again for the same source and commit; `dispose` removes them.
 */
export interface SkillSource {
  resolve(source: string, ref?: string): Promise<string | undefined>;
  fetch(source: string, commit: string, path?: string): Promise<string>;
  dispose?(): Promise<void>;
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

/** Why git failed: its stderr (the `fatal:` line), else the error's first line. Raw upstream text: sanitise where it is printed. */
function gitFailure(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : cause instanceof Error ? cause.message.split('\n')[0] ?? '' : String(cause);
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.slice(-3).join('; ').slice(0, 500);
}

/** `ls-remote` treats its ref arguments as glob patterns, so a ref from input must be a plain name. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/;

/**
 * Variables that point git at another repository or inject config for one command. The fetch and
 * checkout of an untrusted tree run without them; config files (user, system, or the ones
 * GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM name) still apply, so that is where an operator's
 * `url.<base>.insteadOf` rewrite or credential helper has to live.
 */
const SCRUBBED_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

function untrustedTreeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(base).filter(([key]) => !SCRUBBED_ENV.test(key))), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
}

/**
 * Host git for an upstream nobody has reviewed yet. On top of hostGitArgs (no hooks, no fsmonitor):
 * no symlink is ever created on the host (`core.symlinks=false`; fetch refuses a skill that contains
 * one from the tree listing), the LFS filter is off, and the transports are an explicit allow-list:
 * https, plus ssh so an operator's own `url.<ssh>.insteadOf` rewrite of an https source keeps working
 * (the source itself must still be https; a redirect cannot change the transport). ext and file are
 * never reachable. Tests pass 'file' for a local repo.
 * shortcut: a smudge filter other than LFS that the operator defined globally still runs if the
 * upstream's .gitattributes names it; read the blobs with cat-file instead of a checkout if that matters.
 */
export function createGitSkillSource(protocol: 'https' | 'file' = 'https'): SkillSource {
  const config = [
    'core.symlinks=false',
    'filter.lfs.smudge=',
    'filter.lfs.process=',
    'filter.lfs.required=false',
    'protocol.allow=never',
    `protocol.${protocol}.allow=always`,
    ...(protocol === 'https' ? ['protocol.ssh.allow=always'] : []),
  ];
  const git = async (args: string[], cwd?: string): Promise<string> =>
    (
      await execFileP('git', hostGitArgs([...config.flatMap((c) => ['-c', c]), ...args]), {
        ...(cwd !== undefined ? { cwd } : {}),
        env: untrustedTreeEnv(),
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  const check = (source: string): void => {
    if (protocol === 'https') assertHttpsSource(source);
  };
  // One tree per source and commit for the life of a command: skills sharing them share the fetch.
  const trees = new Map<string, { dir: string; patterns: string[] }>();
  return {
    async resolve(source, ref) {
      check(source);
      if (ref !== undefined && /^[0-9a-f]{40}$/.test(ref)) return ref;
      if (ref !== undefined && (!REF_RE.test(ref) || ref.includes('..'))) throw new TaskcellError(`Invalid ref "${ref}": use a branch name, a tag name or a full commit sha.`);
      const names = ref === undefined ? ['HEAD'] : [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`];
      let out: string;
      try {
        out = await git(['ls-remote', '--', source, ...names]);
      } catch (cause) {
        throw new SkillFetchError(`git ls-remote ${source} failed: ${gitFailure(cause)}`);
      }
      // ls-remote matches by tail (`HEAD` also matches refs/remotes/origin/HEAD): only the exact names count.
      const shas = new Map(out.split('\n').map((l): [string, string] => [l.slice(l.indexOf('\t') + 1), l.slice(0, l.indexOf('\t'))]));
      // An annotated tag's peeled commit (^{}) wins over the tag object; a tag over a same-named branch.
      const sha = names.map((n) => shas.get(n)).find((s) => s !== undefined);
      return sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
    },
    async fetch(source, commit, path = '.') {
      check(source);
      const rel = assertRepoPath(path).split(sep).join('/');
      const key = `${commit} ${source}`;
      try {
        let tree = trees.get(key);
        if (tree === undefined) {
          const dir = await mkdtemp(join(tmpdir(), 'vg-skill-'));
          try {
            await git(['init', '-q'], dir);
            await git(['remote', 'add', '--', 'origin', source], dir);
            // Only the pinned commit and its trees: the blobs come with the checkout, for the sparse
            // path alone. A server without filter support sends the commit's whole snapshot instead.
            await git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit], dir);
          } catch (cause) {
            await rm(dir, { recursive: true, force: true });
            throw cause;
          }
          tree = { dir, patterns: [] };
          trees.set(key, tree);
        }
        // Before any file content is transferred: the file limit, and no symlink in the skill. An
        // absent path lists nothing (exit 0), so any ls-tree failure is a real one; readSkillFiles reports the rest.
        // Literal: a path such as `:foo` is a directory name, not pathspec magic.
        const listing = await git(['--literal-pathspecs', 'ls-tree', '-r', '-z', 'FETCH_HEAD', ...(rel === '.' ? [] : ['--', rel])], tree.dir);
        const entries = listing.split('\0').filter((e) => e !== '');
        if (entries.length > MAX_FILES) throw new TaskcellError(TOO_BIG);
        const link = entries.find((e) => e.startsWith('120000 '));
        if (link !== undefined) throw new TaskcellError(`Refusing skill: ${link.slice(link.indexOf('\t') + 1)} is a symlink.`);
        tree.patterns.push(rel === '.' ? '/*' : `/${rel.replace(/[\\*?[]/g, '\\$&')}/`);
        await git(['sparse-checkout', 'set', '--no-cone', ...tree.patterns], tree.dir);
        await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], tree.dir);
        return tree.dir;
      } catch (cause) {
        if (cause instanceof TaskcellError) throw cause;
        throw new SkillFetchError(`Could not fetch ${source} @ ${commit.slice(0, 7)}: ${gitFailure(cause)}`);
      }
    },
    async dispose() {
      const dirs = [...trees.values()].map((t) => t.dir);
      trees.clear();
      for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    },
  };
}

export const gitSkillSource: SkillSource = createGitSkillSource();

/** One file of a skill: its bytes and whether it is executable (the one mode bit git tracks). */
export interface SkillFile {
  data: Buffer;
  exec: boolean;
}

/** Files of one skill: path relative to the skill directory (posix) -> file. */
export type SkillFiles = Map<string, SkillFile>;

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
        const info = await lstat(full);
        bytes += info.size;
        if (files.size >= MAX_FILES || bytes > MAX_BYTES) throw new TaskcellError(TOO_BIG);
        files.set(name, { data: await readFile(full), exec: (info.mode & 0o111) !== 0 });
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
