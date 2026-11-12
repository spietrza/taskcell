/**
 * Incremental re-review: when a PR already carries a factory review, the next review is told what that
 * review found and what changed since, and the host enforces the convergence rules on the reply
 * (previous-finding table, no new blocking finding on unchanged code, verdict derived from the table).
 */
import { z } from 'zod';
import { extractJson } from '../structured/extract.js';
import { neutralizePromptTags } from '../context/escape.js';
import { DIFF_GIT_HEADER_RE, extractReviewVerdict, RISK_RE, VERDICT_RE } from './review-prompt.js';

export interface ReReviewContext {
  /** The previous factory review's body and the head SHA it was made at. */
  previousBody: string;
  previousSha: string;
  /** Revision Summary comments posted since that review, oldest first. */
  revisionSummaries: string[];
  /** Diff from the previously reviewed head to the current one; absent when it could not be fetched (e.g. force-push). */
  sinceDiff?: string;
}

const PREVIOUS_STATUSES = ['resolved', 'not resolved', 'no longer applies'] as const;
const NEW_BASES = ['changed-since-last-review', 'missed-blocking-class'] as const;

const reReviewSchema = z.object({
  previous: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      blocking: z.boolean(),
      status: z.enum(PREVIOUS_STATUSES),
      evidence: z.string(),
    }),
  ),
  // Required, and a blocking entry must name its basis: an omission is a malformed block (verdict stays as
  // stated), never a silent "no new findings".
  new: z.array(
    z
      .object({
        title: z.string(),
        file: z.string().optional(),
        blocking: z.boolean(),
        basis: z.enum(NEW_BASES).optional(),
      })
      .refine((f) => !f.blocking || f.basis !== undefined, { message: 'a blocking new finding needs a basis' }),
  ),
});

/** Paths touched by a unified diff (the `b/` side of each `diff --git` header, quoted ones included). Lines split on \n only, like git. */
function changedFilesOf(diff: string): string[] {
  return diff.split('\n').flatMap((line) => {
    const quoted = /^diff --git "a\/.*" "b\/(.+)"$/.exec(line)?.[1];
    const path = quoted ?? DIFF_GIT_HEADER_RE.exec(line)?.[1];
    return path === undefined ? [] : [path];
  });
}

/** A reviewer's `file` as a repo path: no code quotes, `:line` suffix or leading `./`. */
function normalizeFile(file: string): string {
  return file.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/:\d+(?:[-:]\d+)?$/, '').replace(/^\.\//, '');
}

/** Prompt block for a re-review. Everything quoted from the PR is untrusted content, escaped like the diff. */
export function reReviewInstructions(ctx: ReReviewContext): { rules: string[]; untrusted: string[] } {
  const rules = [
    `This is a RE-REVIEW: the PR was already reviewed at head ${ctx.previousSha.slice(0, 7)}. Reviews must converge, so:`,
    '- Start with the `Verdict:` and `Risk:` lines, then emit a <rereview> JSON block (the host renders it as a table of every previous finding, resolved / not resolved / no longer applies, with one line of evidence each, and strips the block from the posted review): {"previous":[{"id","title","blocking":bool,"status":"resolved"|"not resolved"|"no longer applies","evidence":"one line"}],"new":[{"title","file","blocking":bool,"basis":"changed-since-last-review"|"missed-blocking-class"}]}. List EVERY finding of the previous review in "previous", with the blocking flag it had there; when the previous review has a findings table, reuse its ids (including `N1`-style rows) exactly. The host keeps the reviewer\'s own verdict when a blocking finding the previous review left open is missing or re-rated.',
    '- A finding the previous review rated non-blocking keeps that rating on code that did not change since. Never re-rate unchanged code.',
    '- A NEW blocking finding is allowed only for code changed since the last reviewed head (basis `changed-since-last-review`, `file` must be a file in the diff since that head), or for a blocking-class problem per the repository review guidelines that the previous review missed (basis `missed-blocking-class`). Anything else is non-blocking. The host downgrades a new blocking finding that does not meet this.',
    '- The verdict is BLOCKING only if at least one blocking finding is not resolved; the host recomputes it from the <rereview> block.',
  ];
  const tag = (name: string, body: string): string[] => ['', `<${name}>`, neutralizePromptTags(body), `</${name}>`];
  // Quoted PR content (the previous review's text, summaries and the diff are all attacker-influenced) goes
  // OUTSIDE the authoritative task_instructions block, like the diff itself.
  const untrusted = [
    ...tag('previous_review', ctx.previousBody),
    ...tag('revision_summaries', ctx.revisionSummaries.length === 0 ? '(none)' : ctx.revisionSummaries.join('\n\n---\n\n')),
    ...tag('diff_since_last_review', ctx.sinceDiff === undefined || ctx.sinceDiff.trim() === '' ? '(unavailable or empty; the full diff is all there is)' : ctx.sinceDiff),
  ];
  return { rules, untrusted };
}

