/**
 * Label/marker naming: the factory writes `taskcell:*` / `taskcell::*` labels and `taskcell-*` comment markers
 * and keeps reading the pre-rename `vanguard` forms (removed in a later major release).
 */
const CURRENT = 'taskcell';
const LEGACY = 'vanguard';
const LEGACY_REVIEW_TRIGGER = 'ready for vanguard review';

/**
 * The PR-review trigger as the factory WRITES it: still the pre-rename name. GitHub starts a workflow on the
 * label's name, and the shipped caller workflows listen for this one only, so it is neither written under the new
 * name nor migrated until they accept both. Reading accepts both spellings like every other label.
 */
export const REVIEW_TRIGGER_LABEL = LEGACY_REVIEW_TRIGGER;

/** The pre-rename spelling of a `taskcell…` label, or the label itself when it has none. */
export function legacyLabel(label: string): string {
  if (label === 'ready for taskcell review') return LEGACY_REVIEW_TRIGGER;
  return label.startsWith(`${CURRENT}:`) ? LEGACY + label.slice(CURRENT.length) : label;
}

/** The current spelling of a (possibly legacy) label. */
export function currentLabel(label: string): string {
  if (label === LEGACY_REVIEW_TRIGGER) return 'ready for taskcell review';
  return label.startsWith(`${LEGACY}:`) ? CURRENT + label.slice(LEGACY.length) : label;
}

/** Both spellings of a label (one element when it has no legacy form). */
export function labelForms(label: string): string[] {
  const current = currentLabel(label);
  const legacy = legacyLabel(current);
  return legacy === current ? [current] : [current, legacy];
}

/** True when two label names are the same label, whichever spelling each uses. */
export function sameLabel(a: string, b: string): boolean {
  return currentLabel(a) === currentLabel(b);
}

/** True when `labels` carries `name` in either spelling. */
export function hasLabel(labels: ReadonlyArray<string>, name: string): boolean {
  return labels.some((l) => sameLabel(l, name));
}

/** `labels` without `name` in either spelling. */
export function withoutLabel(labels: ReadonlyArray<string>, name: string): string[] {
  return labels.filter((l) => !sameLabel(l, name));
}

/** The value after `prefix` (e.g. `taskcell:model=`) on a label in either spelling, else undefined. */
export function labelValue(label: string, prefix: string): string | undefined {
  const current = currentLabel(label);
  return current.startsWith(currentLabel(prefix)) ? current.slice(currentLabel(prefix).length) : undefined;
}

/** `taskcell-x` → both marker names, for building comment-marker regexes: `(?:taskcell|vanguard)-x`. */
export const MARKER_PREFIX_RE = '(?:taskcell|vanguard)';

/**
 * What to pass to `--remove-label` for `remove`: a label with a legacy twin is removed under whichever spelling
 * the item actually carries (`present`, fetched lazily — only when needed; GitHub label names are
 * case-insensitive). A blind remove of a label the repo never created makes `gh ... edit` fail, so a label the
 * item lacks is dropped (a no-op) — the result can be empty, and the caller must then skip the edit. Falls back
 * to the names as given when `present` fails. `onSkip` hears each twin-bearing label dropped because the item
 * does not show it, so an in-flight label that stays on can be diagnosed.
 */
export async function resolveRemovals(
  remove: ReadonlyArray<string>,
  present: () => Promise<ReadonlyArray<string>>,
  onSkip?: (label: string) => void,
): Promise<string[]> {
  if (!remove.some((l) => labelForms(l).length > 1)) return [...remove];
  let have: ReadonlyArray<string>;
  try {
    have = await present();
  } catch {
    return [...remove];
  }
  return [...new Set(remove.flatMap((l) => {
    const forms = labelForms(l).map((form) => form.toLowerCase());
    // A label without a twin passes through unchecked; one with a twin is removed as the item spells it.
    if (forms.length < 2) return [l];
    const held = have.filter((name) => forms.includes(name.toLowerCase()));
    if (held.length === 0) onSkip?.(l);
    return held;
  }))];
}

/**
 * What to pass to `--add-label` for `add`: `gh ... --add-label` fails on a label the repo never created, and a
 * repo set up before the rename has only the `vanguard` spellings. A label with a legacy twin is added under the
 * spelling the repo has (the current one when it has both; the legacy one for the review trigger, see
 * REVIEW_TRIGGER_LABEL); when it has neither, that preferred spelling is created first. The repo's labels are
 * listed lazily (only when a label has a twin); names compare case-insensitively and the repo's own spelling is
 * returned. When they cannot be listed, the names are returned as given, each twin-bearing one first force-created
 * (best effort), since the add fails on a label the repo lacks.
 */
export async function resolveAdds(add: ReadonlyArray<string>, repoSlug: string, gh: (args: string[]) => Promise<string>): Promise<string[]> {
  if (!add.some((l) => labelForms(l).length > 1)) return [...add];
  let have: ReadonlyArray<string>;
  try {
    have = (JSON.parse(await gh(['label', 'list', '--repo', repoSlug, '--limit', '1000', '--json', 'name'])) as { name: string }[]).map((l) => l.name);
  } catch {
    for (const label of add) if (labelForms(label).length > 1) await gh(['label', 'create', label, '--repo', repoSlug, '--force']).catch(() => undefined);
    return [...add];
  }
  const resolved: string[] = [];
  for (const label of add) {
    const [current, legacy] = labelForms(label);
    if (current === undefined || legacy === undefined) {
      resolved.push(label);
      continue;
    }
    const preferred = legacy === REVIEW_TRIGGER_LABEL ? [legacy, current] : [current, legacy];
    const found = preferred.map((form) => have.find((name) => typeof name === 'string' && name.toLowerCase() === form.toLowerCase())).find((name) => name !== undefined);
    // No `--force`: it would reset an existing label's color. A failed create surfaces as the failed add.
    if (found === undefined) await gh(['label', 'create', preferred[0]!, '--repo', repoSlug]).catch(() => undefined);
    resolved.push(found ?? preferred[0]!);
  }
  return [...new Set(resolved)];
}

/** The heading the factory's review comment opens with, and the pre-rename one still recognised on existing PRs. */
export const REVIEW_HEADING = '## Taskcell Review';
const LEGACY_REVIEW_HEADING = '## Vanguard Review';

/** True for a review heading line in either spelling. */
export const isReviewHeading = (line: string): boolean => line === REVIEW_HEADING || line === LEGACY_REVIEW_HEADING;

/** True when `body` opens with the review heading in either spelling. */
export const hasReviewHeading = (body: string): boolean => body.startsWith(REVIEW_HEADING) || body.startsWith(LEGACY_REVIEW_HEADING);
