import { execFile } from 'node:child_process';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { neutralizeMentions, neutralizePromptTags } from '../context/escape.js';
import { lockEntry, readSkillLock, SKILL_LOCK_FILE, sha256Hex, skillStatus, type SkillLockEntry, type SkillStatus } from '../context/skill-lock.js';
import { skillDirsIn } from '../context/skill-registry.js';
import { assertHttpsSource, assertRepoPath, gitSkillSource, lineDiff, readSkillFiles, SkillFetchError, type LineDiff, type SkillFiles, type SkillSource } from '../context/skill-source.js';
import { resolveTargetBase } from '../core/base-branch.js';
import { TaskcellError } from '../core/errors.js';
import { disposeContext, prepareContext, type RunContext, type RunDeps } from '../core/taskcell.js';
import type { CommandRunner } from '../pipeline/remote-branch.js';
import { deliverChange } from '../runners/deliver-change.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { Command } from './args.js';

export type SkillsCommand = Extract<Command, { kind: 'skills' }>;

/** Resolves a git source URL to its default branch head sha; undefined when it cannot. */
export type GitResolver = (source: string) => Promise<string | undefined>;

const execFileP = promisify(execFile);

/**
 * Host-only: `git ls-remote <url> HEAD` (the default branch head). Read-only, so unlike add/update it
 * keeps no protocol allow-list: an operator's `url.<base>.insteadOf` rewrite (e.g. to ssh) still resolves.
 */
export const gitLsRemoteHead: GitResolver = async (source) => {
  try {
    const { stdout } = await execFileP('git', ['ls-remote', source, 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
    });
    return /^[0-9a-f]{40}(?=\s|$)/.exec(stdout)?.[0];
  } catch {
    return undefined;
  }
};

export interface SkillRow {
  name: string;
  source: string;
  commit: string;
  status: SkillStatus;
}

async function skillRows(dir: string): Promise<SkillRow[]> {
  const lock = await readSkillLock(dir);
  // The same set the registry loads: no SKILL.md or a symlinked one is not a skill.
  const skills = await skillDirsIn(dir).catch(() => {
    throw new TaskcellError(`Cannot read skills directory ${dir}.`);
  });
  const rows: SkillRow[] = [];
  for (const [name, skillDir] of Object.entries(skills).sort(([a], [b]) => a.localeCompare(b))) {
    const entry = lockEntry(lock, name);
    rows.push({ name, source: entry?.source ?? '-', commit: entry?.commit ?? '', status: await skillStatus(skillDir, entry) });
  }
  return rows;
}

const short = (sha: string): string => (sha === '' ? '-' : sha.slice(0, 7));

export async function skillsList(dir: string, out: (line: string) => void = console.log): Promise<SkillRow[]> {
  const rows = await skillRows(dir);
  for (const r of rows) out([r.name, r.source, short(r.commit), r.status].join('\t'));
  return rows;
}

/** Report each skill against its upstream head; returns the exit code (--strict: 1 on outdated or modified). */
export async function skillsCheck(
  dir: string,
  strict: boolean,
  resolver: GitResolver = gitLsRemoteHead,
  out: (line: string) => void = console.log,
): Promise<number> {
  const rows = await skillRows(dir);
  let bad = false;
  for (const r of rows) {
    let report: string;
    if (r.status === 'local') report = 'local';
    else {
      const upstream = await resolver(r.source);
      report = upstream === undefined ? 'unknown' : upstream === r.commit ? 'current' : `outdated (upstream ${short(upstream)})`;
      if (report.startsWith('outdated')) bad = true;
      if (r.status === 'modified') {
        bad = true;
        report += ', modified';
      }
    }
    out([r.name, r.source, short(r.commit), report].join('\t'));
  }
  return strict && bad ? 1 : 0;
}

export interface SkillsDeps {
  /** Upstream access (default: host git). Stubbed in tests. */
  source?: SkillSource;
  /** Today's date for `updatedAt`. */
  today?: () => string;
  /** `update --pr`: worktree deps for prepareContext, and the git/gh runner for delivery. */
  contextDeps?: RunDeps;
  runner?: CommandRunner;
}