/** Tags of the untrusted re-review blocks, for the input_handling note. */
export const RE_REVIEW_UNTRUSTED_TAGS = '<previous_review>, <revision_summaries>, <diff_since_last_review>';

const REREVIEW_OPEN_RE = /<rereview>/gi;
// Closed blocks, then an unclosed (truncated) one to the end: neither may reach the posted comment.
const REREVIEW_STRIP_RE = /<rereview>[\s\S]*?<\/rereview>|<rereview>[\s\S]*$/gi;
export const REREVIEW_MALFORMED_NOTE = '_Re-review: the re-review block was missing, repeated or malformed, so previous findings were not tracked and the verdict above is the reviewer\'s own._';

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/** Split a reply into its first verdict line, the risk line after it, and everything else (all verdict lines dropped). */
function peelVerdict(text: string): { verdict?: string; risk?: string; rest: string } {
  const lines = text.trim().split('\n');
  const rest: string[] = [];
  let verdict: string | undefined;
  let risk: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!VERDICT_RE.test(lines[i]!)) { rest.push(lines[i]!); continue; }
    verdict ??= lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    if (j < lines.length && RISK_RE.test(lines[j]!)) {
      risk ??= lines[j]!;
      i = j;
    }
  }
  return { ...(verdict !== undefined ? { verdict } : {}), ...(risk !== undefined ? { risk } : {}), rest: rest.join('\n').trim() };
}

// An open blocking row of a previous re-review's table: `| <id>: <title> (blocking) | not resolved|new | …`.
const OPEN_BLOCKING_ROW_RE = /^\| (.+?): .*\(blocking\) \| (?:not resolved|new) \|/gm;
// A blocking finding in the reviewer's own layout: a `[high]`/`[critical]` label opening a line or list item.
const BLOCKING_LABEL_RE = /^[ \t]*(?:[-*]|\d+[.)])?[ \t]*\[(?:high|critical)\]/gim;

/**
 * Does the table account for every blocking finding the previous review left open? Its open blocking rows
 * (when it was itself a re-review) must reappear by id as blocking, and there must be at least as many
 * blocking rows as it had labelled blocking findings — at least one when its verdict was BLOCKING.
 */
function coversPreviousBlocking(previous: ReadonlyArray<{ id: string; blocking: boolean }>, previousBody: string): boolean {
  const listed = previous.filter((p) => p.blocking).map((p) => cell(p.id));
  const openIds = [...previousBody.matchAll(OPEN_BLOCKING_ROW_RE)].map((m) => m[1]!);
  if (openIds.some((id) => !listed.includes(id))) return false;
  const labelled = previousBody.match(BLOCKING_LABEL_RE)?.length ?? 0;
  const verdictBlocking = extractReviewVerdict(peelVerdict(previousBody).verdict ?? '') === 'blocking';
  return listed.length >= Math.max(labelled, verdictBlocking ? 1 : 0);
}

