import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { instructionPaths, resolveInstructionSha } from '../context/instruction-files.js';
import { hostGitArgs } from '../worktree/host-git.js';
import { SandboxError } from './errors.js';
import { ensureStateDir, stateDir } from './state-path.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { RunContext } from './taskcell.js';

const WORKDIR = '/workspace';
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

interface InstructionBlob {
  oid: string;
  symlink: boolean;
}

/** Instruction path -> blob in `sha`'s tree (submodules excluded; a symlink carries its target as the blob). */
async function instructionBlobs(cwd: string, sha: string): Promise<Map<string, InstructionBlob>> {
  const { stdout } = await execa('git', hostGitArgs(['ls-tree', '-r', '-z', '--end-of-options', sha]), { cwd });
  const blobs = new Map<string, InstructionBlob>();
  for (const entry of stdout.split('\0')) {
    const m = /^(100\d+|120000) blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
    if (m !== null && instructionPaths([m[3]!]).length > 0) blobs.set(m[3]!, { oid: m[2]!, symlink: m[1] === '120000' });
  }
  return blobs;
}

/** What instructionPaths() matches, as find(1) tests (case-insensitive); results are filtered through instructionPaths() again. */
const FIND_INSTRUCTIONS = [
  ...['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENT.md'].map((n) => `-iname ${quote(n)}`),
  ...['*/.claude', '*/.claude/*', '*/.cursor', '*/.cursor/*', './.mcp.json', './.github/vanguard-skills', './.github/vanguard-skills/*'].map((p) => `-ipath ${quote(p)}`),
].join(' -o ');

