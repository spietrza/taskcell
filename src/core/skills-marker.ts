import { parseMarkers, writeMarker } from './comment-ledger.js';

/** A skill's directory name: what `skills add` accepts and what a hidden PR-body marker may carry. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The machine-readable list of skills a skill-add PR carries in its body (the title is cut at 100 characters). */
export const skillsMarker = (names: readonly string[]): string => `\n\n${writeMarker('skills', names)}`;

/** The names in a PR body's marker; undefined without one. A PR body is untrusted: only valid names survive. */
export function parseSkillsMarker(body: string): string[] | undefined {
  return parseMarkers<string[]>('skills', body)[0]?.filter((n) => SKILL_NAME_RE.test(n));
}
