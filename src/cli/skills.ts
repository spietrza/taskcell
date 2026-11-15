import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { neutralizeMentions, neutralizePromptTags } from '../context/escape.js';
import { lockEntry, readSkillLock, SKILL_LOCK_FILE, sha256Hex, skillStatus, type SkillLockEntry, type SkillStatus } from '../context/skill-lock.js';
import { skillDirsIn } from '../context/skill-registry.js';
import { assertHttpsSource, assertRepoPath, gitSkillSource, lineDiff, readSkillFiles, SkillFetchError, type LineDiff, type SkillFile, type SkillFiles, type SkillSource } from '../context/skill-source.js';
import { resolveTargetBase } from '../core/base-branch.js';
import { TaskcellError } from '../core/errors.js';
import { disposeContext, prepareContext, type RunContext, type RunDeps } from '../core/taskcell.js';
import type { CommandRunner } from '../pipeline/remote-branch.js';
import { deliverChange } from '../runners/deliver-change.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import { hostGitArgs } from '../worktree/host-git.js';
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
/**
 * Upstream text goes to a terminal: no escape sequences or other control characters, and no bidi
 * controls or line separators that would reorder or split what is shown. Newlines stay (diffs).
 */
const plain = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '?');
/** plain, on one line: a name or a message cannot start a report line of its own. */
const oneLine = (text: string): string => plain(text).replaceAll('\n', '?');

const isName = (name: string): boolean => NAME_RE.test(name) && name !== SKILL_LOCK_FILE;

/** A skill name becomes a path under the skills dir (and is rm -rf'd on replace): one plain segment. */
function assertName(name: string): void {
  if (!isName(name)) {
    throw new TaskcellError(`Invalid skill name "${oneLine(name)}": use letters, digits, ".", "_" and "-", starting with a letter or digit.`);
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
 * Put `files` in place of skill `name` and record `entry` in the lock. The new content is staged in a
 * directory beside the skill, the installed one is moved into that staging directory and the new one
 * renamed in; if the swap or the lock write fails the installed one is renamed back, so a failure never
 * costs the user the skill they had. The staging directory has no SKILL.md of its own, so one left
 * behind by a kill never loads as a skill. The swap and the lock write are two steps: a kill between
 * them leaves the new directory with the old lock entry, which `skills list` shows as `modified`.
 */
async function installSkill(dir: string, lock: Record<string, SkillLockEntry>, entry: SkillLockEntry, files: SkillFiles): Promise<void> {
  const { name } = entry;
  assertName(name);
  const target = join(dir, name);
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink() === true) throw new TaskcellError(`${target} is a symlink; refusing to write through it.`);
  await mkdir(dir, { recursive: true });
  const stage = await mkdtemp(join(dir, `.${name}.tmp-`));
  const fresh = join(stage, 'new');
  const old = join(stage, 'old');
  let keepStage = false;
  try {
    for (const [rel, file] of files) {
      await mkdir(dirname(join(fresh, rel)), { recursive: true });
      await writeFile(join(fresh, rel), file.data, { mode: file.exec ? 0o755 : 0o644 });
    }
    if (existing !== undefined) await rename(target, old);
    try {
      await rename(fresh, target);
      await writeLock(dir, { ...lock, [name]: entry });
    } catch (cause) {
      if (existing !== undefined) {
        try {
          await rm(target, { recursive: true, force: true });
          await rename(old, target);
        } catch {
          // The staging directory now holds the only copy: keep it and say where it is.
          keepStage = true;
          throw new TaskcellError(`Could not install ${name}, and could not put the previous version back: it is in ${old}.`, { cause });
        }
      } else await rm(target, { recursive: true, force: true });
      throw cause;
    }
    lock[name] = entry;
  } finally {
    if (!keepStage) await rm(stage, { recursive: true, force: true });
  }
}

/** Fetch `commit` of `source` and read the skill at `path`; undefined when the path is not there. */
async function fetchSkill(src: SkillSource, source: string, commit: string, path: string): Promise<SkillFiles | undefined> {
  return readSkillFiles(await src.fetch(source, commit, path), path);
}

const sameFile = (a: SkillFile | undefined, b: SkillFile | undefined): boolean => a !== undefined && b !== undefined && a.exec === b.exec && a.data.equals(b.data);
const sameFiles = (a: SkillFiles, b: SkillFiles): boolean => a.size === b.size && [...a].every(([k, v]) => sameFile(v, b.get(k)));

/** The files other than SKILL.md that differ between two versions of a skill, as `A|M|D <name>`. */
function changedFiles(before: SkillFiles, after: SkillFiles): string[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].filter((k) => k !== 'SKILL.md').sort();
  return names.flatMap((k) => (!before.has(k) ? [`A ${k}`] : !after.has(k) ? [`D ${k}`] : sameFile(before.get(k), after.get(k)) ? [] : [`M ${k}`]));
}

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
  try {
    const commit = await src.resolve(opts.source, opts.ref);
    if (commit === undefined) throw new TaskcellError(`Cannot resolve ${opts.ref ?? 'HEAD'} of ${opts.source}.`);
    const files = await fetchSkill(src, opts.source, commit, path);
    if (files === undefined) throw new TaskcellError(`No directory "${path}" in ${opts.source} @ ${short(commit)}.`);
    const entry = { name, source: opts.source, path, commit, sha256: sha256Hex(files.get('SKILL.md')?.data ?? ''), updatedAt: (deps.today ?? todayIso)() };
    await installSkill(opts.dir, lock, entry, files);
    out(oneLine(`added ${name}\t${opts.source}\t${short(commit)}\t${files.size} file(s)`));
  } finally {
    await src.dispose?.();
  }
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
  out(oneLine(`removed ${name}`));
}

