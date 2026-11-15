import { agentFamily } from '../agents/provider.js';
import { TaskcellError } from '../core/errors.js';

/** A skill id is a directory name; this is the shape a `Skills:` line or `--skill` value may take. */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The most skills one task may name by hand (`Skills:` line, `--skill`, the hub). */
export const MAX_NAMED_SKILLS = 20;

const SKILLS_LINE = 'Skills:';

/** What an issue body's `Skills:` line that is not a list of skill ids leaves in the run summary. Names nothing from the body. */
export const SKILLS_LINE_IGNORED = `The issue's "Skills:" line is not a comma-separated list of at most ${MAX_NAMED_SKILLS} skill ids (e.g. "Skills: db-migrations, release"); it was ignored.`;

/** Index of the last line starting with `Skills:` outside code fences, or -1. A `>` quote or an indented line never starts with it. */
function skillsLineIndex(lines: readonly string[]): number {
  let fence: string | undefined;
  let found = -1;
  lines.forEach((line, i) => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (mark !== undefined) {
      if (fence === undefined) fence = mark;
      else if (fence === mark) fence = undefined;
    } else if (fence === undefined && line.startsWith(SKILLS_LINE)) found = i;
  });
  return found;
}

/**
 * The skills a task names by hand: its `Skills: a, b` line (the last one wins when repeated, like
 * the other body-line fields). Only a line that starts with `Skills:`, outside code fences and
 * quotes, whose every comma-separated item is a skill id counts; anything else (prose such as
 * `Skills: good communication`) selects nothing and comes back as a `note`, never a refusal.
 */
export function parseSkillsLine(body: string): { skills: string[]; note?: string } {
  const lines = body.split('\n');
  const raw = lines[skillsLineIndex(lines)]?.slice(SKILLS_LINE.length);
  if (raw === undefined) return { skills: [] };
  const skills = normalizeSkillNames(raw.split(','));
  if (skills.length > MAX_NAMED_SKILLS || !skills.every(isSkillId)) return { skills: [], note: SKILLS_LINE_IGNORED };
  return { skills };
}

/**
 * `body` with its `Skills:` line set to `skills` (what the hub card writes back to the tracker): the
 * line parseSkillsLine reads is replaced, a new one is appended when there is none (or only prose),
 * and an empty list removes it. Nothing else in the body changes.
 */
export function setSkillsLine(body: string, skills: readonly string[]): string {
  const lines = body.split('\n');
  if (skills.length === 0) {
    while (parseSkillsLine(lines.join('\n')).skills.length > 0) lines.splice(skillsLineIndex(lines), 1);
    return lines.join('\n');
  }
  const line = `${SKILLS_LINE} ${skills.join(', ')}`;
  if (parseSkillsLine(body).skills.length === 0) return `${body.trimEnd()}${body.trim() === '' ? '' : '\n\n'}${line}\n`;
  const i = skillsLineIndex(lines);
  lines[i] = `${line}${lines[i]?.endsWith('\r') === true ? '\r' : ''}`;
  return lines.join('\n');
}

/** Trim, drop blanks and duplicates, keep order. */
export function normalizeSkillNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
}

/** Whether `name` can be a skill id at all (the CLI and hub reject anything else up front). */
export const isSkillId = (name: string): boolean => SKILL_ID_RE.test(name);

/**
 * Check every named skill is installed. Throws before any sandbox or model call, listing the
 * installed ids, so a typo is never a silent skip.
 */
export function assertSkillsInstalled(named: readonly string[], installed: readonly string[]): void {
  const missing = named.filter((n) => !installed.includes(n));
  if (missing.length === 0) return;
  const list = installed.length > 0 ? [...installed].sort().join(', ') : '(none)';
  throw new TaskcellError(`Unknown skill${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Installed skills: ${list}.`);
}

/** A hand-picked list from the CLI or the hub: every item a skill id, at most MAX_NAMED_SKILLS. Undefined when fine, else what is wrong. */
export function namedSkillsProblem(names: readonly string[]): string | undefined {
  const bad = names.find((n) => !isSkillId(n));
  if (bad !== undefined) return `expects a skill id (a directory name under the skills dir), got ${JSON.stringify(bad.slice(0, 80))}`;
  return names.length > MAX_NAMED_SKILLS ? `takes at most ${MAX_NAMED_SKILLS} skills, got ${names.length}` : undefined;
}

/** The prompt text that makes the agent use the named skills; empty when none are named. */
export function namedSkillsPrompt(named: readonly string[]): string {
  return named.length === 0 ? '' : `The task names these skills; you MUST load and follow each of them (in addition to any others that apply): ${named.join(', ')}.`;
}

/**
 * `stages` with the named-skills instruction appended to the implementer's prompt (the first stage
 * when a flow has no implementer), so it reaches the agent in every flow, whatever its template holds.
 */
export function withNamedSkills<T extends { name: string; promptTemplate: string }>(stages: readonly T[], named: readonly string[]): T[] {
  if (named.length === 0) return [...stages];
  const target = stages.find((s) => s.name === 'implementer') ?? stages[0];
  return stages.map((s) => (s === target ? { ...s, promptTemplate: `${s.promptTemplate}\n\n${namedSkillsPrompt(named)}` } : s));
}

/** Whether the provider's CLI reads skills from the sandbox (the pi stub never runs, so it does not). */
export function providerSupportsSkills(agentName: string | undefined): boolean {
  return agentFamily(agentName) !== 'pi';
}