type Out = (line: string) => void;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const todayIso = (): string => new Date().toISOString().slice(0, 10);
/** Upstream text goes to a terminal: no escape sequences or other control characters. */
const plain = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');

/** A skill name becomes a path under the skills dir (and is rm -rf'd on replace): one plain segment. */
function assertName(name: string): void {
  if (!NAME_RE.test(name) || name === SKILL_LOCK_FILE) {
    throw new TaskcellError(`Invalid skill name "${plain(name)}": use letters, digits, ".", "_" and "-", starting with a letter or digit.`);
  }
}

/** Write the lock atomically, entries sorted by name. */
async function writeLock(dir: string, entries: Record<string, SkillLockEntry>): Promise<void> {
  const skills = Object.values(entries).sort((a, b) => a.name.localeCompare(b.name));
  await mkdir(dir, { recursive: true });
  const file = join(dir, SKILL_LOCK_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify({ skills }, null, 2)}\n`);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Put `files` in place of skill `name` and record `entry` in the lock, together: the new directory is
 * written beside the old one, swapped in, and the lock written; if the lock write fails the old
 * directory comes back, so the lock never disagrees with the tree (a mismatch fails every load).
 */
async function installSkill(dir: string, lock: Record<string, SkillLockEntry>, entry: SkillLockEntry, files: SkillFiles): Promise<void> {
  const { name } = entry;
  assertName(name);
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  const bak = join(dir, `.${name}.bak-${process.pid}`);
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink() === true) throw new TaskcellError(`${target} is a symlink; refusing to write through it.`);
  await mkdir(dir, { recursive: true });
  try {
    for (const [rel, data] of files) {
      await mkdir(dirname(join(tmp, rel)), { recursive: true });
      await writeFile(join(tmp, rel), data);
    }
    if (existing !== undefined) await rename(target, bak);
    await rename(tmp, target);
    try {
      await writeLock(dir, { ...lock, [name]: entry });
    } catch (cause) {
      await rm(target, { recursive: true, force: true });
      if (existing !== undefined) await rename(bak, target);
      throw cause;
    }
    lock[name] = entry;
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(bak, { recursive: true, force: true });
  }
}

/** Fetch `commit` of `source` and read the skill at `path`; undefined when the path is not there. */
async function fetchSkill(src: SkillSource, source: string, commit: string, path: string): Promise<SkillFiles | undefined> {
  const tree = await src.fetch(source, commit);
  try {
    return await readSkillFiles(tree, path);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}

const sameFiles = (a: SkillFiles, b: SkillFiles): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v) === true);

export interface SkillsAddOptions {
  dir: string;
  source: string;
  ref?: string;
  path?: string;
  name?: string;
}

export async function skillsAdd(opts: SkillsAddOptions, deps: SkillsDeps = {}, out: Out = console.log): Promise<void> {
  const src = deps.source ?? gitSkillSource;
  assertHttpsSource(opts.source);
  const path = assertRepoPath(opts.path ?? '.');
  const repoName = basename(new URL(opts.source).pathname).replace(/\.git$/, '');
  const name = opts.name ?? (path === '.' ? repoName : basename(path));
  assertName(name);
  const lock = (await readSkillLock(opts.dir)) ?? {};
  if (lockEntry(lock, name) !== undefined || (await lstat(join(opts.dir, name)).catch(() => undefined)) !== undefined) {
    throw new TaskcellError(`Skill "${name}" already exists in ${opts.dir}; use skills update or skills remove first.`);
  }
  const commit = await src.resolve(opts.source, opts.ref);
  if (commit === undefined) throw new TaskcellError(`Cannot resolve ${opts.ref ?? 'HEAD'} of ${opts.source}.`);
  const files = await fetchSkill(src, opts.source, commit, path);
  if (files === undefined) throw new TaskcellError(`No directory "${path}" in ${opts.source} @ ${short(commit)}.`);
  const entry = { name, source: opts.source, path, commit, sha256: sha256Hex(files.get('SKILL.md') ?? ''), updatedAt: (deps.today ?? todayIso)() };
  await installSkill(opts.dir, lock, entry, files);
  out(`added ${name}\t${opts.source}\t${short(commit)}\t${files.size} file(s)`);
}

export async function skillsRemove(dir: string, name: string, out: Out = console.log): Promise<void> {
  assertName(name);
  const lock = (await readSkillLock(dir)) ?? {};
  const target = join(dir, name);
  const pinned = lockEntry(lock, name) !== undefined;
  const isSkill = (await lstat(join(target, 'SKILL.md')).catch(() => undefined)) !== undefined;
  const exists = (await lstat(target).catch(() => undefined)) !== undefined;
  // Not a skill (no SKILL.md, no lock entry): leave it alone.
  if (!pinned && !isSkill) throw new TaskcellError(exists ? `${target} is not a skill (no SKILL.md, no lock entry); not removing it.` : `No skill "${name}" in ${dir}.`);
  // rm on a symlink removes the link, never what it points at.
  await rm(target, { recursive: true, force: true });
  if (pinned) {
    delete lock[name];
    await writeLock(dir, lock);
  }
  out(`removed ${name}`);
}

interface SkillUpdate {
  name: string;
  /** What the report line says after the name. */
  detail: string;
  /** The commit the skill was at. */
  from: string;
  /** Set when the skill moves: the new lock entry, files and SKILL.md diff. */
  entry?: SkillLockEntry;
  files?: SkillFiles;
  diff?: LineDiff;
  /** Files other than SKILL.md differ between the pinned and the new commit. */
  otherFilesChanged?: boolean;
}

/** Work out each pinned skill's move to its source's head; writes nothing. One skill's failure never stops the rest. */
async function planSkillUpdates(dir: string, name: string | undefined, deps: SkillsDeps): Promise<SkillUpdate[]> {
  const src = deps.source ?? gitSkillSource;
  const lock = await readSkillLock(dir);
  if (lock === undefined || Object.keys(lock).length === 0) throw new TaskcellError(`No pinned skills: ${join(dir, SKILL_LOCK_FILE)} has no entries.`);
  if (name !== undefined && lockEntry(lock, name) === undefined) throw new TaskcellError(`Skill "${name}" is not pinned in ${join(dir, SKILL_LOCK_FILE)}.`);
  const names = name !== undefined ? [name] : Object.keys(lock).sort((a, b) => a.localeCompare(b));
  const plans: SkillUpdate[] = [];
  for (const n of names) {
    const entry = lockEntry(lock, n);
    if (entry === undefined) continue;
    const base = { name: n, from: entry.commit };
    const keep = (why: string): SkillUpdate => ({ ...base, detail: `${why} → kept ${short(entry.commit)}` });
    if (!NAME_RE.test(n) || n === SKILL_LOCK_FILE) {
      plans.push({ ...base, detail: 'invalid skill name → skipped' });
      continue;
    }
    try {
      const upstream = await src.resolve(entry.source);
      if (upstream === undefined) {
        plans.push(keep('upstream gone'));
        continue;
      }
      if (upstream === entry.commit) {
        plans.push({ ...base, detail: 'current' });
        continue;
      }
      const files = await fetchSkill(src, entry.source, upstream, entry.path);
      if (files === undefined) {
        plans.push(keep('upstream gone'));
        continue;
      }
      // Local edits to any file of the skill are never overwritten: compare the whole directory to the pinned commit.
      const local = await readSkillFiles(dir, n).catch(() => undefined);
      const pinned = local === undefined ? undefined : await fetchSkill(src, entry.source, entry.commit, entry.path).catch(() => undefined);
      if (local === undefined || sha256Hex(local.get('SKILL.md') ?? '') !== entry.sha256) {
        plans.push({ ...base, detail: `${local === undefined ? 'missing' : 'modified'} locally → skipped` });
        continue;
      }
      if (pinned === undefined || !sameFiles(local, pinned)) {
        plans.push({ ...base, detail: `${pinned === undefined ? 'cannot verify local files against the pinned commit' : 'modified locally'} → skipped` });
        continue;
      }
      const skillMd = files.get('SKILL.md') ?? Buffer.alloc(0);
      const diff = await lineDiff((local.get('SKILL.md') ?? Buffer.alloc(0)).toString('utf-8'), skillMd.toString('utf-8'));
      const rest = (f: SkillFiles): SkillFiles => new Map([...f].filter(([k]) => k !== 'SKILL.md'));
      plans.push({
        ...base,
        detail: `${short(entry.commit)} → ${short(upstream)} (+${diff.added} −${diff.removed} lines)`,
        entry: { ...entry, commit: upstream, sha256: sha256Hex(skillMd), updatedAt: (deps.today ?? todayIso)() },
        files,
        diff,
        otherFilesChanged: !sameFiles(rest(local), rest(files)),
      });
    } catch (err) {
      if (!(err instanceof TaskcellError)) throw err;
      console.warn(`taskcell skills: ${plain(n)}: ${plain(err.message)}`);
      plans.push(keep(err instanceof SkillFetchError ? 'upstream gone' : 'upstream refused'));
    }
  }
  return plans;
}

/** Write the planned moves, one skill (directory + lock) at a time. */
async function applySkillUpdates(dir: string, plans: SkillUpdate[]): Promise<void> {
  const lock = (await readSkillLock(dir)) ?? {};
  for (const p of plans) {
    if (p.entry !== undefined && p.files !== undefined) await installSkill(dir, lock, p.entry, p.files);
  }
}

function printPlans(plans: SkillUpdate[], out: Out): void {
  for (const p of plans) out(plain(`${p.name}\t${p.detail}`));
  for (const p of plans) {
    if (p.diff === undefined || p.diff.text === '') continue;
    out(plain(`--- a/${p.name}/SKILL.md\n+++ b/${p.name}/SKILL.md\n${p.diff.text}`));
  }
}

/** A fenced block longer than any backtick run inside it, so a diff cannot close its own fence. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${text}\n${fence}`;
}