export interface SkillUpdate {
  name: string;
  /** What the report line says after the name. */
  detail: string;
  /** The commit the skill was at. */
  from: string;
  /** Set when the skill moves: the new lock entry, files and SKILL.md diff. */
  entry?: SkillLockEntry;
  files?: SkillFiles;
  diff?: LineDiff;
  /** The files other than SKILL.md that differ between the installed and the new version (`A|M|D <name>`). */
  changed?: string[];
}

/** Work out each pinned skill's move to its source's head; writes nothing. One skill's failure never stops the rest. */
async function planSkillUpdates(dir: string, name: string | undefined, deps: SkillsDeps, force = false): Promise<SkillUpdate[]> {
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
    if (!isName(n)) {
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
      if (local === undefined || sha256Hex(local.get('SKILL.md')?.data ?? '') !== entry.sha256) {
        plans.push({ ...base, detail: `${local === undefined ? 'missing' : 'modified'} locally → skipped` });
        continue;
      }
      let pinned: SkillFiles | undefined;
      let whyNoPinned = `${entry.path} is not in pinned commit ${short(entry.commit)}`;
      try {
        pinned = await fetchSkill(src, entry.source, entry.commit, entry.path);
      } catch (err) {
        if (!(err instanceof TaskcellError)) throw err;
        console.warn(`taskcell skills: ${oneLine(n)}: ${oneLine(err.message)}`);
        whyNoPinned = err instanceof SkillFetchError ? `pinned commit ${short(entry.commit)} can no longer be fetched` : `pinned commit ${short(entry.commit)} was refused (see stderr)`;
      }
      // A server can stop serving a commit (force-push, gc, no fetch by sha). --force is the way out:
      // SKILL.md still matched the lock's hash above, only the other files go unchecked.
      if (pinned === undefined && !force) {
        plans.push({ ...base, detail: `${whyNoPinned}, so local files cannot be checked against it → skipped (--force replaces them unchecked)` });
        continue;
      }
      if (pinned !== undefined && !sameFiles(local, pinned)) {
        plans.push({ ...base, detail: 'modified locally → skipped' });
        continue;
      }
      const skillMd = files.get('SKILL.md')?.data ?? Buffer.alloc(0);
      const diff = await lineDiff((local.get('SKILL.md')?.data ?? Buffer.alloc(0)).toString('utf-8'), skillMd.toString('utf-8'));
      plans.push({
        ...base,
        detail: `${short(entry.commit)} → ${short(upstream)} (+${diff.added} −${diff.removed} lines)${pinned === undefined ? ', local files not checked against the pinned commit' : ''}`,
        entry: { ...entry, commit: upstream, sha256: sha256Hex(skillMd), updatedAt: (deps.today ?? todayIso)() },
        files,
        diff,
        changed: changedFiles(local, files),
      });
    } catch (err) {
      if (!(err instanceof TaskcellError)) throw err;
      console.warn(`taskcell skills: ${oneLine(n)}: ${oneLine(err.message)}`);
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
  for (const p of plans) out(oneLine(`${p.name}\t${p.detail}`));
  for (const p of plans) {
    if (p.changed !== undefined && p.changed.length > 0) out([`${p.name}: files changed besides SKILL.md:`, ...p.changed.map((f) => `  ${f}`)].map(oneLine).join('\n'));
    if (p.diff === undefined || p.diff.text === '') continue;
    out(plain(`--- a/${p.name}/SKILL.md\n+++ b/${p.name}/SKILL.md\n${p.diff.text}`));
  }
}

/** A fenced block longer than any backtick run inside it, so its content cannot close its own fence. */
function fenced(text: string, lang = 'diff'): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Same escaping as other untrusted text quoted into a body: no `<` and no live @mentions. */
const untrusted = (text: string): string => neutralizeMentions(neutralizePromptTags(text));
/** A name from the lock as a code span on one line: it cannot open a heading, a link or a block of its own. */
const code = (text: string): string => `\`${untrusted(oneLine(text)).replaceAll('`', "'").slice(0, 120)}\``;

/** A link to the commit where the host's URL layout is known (GitHub, GitLab); elsewhere the short sha alone. */
export function commitLink(source: string, commit: string): string {
  const url = new URL(source);
  const layout = url.hostname === 'github.com' ? '/commit/' : url.hostname === 'gitlab.com' || url.hostname.startsWith('gitlab.') ? '/-/commit/' : undefined;
  if (layout === undefined) return `\`${short(commit)}\``;
  // Origin and path only: a query or fragment in the source is not part of the repo's page.
  const repo = `${url.origin}${url.pathname}`.replace(/\/$/, '').replace(/\.git$/, '').replaceAll('(', '%28').replaceAll(')', '%29');
  return `[${short(commit)}](${repo}${layout}${commit})`;
}

// GitHub refuses a PR body over 65536 characters, and by then the branch is pushed: the whole body
// (intro, every section, the list of skills that did not move) is kept under this.
const BODY_LIMIT = 60_000;
const NOT_MOVED_BUDGET = 8_000;
const FULL_REPORT = 'run `taskcell skills update --dry-run` for the full report';

function clip(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, Math.max(0, cut))}\n… (${what} truncated to fit the PR body; ${FULL_REPORT})`;
}

/** One moved skill within `share` characters: the upstream commits, the other changed files, the SKILL.md diff. */
function movedSection(p: SkillUpdate & { entry: SkillLockEntry; diff: LineDiff }, share: number): string {
  const blocks = [`### ${code(p.name)}\n\n${untrusted(oneLine(p.detail))}`, `Upstream: ${commitLink(p.entry.source, p.from)} → ${commitLink(p.entry.source, p.entry.commit)}`];
  // What is left after the heading, less the fences, labels and truncation notes below.
  let room = Math.max(0, share - blocks.join('\n\n').length - 500);
  const changed = p.changed ?? [];
  if (changed.length > 0) {
    const list = clip(untrusted(changed.map(oneLine).join('\n')), Math.floor(room / 4), 'file list');
    room = Math.max(0, room - list.length);
    blocks.push(`Files changed besides \`SKILL.md\` (A added, M modified, D deleted; not shown as a diff):\n\n${fenced(list, 'text')}`);
  }
  blocks.push(p.diff.text === '' ? `_\`SKILL.md\` is unchanged${changed.length > 0 ? '' : '; only the pinned commit moves'}._` : fenced(clip(untrusted(p.diff.text), room, 'diff')));
  return blocks.join('\n\n');
}

