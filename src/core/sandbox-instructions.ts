import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { instructionPaths, resolveInstructionSha } from '../context/instruction-files.js';
import { hostGitArgs } from '../worktree/host-git.js';
import { SandboxError } from './errors.js';
import { ensureStateDir, stateDir } from './state-path.js';
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
  const paths = [...new Set([...base.keys(), ...head])].sort();
  if (paths.some((p) => p.includes('\n'))) throw new SandboxError('Refusing to overlay instruction files: a path contains a newline');

  const staging = await ensureStateDir(ctx.localRepoPath, join(stateDir(ctx.localRepoPath), 'staging', `${ctx.taskId}-instructions`));
  /** Fill a fresh staging dir with `only`, each file written by `put`; undefined when there is nothing to copy in. */
  const fill = async (only: string[], put: (path: string, dest: string) => Promise<void>): Promise<string | undefined> => {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    for (const p of only) {
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
      // A symlink hashes as its target (what git stores), prefixed L; a regular file as its content.
      const probe = (p: string): string => `if [ -L ${quote(p)} ]; then printf 'L%s\\n' "$(printf %s "$(readlink -- ${quote(p)})" | git hash-object --stdin)"; elif [ -e ${quote(p)} ]; then git hash-object -- ${quote(p)} || echo ERR; else echo MISSING; fi`;
      const lines = (await ctx.sandbox.exec(`cd ${WORKDIR} && ${paths.map(probe).join('; ')}`)).stdout.split('\n');
      restore = [];
      for (const [i, p] of paths.entries()) {
        const now = lines[i];
        // Missing or unreadable output counts as "unchanged": the worktree's version wins.
        if (now === undefined || !/^(L?[0-9a-f]+|MISSING)$/.test(now) || now.replace(/^L/, '') === (base.get(p)?.oid ?? 'MISSING')) restore.push(p);
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
        await cp(join(ctx.worktreePath, p), dest, { force: true, verbatimSymlinks: true }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
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
    const head = await readFile(join(ctx.worktreePath, path)).catch(() => Buffer.alloc(0));
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
