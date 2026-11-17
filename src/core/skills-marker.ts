/** A skill's directory name: what `skills add` accepts and what a hidden PR-body marker may carry. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MARKER_RE = /<!-- taskcell-skills: ([^>]*?) -->/;

/** The machine-readable list of skills a skill-add PR carries in its body (the title is cut at 100 characters). */
export const skillsMarker = (names: readonly string[]): string => `\n\n<!-- taskcell-skills: ${names.join(',')} -->`;

/** The names in a PR body's marker; undefined without one. A PR body is untrusted: only valid names survive. */
export function parseSkillsMarker(body: string): string[] | undefined {
  const m = MARKER_RE.exec(body);
  return m?.[1]?.split(',').map((n) => n.trim()).filter((n) => SKILL_NAME_RE.test(n));
}
