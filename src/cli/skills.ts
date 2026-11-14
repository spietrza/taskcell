import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { lockEntry, readSkillLock, skillStatus, type SkillStatus } from '../context/skill-lock.js';
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
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => {
    throw new TaskcellError(`Cannot read skills directory ${dir}.`);
  });
  const rows: SkillRow[] = [];
  for (const d of dirents.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillDir = join(dir, d.name);
    const entry = lockEntry(lock, d.name);
    const status = await skillStatus(skillDir, entry).catch(() => undefined);
    if (status === undefined) continue; // no SKILL.md: not a skill
    rows.push({ name: d.name, source: entry?.source ?? '-', commit: entry?.commit ?? '', status });
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
  if (cmd.action === 'list') {
    await skillsList(cmd.dir);
    return 0;
  }
  return skillsCheck(cmd.dir, cmd.strict);
}
