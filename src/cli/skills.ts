import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lockEntry, readSkillLock, skillStatus, type SkillStatus } from '../context/skill-lock.js';
import { skillDirsIn } from '../context/skill-registry.js';
import { TaskcellError } from '../core/errors.js';
import type { Command } from './args.js';

export type SkillsCommand = Extract<Command, { kind: 'skills' }>;

/** Resolves a git source URL to its default branch head sha; undefined when it cannot. */
export type GitResolver = (source: string) => Promise<string | undefined>;

const execFileP = promisify(execFile);

/** Host-only: `git ls-remote <url> HEAD` (the default branch head). */
export const gitLsRemoteHead: GitResolver = async (source) => {
  try {
    const { stdout } = await execFileP('git', ['ls-remote', source, 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
    });
    const sha = stdout.split(/\s/)[0];
    return sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
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

export async function skillsCommand(cmd: SkillsCommand): Promise<number> {
  try {
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