/** Instruction files (regular files and symlinks) present in the sandbox workspace, whatever the worktree holds. */
async function sandboxInstructionPaths(sandbox: IsolatedSandboxProvider): Promise<string[]> {
  const res = await sandbox.exec(`cd ${WORKDIR} && find . -path ./.git -prune -o \\( -type f -o -type l \\) \\( ${FIND_INSTRUCTIONS} \\) -print0`);
  if (res.exitCode !== 0) throw new SandboxError(`Could not list instruction files in the sandbox: ${res.stderr}`);
  return instructionPaths(res.stdout.split('\0').filter((p) => p !== '').map((p) => p.replace(/^\.\//, '')));
}

/** Per path, the sandbox copy's hash: `L<oid>` for a symlink (its target), `<oid>` for a file, `MISSING`; undefined when unreadable. */
async function probeSandbox(sandbox: IsolatedSandboxProvider, paths: string[]): Promise<(string | undefined)[]> {
  if (paths.length === 0) return [];
  // A symlink hashes as its target (what git stores), prefixed L; a regular file as its content.
  const probe = (p: string): string => `if [ -L ${quote(p)} ]; then printf 'L%s\\n' "$(printf %s "$(readlink -- ${quote(p)})" | git hash-object --stdin)"; elif [ -e ${quote(p)} ]; then git hash-object -- ${quote(p)} || echo ERR; else echo MISSING; fi`;
  const lines = (await sandbox.exec(`cd ${WORKDIR} && ${paths.map(probe).join('; ')}`)).stdout.split('\n');
  return paths.map((_, i) => (lines[i] !== undefined && /^(L?[0-9a-f]+|MISSING)$/.test(lines[i]!) ? lines[i] : undefined));
}

/**
 * The instruction files the factory itself put in the sandbox workspace at provisioning (worktree copy plus
 * injected skills, e.g. `.cursor/rules/<id>.mdc`), path -> hash. The overlay keeps these and nothing else
 * the trusted ref and the worktree do not carry, so a file an earlier stage left only in the sandbox cannot
 * steer a later one.
 */
export async function snapshotSandboxInstructions(sandbox: IsolatedSandboxProvider): Promise<Map<string, string>> {
  const paths = await sandboxInstructionPaths(sandbox);
  const hashes = await probeSandbox(sandbox, paths);
  return new Map(paths.flatMap((p, i) => (hashes[i] !== undefined && hashes[i] !== 'MISSING' ? [[p, hashes[i]!] as const] : [])));
}

/** lstat of each leading component of `parts` under `root`, stopping after the first symlink or before the first missing one. */
async function lstatChain(root: string, parts: string[]): Promise<Stats[]> {
  const stats: Stats[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const st = await lstat(join(root, ...parts.slice(0, i))).catch(() => undefined);
    if (st === undefined) break;
    stats.push(st);
    if (st.isSymbolicLink()) break;
  }
  return stats;
}

/**
 * A worktree path the host may read: undefined when it or any parent directory is a symlink (the PR head
 * controls the worktree, so a link must never make the host read outside it). With `allowLeafLink`, the
 * path itself may be a symlink (copied verbatim, never followed).
 */
async function worktreeFile(root: string, path: string, allowLeafLink: boolean): Promise<string | undefined> {
  const parts = path.split('/');
  if (parts.some((c) => c === '' || c === '.' || c === '..')) return undefined;
  const stats = await lstatChain(root, parts);
  const leaf = stats.length === parts.length ? stats.at(-1) : undefined;
  if (leaf === undefined) return undefined;
  return (leaf.isSymbolicLink() ? allowLeafLink : leaf.isFile()) ? join(root, path) : undefined;
}

/** True when a parent directory of `path` under `root` is a symlink. */
async function linkedParent(root: string, path: string): Promise<boolean> {
  return (await lstatChain(root, path.split('/').slice(0, -1))).at(-1)?.isSymbolicLink() ?? false;
}

async function replaceInSandbox(ctx: RunContext, remove: string[], stagingDir: string | undefined): Promise<void> {
  if (remove.length > 0) {
    const res = await ctx.sandbox.exec(`cd ${WORKDIR} && rm -rf -- ${remove.map(quote).join(' ')}`);
    if (res.exitCode !== 0) throw new SandboxError(`Could not replace instruction files in the sandbox: ${res.stderr}`);
  }
  if (stagingDir !== undefined) await ctx.sandbox.copyIn(stagingDir, WORKDIR);
}

/**
 * Swap the sandbox workspace's instruction files (CLAUDE.md, AGENTS.md, .claude/, .cursor/, …) for the
 * trusted ref's copies, so the agent is steered by the default branch, not the change it works on. Only the
 * sandbox changes; the host worktree keeps the branch's own files.
 *
 * Returns the restore step to run when the agent is done, before copy-back: it puts the worktree's version
 * back, so the overlay never reaches the diff. With `keepEdits`, a file the agent changed away from the
 * overlay (a legitimate edit) is left alone and copies back; otherwise every agent edit is discarded.
 */
export async function overlaySandboxInstructions(ctx: RunContext, ref: string): Promise<(keepEdits: boolean) => Promise<void>> {
  const sha = await resolveInstructionSha(ctx.localRepoPath, ref, ctx.log);
  const base = await instructionBlobs(ctx.localRepoPath, sha);
  const listed = await execa('git', hostGitArgs(['ls-files', '-z', '-c', '-o']), { cwd: ctx.worktreePath });
  const head = instructionPaths(listed.stdout.split('\0').filter((p) => p !== ''));
  // Anything else in the sandbox (an earlier stage's skill or rule file the worktree never got) goes too,
  // unless it is the factory's own provisioning, unchanged.
  const inSandbox = await sandboxInstructionPaths(ctx.sandbox);
  const known = new Set([...base.keys(), ...head]);
  const extra = inSandbox.filter((p) => !known.has(p));
  const extraHashes = await probeSandbox(ctx.sandbox, extra);
  const provisioned = ctx.provisionedInstructions ?? new Map<string, string>();
  const strays = extra.filter((p, i) => extraHashes[i] === undefined || provisioned.get(p) !== extraHashes[i]);
  const paths = [...new Set([...known, ...strays])].sort();
  if (paths.some((p) => p.includes('\n'))) throw new SandboxError('Refusing to overlay instruction files: a path contains a newline');

  const staging = await ensureStateDir(ctx.localRepoPath, join(stateDir(ctx.localRepoPath), 'staging', `${ctx.taskId}-instructions`));
  /** Fill a fresh staging dir with `only`, each file written by `put`; undefined when there is nothing to copy in. */
  const fill = async (only: string[], put: (path: string, dest: string) => Promise<void>): Promise<string | undefined> => {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    for (const p of only) {
      // A link staged for a parent (copied verbatim) already stands for the whole subtree: never write through it.
      if (await linkedParent(staging, p)) continue;
      await mkdir(dirname(join(staging, p)), { recursive: true });
      await put(p, join(staging, p));
    }
    return only.length > 0 ? staging : undefined;
  };
  try {
    const dir = await fill([...base.keys()], async (p, dest) => {
      const entry = base.get(p)!;
      const blob = await execa('git', hostGitArgs(['cat-file', 'blob', entry.oid]), { cwd: ctx.localRepoPath, encoding: 'buffer', stripFinalNewline: false });
      if (entry.symlink) await symlink(Buffer.from(blob.stdout).toString(), dest);
      else await writeFile(dest, blob.stdout);
    });
    await replaceInSandbox(ctx, paths, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  ctx.log.info({ taskId: ctx.taskId, ref, sha, files: base.size }, `instructions: sandbox workspace uses ${ref}@${sha.slice(0, 7)}, not the change`);

  return async (keepEdits) => {
    // Per path: put the worktree's version back, unless the agent edited it (merged onto the worktree's) or deleted it.
    const edits = new Map<string, Buffer>();
    let restore = paths;
    if (keepEdits) {
      const lines = await probeSandbox(ctx.sandbox, paths);
      restore = [];
      for (const [i, p] of paths.entries()) {
        const now = lines[i];
        // Missing or unreadable output counts as "unchanged": the worktree's version wins.
        if (now === undefined || now.replace(/^L/, '') === (base.get(p)?.oid ?? 'MISSING')) restore.push(p);
        else if (now === 'MISSING' || now.startsWith('L')) continue; // the agent deleted it, or made it a symlink: its call
        else {
          const out = (await ctx.sandbox.exec(`cd ${WORKDIR} && base64 -w0 -- ${quote(p)}`)).stdout.trim();
          if (out === '') restore.push(p);
          else {
            edits.set(p, Buffer.from(out, 'base64'));
            restore.push(p);
          }
        }
      }
    }
    try {
      const dir = await fill(restore, async (p, dest) => {
        const edit = edits.get(p);
        if (edit !== undefined) {
          await writeFile(dest, await mergeEdit(ctx, p, edit, base.get(p)));
          return;
        }
        // Only the worktree's own file (or link, verbatim): never through a symlinked parent out of the worktree.
        const src = await worktreeFile(ctx.worktreePath, p, true);
        if (src !== undefined) await cp(src, dest, { force: true, verbatimSymlinks: true });
      });
      // An edited path is also removed first: the staged merge replaces the agent's copy.
      await replaceInSandbox(ctx, restore, dir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
}

/**
 * The agent started from the trusted copy, so its edit is a change against that copy; apply it onto the
 * worktree's own version (3-way, base = trusted copy) so the PR's edits to the file are not lost. Overlapping
 * edits leave conflict markers in the file, visible in the diff.
 */
async function mergeEdit(ctx: RunContext, path: string, agent: Buffer, base: InstructionBlob | undefined): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'taskcell-instr-merge-'));
  try {
    const baseContent = base !== undefined ? (await execa('git', hostGitArgs(['cat-file', 'blob', base.oid]), { cwd: ctx.localRepoPath, encoding: 'buffer', stripFinalNewline: false })).stdout : Buffer.alloc(0);
    const src = await worktreeFile(ctx.worktreePath, path, false);
    const head = src !== undefined ? await readFile(src) : Buffer.alloc(0);
    await Promise.all([writeFile(join(dir, 'agent'), agent), writeFile(join(dir, 'base'), baseContent), writeFile(join(dir, 'head'), head)]);
    const merged = await execa('git', hostGitArgs(['merge-file', '-p', '-L', 'agent', '-L', 'default branch', '-L', 'PR head', 'agent', 'base', 'head']), { cwd: dir, encoding: 'buffer', stripFinalNewline: false, reject: false });
    const conflicts = merged.exitCode ?? 255; // 1..127 = conflict count; 255 = error
    if (conflicts >= 128) throw new SandboxError(`Could not merge the agent's edit to ${path} onto the PR's version`);
    if (conflicts > 0) ctx.log.warn({ taskId: ctx.taskId, path }, 'instructions: the agent edit overlaps the PR head edit — conflict markers left in the file');
    return Buffer.from(merged.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