/** Same escaping as other untrusted text quoted into a body: no `<` and no live @mentions. */
const untrusted = (text: string): string => neutralizeMentions(neutralizePromptTags(text));

function commitLink(source: string, commit: string): string {
  const href = new URL(source).href.replace(/\/$/, '').replace(/\.git$/, '').replaceAll('(', '%28').replaceAll(')', '%29');
  return `[${short(commit)}](${href}/commit/${commit})`;
}

// GitHub caps a PR body at 65536 characters; each diff gets a share of what is left.
const BODY_BUDGET = 55_000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, text.lastIndexOf('\n', max) > 0 ? text.lastIndexOf('\n', max) : max)}\n… (diff truncated; see the upstream commit)`;
}

/** The PR body: per-skill SKILL.md diff and a link to each upstream commit. */
function skillUpdateBody(plans: SkillUpdate[]): string {
  const share = Math.floor(BODY_BUDGET / Math.max(1, plans.filter((p) => p.diff !== undefined).length));
  const parts = ["Moves pinned skills to the head of their source's default branch. Review each `SKILL.md` diff: a skill steers an agent that has repo access. Text below is untrusted upstream content, escaped (`<` shown as `&lt;`)."];
  for (const p of plans) {
    const head = `### ${untrusted(p.name)}\n\n${untrusted(p.detail)}`;
    if (p.entry === undefined || p.diff === undefined) {
      parts.push(head);
      continue;
    }
    const changed = p.diff.text === '' ? `_\`SKILL.md\` is unchanged${p.otherFilesChanged === true ? '; other files in the skill directory changed' : '; only the pinned commit moves'}._` : fenced(clip(untrusted(p.diff.text), share));
    parts.push([head, `Upstream: ${commitLink(p.entry.source, p.from)} → ${commitLink(p.entry.source, p.entry.commit)}`, changed].join('\n\n'));
  }
  return parts.join('\n\n');
}