/** The PR body: per moved skill the SKILL.md diff, the other changed files and a link to each upstream commit. */
export function skillUpdateBody(plans: SkillUpdate[]): string {
  const intro = "Moves pinned skills to the head of their source's default branch. Review each `SKILL.md` diff and the list of other changed files: a skill steers an agent that has repo access. Text below is untrusted upstream content, escaped (`<` shown as `&lt;`).";
  const moved = plans.flatMap((p) => (p.entry !== undefined && p.diff !== undefined ? [{ ...p, entry: p.entry, diff: p.diff }] : []));
  const rest = plans.filter((p) => p.entry === undefined || p.diff === undefined);
  const lines: string[] = [];
  let used = 0;
  for (const [i, p] of rest.entries()) {
    const line = `- ${code(p.name)}: ${untrusted(oneLine(p.detail)).slice(0, 300)}`;
    if (used + line.length > NOT_MOVED_BUDGET) {
      lines.push(`- … and ${rest.length - i} more (list truncated; ${FULL_REPORT})`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const notMoved = lines.length > 0 ? `### Not moved\n\n${lines.join('\n')}` : '';
  const share = Math.floor((BODY_LIMIT - intro.length - notMoved.length) / Math.max(1, moved.length));
  const body = [intro, ...moved.map((p) => movedSection(p, share)), notMoved].filter((part) => part !== '').join('\n\n');
  // Last resort (hundreds of moved skills, or a source URL of absurd length): never over the limit.
  return body.length <= BODY_LIMIT ? body : `${body.slice(0, BODY_LIMIT)}\n\n… (truncated to fit the PR body; ${FULL_REPORT})`;
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
  /** Update a skill whose pinned commit can no longer be fetched, without checking its other files against it. */
  force?: boolean;
}

/**
 * Update pinned skills in place, print only (--dry-run), or deliver as a PR (--pr). With both --pr and
 * --dry-run the plan is made against the base branch, as the PR would be, and nothing is committed,
 * pushed or opened.
 */
export async function skillsUpdate(opts: SkillsUpdateOptions, deps: SkillsDeps = {}, out: Out = console.log): Promise<void> {
  try {
    if (opts.pr) return await skillsUpdatePr(opts, deps, out);
    const plans = await planSkillUpdates(opts.dir, opts.name, deps, opts.force);
    printPlans(plans, out);
    if (!opts.dryRun) await applySkillUpdates(opts.dir, plans);
  } finally {
    await (deps.source ?? gitSkillSource).dispose?.();
  }
}

async function skillsUpdatePr(opts: SkillsUpdateOptions, deps: SkillsDeps, out: Out): Promise<void> {
  const rel = relative(opts.repo, resolve(opts.repo, opts.dir));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new TaskcellError(`--pr needs the skills directory inside the repo (${opts.repo}); ${opts.dir} is not.`);
  const baseBranch = opts.baseBranch ?? (await resolveTargetBase(opts.repo, []));
  // A new branch off the base in a throwaway worktree: nothing is ever pushed to the base itself.
  const ctx: RunContext = await prepareContext(
    { taskId: 'skills-update', localRepoPath: opts.repo, baseBranch, start: 'base', sandbox: noSandbox },
    deps.contextDeps ?? {},
  );
  try {
    const wtDir = join(ctx.worktreePath, rel);
    // The base branch can commit a symlink at the skills path: nothing may be read or written outside the worktree.
    const [wtReal, dirReal] = await Promise.all([realpath(ctx.worktreePath), realpath(wtDir).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? undefined : Promise.reject(err)))]);
    if (dirReal !== undefined && dirReal !== wtReal && !dirReal.startsWith(`${wtReal}${sep}`)) {
      throw new TaskcellError(`${rel} on ${baseBranch} resolves outside the repo (${dirReal}); --pr will not write through it.`);
    }
    // Before anything is written or pushed: every name in the lock ends up in the PR body.
    const invalid = Object.keys((await readSkillLock(wtDir)) ?? {}).filter((n) => !isName(n));
    if (invalid.length > 0) {
      throw new TaskcellError(`${SKILL_LOCK_FILE} on ${baseBranch} has ${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} whose name is not a plain directory name ("${oneLine(invalid[0] ?? '').slice(0, 80)}"); fix the lock before update --pr.`);
    }
    const plans = await planSkillUpdates(wtDir, opts.name, deps, opts.force);
    printPlans(plans, out);
    const moved = plans.filter((p) => p.entry !== undefined);
    if (moved.length === 0 || opts.dryRun) return;
    await applySkillUpdates(wtDir, plans);
    // commitStage's `add -A` honours .gitignore files (the repo's, the operator's, the skill's own): force-add
    // every moved skill so the commit holds exactly the installed files.
    // The pathspec is the real path (git refuses one beyond a symlink) and literal (no pathspec magic).
    const realRel = relative(wtReal, dirReal ?? wtDir);
    for (const p of moved) await execFileP('git', hostGitArgs(['--literal-pathspecs', 'add', '-f', '-A', '--', join(realRel, p.name)]), { cwd: ctx.worktreePath });
    const title = `chore(skills): update ${moved.map((p) => p.name).join(', ')}`.slice(0, 100);
    const result = await deliverChange(ctx, {
      taskId: ctx.taskId,
      commitMessage: title,
      target: { kind: 'new-pr', title, body: () => skillUpdateBody(plans), ...(deps.runner !== undefined ? { runner: deps.runner } : {}) },
    });
    if (result.kind === 'secret-blocked') throw new TaskcellError('The update was blocked by the secret scan; nothing was committed or pushed.');
    if (result.kind === 'delivered-pr') out(`opened ${result.prUrl}`);
  } finally {
    // Both are throwaway, delivered or not: a run that moved nothing, failed or was blocked by the
    // secret scan must not leave a branch, or a worktree still holding the flagged content.
    await ctx.wm.remove(ctx.worktreePath, true).catch((error: unknown) => ctx.log.warn({ error }, 'failed to remove the skills-update worktree'));
    await disposeContext(ctx);
    await execFileP('git', hostGitArgs(['branch', '-D', ctx.branch]), { cwd: opts.repo }).catch((error: unknown) => ctx.log.warn({ error }, 'failed to delete the skills-update branch'));
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
      await skillsUpdate({ dir: cmd.dir, repo: cmd.repo, dryRun: cmd.dryRun, pr: cmd.pr, force: cmd.force, ...(cmd.name !== undefined ? { name: cmd.name } : {}), ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}) });
      return 0;
    }
    if (cmd.action === 'check') return await skillsCheck(cmd.dir, cmd.strict);
    await skillsList(cmd.dir);
    return 0;
  } catch (error) {
    // A bad lock or directory is a user error: one line, no stack.
    if (!(error instanceof TaskcellError)) throw error;
    // The message can quote upstream text (a file name, git's stderr).
    console.error(`taskcell skills: ${oneLine(error.message)}`);
    return 1;
  }
}
