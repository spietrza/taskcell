/**
 * Label/marker naming: the factory writes `taskcell:*` / `taskcell::*` labels and `taskcell-*` comment markers
 * and keeps reading the pre-rename `vanguard` forms (removed in a later major release).
 */
const CURRENT = 'taskcell';
const LEGACY = 'vanguard';
const LEGACY_REVIEW_TRIGGER = 'ready for vanguard review';

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
 * the item actually carries (`present`, fetched lazily — only when needed). A blind remove of a label the repo
 * never created makes `gh issue edit` fail, so the twin is never removed unseen. Falls back to the name as given.
 */
export async function resolveRemovals(remove: ReadonlyArray<string>, present: () => Promise<ReadonlyArray<string>>): Promise<string[]> {
  if (!remove.some((l) => labelForms(l).length > 1)) return [...remove];
  let have: ReadonlyArray<string>;
  try {
    have = await present();
  } catch {
    return [...remove];
  }
  return [...new Set(remove.flatMap((l) => {
    const seen = labelForms(l).filter((form) => have.includes(form));
    return seen.length > 0 ? seen : [l];
  }))];
}

/** The heading the factory's review comment opens with, and the pre-rename one still recognised on existing PRs. */
export const REVIEW_HEADING = '## Taskcell Review';
const LEGACY_REVIEW_HEADING = '## Vanguard Review';

/** True for a review heading line in either spelling. */
export const isReviewHeading = (line: string): boolean => line === REVIEW_HEADING || line === LEGACY_REVIEW_HEADING;

/** True when `body` opens with the review heading in either spelling. */
export const hasReviewHeading = (body: string): boolean => body.startsWith(REVIEW_HEADING) || body.startsWith(LEGACY_REVIEW_HEADING);
