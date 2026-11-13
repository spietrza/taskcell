import { createHash } from 'node:crypto';
import { matchGlob } from '../approver/policy.js';
import { appendAudit, branchAdapter, defaultActor, STREAMS } from './audit.js';
import { METRICS_BRANCH_DEFAULT, readBranchFile } from './metrics-branch.js';
import { redactForPublish } from './secret-scan.js';
import { parseJsonlLines } from './stats.js';
import { redact } from './retrospective-memory.js';

/**
 * Per-PR lessons (#765): 0-3 actionable rules distilled from a closed factory PR's history, stored as
 * `lessons.jsonl` on the metrics branch so they outlive the CI job, and read back into the next run's
 * `<retrospective_memory>` block. A dismissal is its own record, and any dismissal of an id hides that
 * lesson for good.
 */

export const LESSONS_FILE = 'lessons.jsonl';
export const LESSON_STAGES = ['spec', 'implement', 'review', 'verify'] as const;
export type LessonStage = (typeof LESSON_STAGES)[number];

export interface Lesson {
  kind: 'lesson';
  /** Hash of the normalized rule: the dedupe key, and what `lessons dismiss` takes. */
  id: string;
  rule: string;
  why: string;
  /** PR or comment URL the lesson came from. */
  evidence: string;
  /** Path globs the lesson applies to; empty = repo-wide. */
  paths: string[];
  stage?: LessonStage;
  repo: string;
  prNumber: number;
  timestamp: string;
}

export interface LessonDismissal {
  kind: 'dismiss';
  id: string;
  timestamp: string;
}

const RULE_MAX = 240;
const WHY_MAX = 240;
const DEFAULT_MAX_BYTES = 2048;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** Both redactions: the pattern mask used for memory, and the injected-credential mask used for publishing. */
export function scrub(text: string): string {
  return redact(redactForPublish(text));
}