/**
 * A sandbox that does nothing: update --pr needs prepareContext's worktree and base resolution and the
 * delivery path, not an agent. deliverChange never touches ctx.sandbox.
 */
const noSandbox = {
  id: 'none',
  start: async (): Promise<void> => {},
  exec: async () => ({ stdout: '/root', stderr: '', exitCode: 0 }),
  copyIn: async (): Promise<void> => {},
  destroy: async (): Promise<void> => {},
} as unknown as IsolatedSandboxProvider;

export interface SkillsUpdateOptions {
  dir: string;
  repo: string;
  name?: string;
  baseBranch?: string;
  dryRun: boolean;
  pr: boolean;
}

/** Update pinned skills in place, print only (--dry-run), or deliver as a PR (--pr). */
export async function skillsUpdate(opts: SkillsUpdateOptions, deps: SkillsDeps = {}, out: Out = console.log): Promise<void> {
  if (opts.dryRun || !opts.pr) {
    const plans = await planSkillUpdates(opts.dir, opts.name, deps);
    printPlans(plans, out);
    if (!opts.dryRun) await applySkillUpdates(opts.dir, plans);
    return;
  }
  const rel = relative(opts.repo, opts.dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new TaskcellError(`--pr needs the skills directory inside the repo (${opts.repo}); ${opts.dir} is not.`);
  const baseBranch = opts.baseBranch ?? (await resolveTargetBase(opts.repo, []));
  // A new branch off the base in a throwaway worktree: nothing is ever pushed to the base itself.
  const ctx: RunContext = await prepareContext(
    { taskId: 'skills-update', localRepoPath: opts.repo, baseBranch, start: 'base', sandbox: noSandbox },
    deps.contextDeps ?? {},
  );
  try {
    const wtDir = join(ctx.worktreePath, rel);
    const plans = await planSkillUpdates(wtDir, opts.name, deps);
    printPlans(plans, out);
    const moved = plans.filter((p) => p.entry !== undefined);
    if (moved.length === 0) return;
    await applySkillUpdates(wtDir, plans);
    const title = `chore(skills): update ${moved.map((p) => p.name).join(', ')}`.slice(0, 100);
    const result = await deliverChange(ctx, {
      taskId: ctx.taskId,
      commitMessage: title,
      target: { kind: 'new-pr', title, body: () => skillUpdateBody(plans), ...(deps.runner !== undefined ? { runner: deps.runner } : {}) },
    });
    if (result.kind === 'secret-blocked') throw new TaskcellError('The update was blocked by the secret scan; nothing was committed or pushed.');
    if (result.kind === 'delivered-pr') out(`opened ${result.prUrl}`);
  } finally {
    await disposeContext(ctx);
  }
}

export async function skillsCommand(cmd: SkillsCommand): Promise<number> {
  try {
    if (cmd.action === 'add') {
      const { action: _a, kind: _k, ...opts } = cmd;
      await skillsAdd(opts);
      return 0;
    }
    if (cmd.action === 'remove') {
      await skillsRemove(cmd.dir, cmd.name);
      return 0;
    }
    if (cmd.action === 'update') {
      await skillsUpdate({ dir: cmd.dir, repo: cmd.repo, dryRun: cmd.dryRun, pr: cmd.pr, ...(cmd.name !== undefined ? { name: cmd.name } : {}), ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}) });
      return 0;
    }
    if (cmd.action === 'check') return await skillsCheck(cmd.dir, cmd.strict);
    await skillsList(cmd.dir);
    return 0;
  } catch (error) {
    // A bad lock or directory is a user error: one line, no stack.
    if (!(error instanceof TaskcellError)) throw error;
    console.error(`taskcell skills: ${error.message}`);
    return 1;
  }
}