/**
 * Enforce the re-review rules on the reviewer's reply. A missing, repeated or malformed <rereview> block
 * (exactly one is valid, so a quoted second one cannot override the real one) leaves the reviewer's stated
 * verdict untouched — a formatting slip never flips it — and is noted; so does a block that drops or re-rates
 * a blocking finding the previous review (`previousBody`) left open (coversPreviousBlocking). `downgraded`
 * counts new blocking findings rejected by the rules.
 */
export function applyReReviewRules(
  text: string,
  ctx: Pick<ReReviewContext, 'sinceDiff'> & Partial<Pick<ReReviewContext, 'previousBody'>>,
): { text: string; downgraded: number } {
  const peeled = peelVerdict(text.replace(REREVIEW_STRIP_RE, ''));
  let parsed: z.infer<typeof reReviewSchema> | undefined;
  try {
    if ((text.match(REREVIEW_OPEN_RE) ?? []).length === 1) parsed = extractJson(text, 'rereview', reReviewSchema);
  } catch {
    parsed = undefined;
  }
  // Deriving the verdict from the table must never turn BLOCKING into clean by omission or re-rating (fail-open
  // past the approver): a table that does not account for the previous review's open blocking findings is malformed.
  if (parsed !== undefined && ctx.previousBody !== undefined && !coversPreviousBlocking(parsed.previous, ctx.previousBody)) parsed = undefined;
  if (parsed === undefined) {
    return {
      text: [...(peeled.verdict !== undefined ? [peeled.verdict] : []), ...(peeled.risk !== undefined ? [peeled.risk] : []), '', peeled.rest, '', REREVIEW_MALFORMED_NOTE].join('\n').trim(),
      downgraded: 0,
    };
  }

  const changed = ctx.sinceDiff !== undefined ? changedFilesOf(ctx.sinceDiff) : undefined;
  const rejected: string[] = [];
  const accepted: typeof parsed.new = [];
  for (const f of parsed.new) {
    if (!f.blocking) continue;
    const file = f.file === undefined ? undefined : normalizeFile(f.file);
    const ok =
      f.basis === 'missed-blocking-class' ||
      (f.basis === 'changed-since-last-review' && (changed === undefined || (file !== undefined && changed.some((c) => c === file || c.endsWith(`/${file}`)))));
    if (ok) accepted.push(f);
    else rejected.push(f.title);
  }
  const unresolvedBlocking = parsed.previous.filter((p) => p.blocking && p.status === 'not resolved').length;
  const blocking = unresolvedBlocking + accepted.length > 0;

  // Accepted new blocking findings are rows too, so the next round must track them like any previous finding.
  const rows = [
    ...parsed.previous.map((p) => `| ${cell(p.id)}: ${cell(p.title)}${p.blocking ? ' (blocking)' : ''} | ${p.status} | ${cell(p.evidence)} |`),
    ...accepted.map((f, i) => `| N${i + 1}: ${cell(f.title)} (blocking) | new | ${cell(f.file ?? f.basis ?? '')} |`),
  ];
  const table = [
    '| Previous finding | Status | Evidence |',
    '| --- | --- | --- |',
    ...(rows.length === 0 ? ['| (none) | - | The previous review had no findings. |'] : rows),
  ];
  const notes = rejected.map((t) => `- Not blocking: "${cell(t)}" — a new blocking finding must be on code changed since the last reviewed head or a blocking-class problem the previous review missed.`);
  return {
    text: [
      blocking ? 'Verdict: BLOCKING' : 'Verdict: NO BLOCKING FINDINGS',
      ...(peeled.risk !== undefined ? [peeled.risk] : []),
      '',
      table.join('\n'),
      ...(notes.length > 0 ? ['', 'Downgraded by the re-review rules:', ...notes] : []),
      '',
      peeled.rest,
    ].join('\n').trim(),
    downgraded: rejected.length,
  };
}