export function lessonId(rule: string): string {
  return createHash('sha256').update(rule.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

export interface LessonDraft {
  rule: string;
  why: string;
  evidence: string;
  paths?: string[] | undefined;
  stage?: LessonStage | undefined;
}

/**
 * Turn model drafts into stored lessons: scrubbed, clipped, at most 3, evidence restricted to the URLs
 * the PR history actually holds (anything else falls back to the PR URL), unsafe globs dropped.
 */
export function finalizeLessons(
  drafts: readonly LessonDraft[],
  ctx: { repo: string; prNumber: number; prUrl: string; evidenceUrls: ReadonlySet<string>; now: Date },
): Lesson[] {
  const out: Lesson[] = [];
  const seen = new Set<string>();
  for (const d of drafts.slice(0, 3)) {
    const rule = clip(scrub(d.rule), RULE_MAX);
    if (rule === '') continue;
    const id = lessonId(rule);
    if (seen.has(id)) continue;
    seen.add(id);
    const paths = (d.paths ?? [])
      .map((p) => p.trim())
      .filter((p) => p !== '' && p.length <= 200 && !p.startsWith('/') && !p.split('/').includes('..'))
      .slice(0, 10);
    out.push({
      kind: 'lesson',
      id,
      rule,
      why: clip(scrub(d.why), WHY_MAX),
      evidence: ctx.evidenceUrls.has(d.evidence) ? d.evidence : ctx.prUrl,
      paths,
      ...(d.stage !== undefined ? { stage: d.stage } : {}),
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      timestamp: ctx.now.toISOString(),
    });
  }
  return out;
}

function asLesson(r: Record<string, unknown>): Lesson | undefined {
  if (r.kind !== 'lesson' || typeof r.id !== 'string' || typeof r.rule !== 'string') return undefined;
  const paths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string') : [];
  const stage = LESSON_STAGES.find((s) => s === r.stage);
  return {
    kind: 'lesson',
    id: r.id,
    rule: r.rule,
    why: typeof r.why === 'string' ? r.why : '',
    evidence: typeof r.evidence === 'string' ? r.evidence : '',
    paths,
    ...(stage !== undefined ? { stage } : {}),
    repo: typeof r.repo === 'string' ? r.repo : '',
    prNumber: typeof r.prNumber === 'number' ? r.prNumber : 0,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
  };
}

/** Live lessons from `lessons.jsonl` text: malformed lines dropped, dismissed ids removed, newest first. */
export function parseLessons(text: string): Lesson[] {
  const records = parseJsonlLines(text);
  const dismissed = new Set(records.filter((r) => r.kind === 'dismiss' && typeof r.id === 'string').map((r) => r.id as string));
  return records
    .map(asLesson)
    .filter((l): l is Lesson => l !== undefined && !dismissed.has(l.id))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Repo-relative path-like tokens in free text (`src/core/x.ts`, `docs/cli.md`, `package.json`). */
function mentionedPaths(text: string): string[] {
  return [...text.matchAll(/[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]+|[\w.@-]+(?:\/[\w.@-]+)+/g)].map((m) => m[0].replace(/^\.\//, ''));
}

/**
 * Lessons relevant to a task: repo-wide ones (no path scope), and path-scoped ones whose glob matches a
 * path the task text mentions — or a directory prefix of one (`src/core/**` for `src/core/x.ts`).
 */
export function selectLessons(lessons: readonly Lesson[], taskText: string): Lesson[] {
  const mentioned = mentionedPaths(taskText);
  return lessons.filter(
    (l) => l.paths.length === 0 || l.paths.some((glob) => mentioned.some((p) => matchGlob(glob, p) || matchGlob(glob, `${p}/x`))),
  );
}

/** Markdown for the retrospective block, newest first, capped at `maxBytes` on whole lines. */
export function renderLessons(lessons: readonly Lesson[], maxBytes: number = DEFAULT_MAX_BYTES): string {
  if (lessons.length === 0) return '';
  const lines = ['# Lessons from past PRs', ''];
  let size = Buffer.byteLength(lines.join('\n'), 'utf8');
  for (const l of lessons) {
    const scope = [l.stage, ...l.paths].filter(Boolean).join(', ');
    const line = `- ${l.rule}${l.why !== '' ? ` — ${l.why}` : ''}${scope !== '' ? ` [${scope}]` : ''} (${l.evidence})`;
    const add = Buffer.byteLength(`\n${line}`, 'utf8');
    if (size + add > maxBytes) break;
    lines.push(line);
    size += add;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

const lessonKey = (r: Record<string, unknown>): string | undefined =>
  typeof r.id !== 'string' ? undefined : r.kind === 'lesson' ? `lesson:${r.id}` : r.kind === 'dismiss' ? `dismiss:${r.id}` : undefined;

/** Append lessons/dismissals to the metrics branch; a rule already stored (same id) is skipped. */
export async function appendLessonRecords(
  repoPath: string,
  records: ReadonlyArray<Lesson | LessonDismissal>,
  opts: { branch?: string } = {},
): Promise<{ branch: string; pushed: number }> {
  const adapter = branchAdapter(repoPath, { ...(opts.branch !== undefined ? { branch: opts.branch } : {}), file: LESSONS_FILE, key: lessonKey });
  // One subject only when every lesson in the batch is from the same PR.
  const lessons = records.filter((r): r is Lesson => r.kind === 'lesson');
  const first = lessons.every((l) => l.repo === lessons[0]!.repo && l.prNumber === lessons[0]!.prNumber) ? lessons[0] : undefined;
  const pushed = await appendAudit(STREAMS.lessons, adapter, records.map((r) => ({ ...r })), {
    actor: defaultActor(),
    ...(first !== undefined ? { subject: { repo: first.repo, pr: first.prNumber } } : {}),
  });
  return { branch: opts.branch ?? METRICS_BRANCH_DEFAULT, pushed };
}

export async function readLessons(repoPath: string, opts: { branch?: string } = {}): Promise<Lesson[]> {
  return parseLessons(await readBranchFile(repoPath, { ...(opts.branch !== undefined ? { branch: opts.branch } : {}), file: LESSONS_FILE }));
}

/**
 * The lessons block for a run's prompt, or '' — never throws: no remote, no branch or a fetch failure
 * just means no lessons, and the run goes on with the local retrospective memory alone.
 */
export async function loadLessonsForTask(repoPath: string, taskText: string, maxBytes?: number): Promise<string> {
  try {
    return renderLessons(selectLessons(await readLessons(repoPath), taskText), maxBytes);
  } catch {
    return '';
  }
}
