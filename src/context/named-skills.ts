import { agentFamily } from '../agents/provider.js';
import { TaskcellError } from '../core/errors.js';

/** A skill id is a directory name; this is the shape a `Skills:` line or `--skill` value may take. */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The skills a task names by hand: its `Skills: a, b` line (the last one wins when repeated, like
 * the other body-line fields). Names split on commas and whitespace; duplicates collapse.
 */
export function parseSkillsLine(body: string): string[] {
  const lines = [...body.matchAll(/^[ \t]*Skills[ \t]*:[ \t]*(.*)$/gim)];
  const raw = lines.at(-1)?.[1] ?? '';
  return normalizeSkillNames(raw.split(/[\s,]+/));
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

/** The prompt text that makes the agent use the named skills; empty when none are named. */
export function namedSkillsPrompt(named: readonly string[]): string {
  return named.length === 0 ? '' : `The task names these skills; you MUST load and follow each of them (in addition to any others that apply): ${named.join(', ')}.`;
}

/** Whether the provider's CLI reads skills from the sandbox (the pi stub never runs, so it does not). */
export function providerSupportsSkills(agentName: string | undefined): boolean {
  return agentFamily(agentName) !== 'pi';
}
