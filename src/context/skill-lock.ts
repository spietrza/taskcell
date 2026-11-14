import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TaskcellError } from '../core/errors.js';

export const SKILL_LOCK_FILE = 'skills.lock.json';

const SkillLockEntry = z.object({
  name: z.string().min(1),
  /** https git URL of the skill's upstream repo. */
  source: z.url({ protocol: /^https$/ }),
  /** Path of the skill inside the source repo. */
  path: z.string().min(1),
  /** A full commit sha; never a tag or branch, which can move. */
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-hex commit sha'),
  /** sha256 of the skill's SKILL.md. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-hex sha256'),
  updatedAt: z.string().min(1),
});

const SkillLock = z.object({ skills: z.array(SkillLockEntry) });

export type SkillLockEntry = z.infer<typeof SkillLockEntry>;

/** Parse and validate lock file text into entries keyed by skill name. */
export function parseSkillLock(text: string, label = SKILL_LOCK_FILE): Record<string, SkillLockEntry> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TaskcellError(`${label} is not valid JSON.`);
  }
  const parsed = SkillLock.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TaskcellError(`${label} is invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  const entries: Record<string, SkillLockEntry> = {};
  for (const entry of parsed.data.skills) {
    if (Object.hasOwn(entries, entry.name)) throw new TaskcellError(`${label} lists skill "${entry.name}" twice.`);
    entries[entry.name] = entry;
  }
  return entries;
}

/** The lock next to a skills directory; undefined when there is none. */
export async function readSkillLock(dir: string): Promise<Record<string, SkillLockEntry> | undefined> {
  const file = join(dir, SKILL_LOCK_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseSkillLock(text, file);
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** sha256 of a skill directory's SKILL.md. */
export async function skillSha256(skillDir: string): Promise<string> {
  return sha256Hex(await readFile(join(skillDir, 'SKILL.md')));
}

export type SkillStatus = 'pinned' | 'local' | 'modified';

/** Status of one skill against its lock entry (none = local). */
export async function skillStatus(skillDir: string, entry: SkillLockEntry | undefined): Promise<SkillStatus> {
  if (entry === undefined) return 'local';
  return (await skillSha256(skillDir)) === entry.sha256 ? 'pinned' : 'modified';
}

/** A skill's lock entry; own-property lookup so names like `constructor` never match. */
export function lockEntry(lock: Record<string, SkillLockEntry> | undefined, name: string): SkillLockEntry | undefined {
  return lock !== undefined && Object.hasOwn(lock, name) ? lock[name] : undefined;
}

const warnedLocal = new Set<string>();

/** Fail on a hash mismatch; warn once per skill dir for a skill with no lock entry. */
export async function verifySkill(skillDir: string, name: string, lock: Record<string, SkillLockEntry> | undefined): Promise<void> {
  const entry = lockEntry(lock, name);
  if (entry === undefined) {
    if (lock === undefined) return; // no lock file: loads as before, silently
    if (!warnedLocal.has(skillDir)) {
      warnedLocal.add(skillDir);
      console.warn(`taskcell: skill ${name} is local (no entry in ${SKILL_LOCK_FILE}); its content is not pinned`);
    }
    return;
  }
  if ((await skillStatus(skillDir, entry)) === 'modified') {
    throw new TaskcellError(
      `Skill "${name}" (${skillDir}) does not match ${SKILL_LOCK_FILE}: SKILL.md differs from the pinned sha256 of ${entry.source} @ ${entry.commit.slice(0, 7)}. ` +
        `Restore the pinned content, or update the lock entry if the change is intended.`,
    );
  }
}
