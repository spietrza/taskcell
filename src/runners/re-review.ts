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
  /** Files touched since the last reviewed head, from the untruncated since-diff (`sinceDiff` may be cut for the prompt). */
  changedFiles?: string[];
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

// A `diff --git` header whose b side git C-quoted (a name with `"`, `\`, a control char or, with the default
// core.quotePath, a non-ASCII byte), with the a side quoted or not; and one where only the a side is quoted.
const QUOTED_B_HEADER_RE = /^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.*?) "b\/((?:[^"\\]|\\.)*)"$/;
const QUOTED_A_HEADER_RE = /^diff --git "(?:[^"\\]|\\.)*" b\/(.+)$/;
const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undo git's C-style path quoting (the text inside the quotes); `\NNN` octal escapes are UTF-8 bytes. */
export function unquoteGitPath(quoted: string): string {
  // Work on the UTF-8 bytes as latin1 chars, so literal characters and octal-escaped bytes form one byte string.
  const bytes = Buffer.from(quoted, 'utf8')
    .toString('latin1')
    .replace(/\\(?:([0-3][0-7]{2})|(.))/g, (m, octal: string | undefined, ch: string | undefined) => {
      const code = octal !== undefined ? parseInt(octal, 8) : C_ESCAPES[ch ?? ''];
      return code === undefined ? m : String.fromCharCode(code);
    });
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

/** Paths touched by a unified diff (the `b/` side of each `diff --git` header, git-quoted ones unquoted). Lines split on \n only, like git. */
export function changedFilesOf(diff: string): string[] {
  return diff.split('\n').flatMap((line) => {
    const quoted = QUOTED_B_HEADER_RE.exec(line)?.[1];
    if (quoted !== undefined) return [unquoteGitPath(quoted)];
    const path = QUOTED_A_HEADER_RE.exec(line)?.[1] ?? DIFF_GIT_HEADER_RE.exec(line)?.[1];
    return path === undefined ? [] : [path];
  });
}

/** A reviewer's `file` as a repo path: no code quotes, `:line` suffix or leading `./`. */
function normalizeFile(file: string): string {
  return file.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/:\d+(?:[-:]\d+)?$/, '').replace(/^\.\//, '');
}

/** Does a reviewer's `file` name one of `paths`? The name as written is tried first, then its normalised form. */
function namesAnyOf(file: string | undefined, paths: readonly string[]): boolean {
  if (file === undefined) return false;
  const candidates = [file, file.trim(), normalizeFile(file)].filter((f) => f !== '');
  return candidates.some((f) => paths.some((p) => p === f || p.endsWith(`/${f}`)));
}

/** Prompt block for a re-review. Everything quoted from the PR is untrusted content, escaped like the diff. */
export function reReviewInstructions(ctx: ReReviewContext): { rules: string[]; untrusted: string[] } {
  const rules = [
    `This is a RE-REVIEW: the PR was already reviewed at head ${ctx.previousSha.slice(0, 7)}. Reviews must converge, so:`,
    '- Start with the `Verdict:` and `Risk:` lines, then IMMEDIATELY emit a <rereview> JSON block at the start of a line, not inside a quote or code fence (the host renders it as a table of every previous finding, resolved / not resolved / no longer applies, with one line of evidence each, and strips the block from the posted review): {"previous":[{"id","title","blocking":bool,"status":"resolved"|"not resolved"|"no longer applies","evidence":"one line"}],"new":[{"title","file","blocking":bool,"basis":"changed-since-last-review"|"missed-blocking-class"}]}. List EVERY finding of the previous review in "previous", with the blocking flag it had there; when the previous review has a findings table, reuse its ids (including `N1`-style rows) exactly. The host keeps the reviewer\'s own verdict when a blocking finding the previous review left open is missing or re-rated.',
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

/**
 * The reply's header: the verdict line only when it is the FIRST non-blank line, and the risk line only when it
 * is the next non-blank one (the positions extractReviewVerdict/extractReviewRisk accept). A `Verdict:`/`Risk:`
 * line anywhere else (e.g. quoted from the untrusted diff) decides nothing. `next` indexes the line after the header.
 */
function readHeader(lines: readonly string[]): { verdict?: string; risk?: string; next: number } {
  const nonBlank = (from: number): number => {
    let i = from;
    while (i < lines.length && lines[i]!.trim() === '') i++;
    return i;
  };
  const i = nonBlank(0);
  if (i >= lines.length || !VERDICT_RE.test(lines[i]!)) return { next: 0 };
  const verdict = lines[i]!;
  const j = nonBlank(i + 1);
  if (j < lines.length && RISK_RE.test(lines[j]!)) return { verdict, risk: lines[j]!, next: j + 1 };
  return { verdict, next: i + 1 };
}

/** Split a reply into its header verdict/risk lines and everything else (later verdict lines dropped, so the posted review states one). */
function peelVerdict(text: string): { verdict?: string; risk?: string; rest: string } {
  const lines = text.split('\n');
  const { next, ...header } = readHeader(lines);
  return { ...header, rest: lines.slice(next).filter((l) => !VERDICT_RE.test(l)).join('\n').trim() };
}

/**
 * The reply from its <rereview> block on, when that block sits at its fixed position: directly after the header
 * verdict/risk lines, at the start of a line. A block anywhere else (inside a quote, fence or later prose) is not
 * the reviewer's own and is never accepted.
 */
function headerBlock(text: string): string | undefined {
  const lines = text.split('\n');
  const { verdict, next } = readHeader(lines);
  if (verdict === undefined) return undefined;
  const after = lines.slice(next).join('\n').trimStart();
  return /^<rereview>/i.test(after) ? after : undefined;
}

// The previous comment opens with the review heading (and, when it ended without completion, a one-line note).
const PREVIOUS_PREAMBLE_RE = /^\s*## (?:Taskcell|Vanguard) Review[ \t]*\n(?:\s*_[^\n]*_[ \t]*\n)?/;

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
  const verdictBlocking = extractReviewVerdict(previousBody.replace(PREVIOUS_PREAMBLE_RE, '')) === 'blocking';
  return listed.length >= Math.max(labelled, verdictBlocking ? 1 : 0);
}

/**
 * Enforce the re-review rules on the reviewer's reply. A missing, repeated, misplaced or malformed <rereview>
 * block (exactly one is valid, directly after the header verdict/risk lines, so a quoted one can neither stand in
 * for nor override the real one) leaves the reviewer's stated
 * verdict untouched — a formatting slip never flips it — and is noted; so does a block that drops or re-rates
 * a blocking finding the previous review (`previousBody`) left open (coversPreviousBlocking). `downgraded`
 * counts new blocking findings rejected by the rules; a changed-code finding whose file matches no path in the PR
 * (`prFiles` or the since-diff) is not rejected, and the stated verdict stands unless the table already blocks.
 */
export function applyReReviewRules(
  text: string,
  ctx: Pick<ReReviewContext, 'sinceDiff'> & Partial<Pick<ReReviewContext, 'previousBody' | 'changedFiles'>> & { prFiles?: readonly string[] },
): { text: string; downgraded: number } {
  const peeled = peelVerdict(text.replace(REREVIEW_STRIP_RE, ''));
  let parsed: z.infer<typeof reReviewSchema> | undefined;
  try {
    const block = headerBlock(text);
    if (block !== undefined && (text.match(REREVIEW_OPEN_RE) ?? []).length === 1) parsed = extractJson(block, 'rereview', reReviewSchema);
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

  const changed = ctx.changedFiles ?? (ctx.sinceDiff !== undefined ? changedFilesOf(ctx.sinceDiff) : undefined);
  const known = [...(changed ?? []), ...(ctx.prFiles ?? [])];
  const rejected: string[] = [];
  const unmatched: string[] = [];
  const accepted: typeof parsed.new = [];
  for (const f of parsed.new) {
    if (!f.blocking) continue;
    if (f.basis === 'missed-blocking-class' || changed === undefined || namesAnyOf(f.file, changed)) accepted.push(f);
    // A file the host cannot map to any path in the PR is not evidence of unchanged code: never downgrade on it.
    else if (!namesAnyOf(f.file, known)) unmatched.push(f.title);
    else rejected.push(f.title);
  }
  const unresolvedBlocking = parsed.previous.filter((p) => p.blocking && p.status === 'not resolved').length;
  const derivedBlocking = unresolvedBlocking + accepted.length > 0;
  // An unmatched changed-code finding leaves the reviewer's stated verdict in place unless the table already blocks.
  const verdictLine = derivedBlocking ? 'Verdict: BLOCKING' : unmatched.length > 0 ? peeled.verdict : 'Verdict: NO BLOCKING FINDINGS';

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
  const unmatchedNotes = unmatched.map((t) => `- "${cell(t)}" — its file could not be matched to any path in the PR, so the verdict above is the reviewer's own.`);
  return {
    text: [
      ...(verdictLine !== undefined ? [verdictLine] : []),
      ...(peeled.risk !== undefined ? [peeled.risk] : []),
      '',
      table.join('\n'),
      ...(notes.length > 0 ? ['', 'Downgraded by the re-review rules:', ...notes] : []),
      ...(unmatchedNotes.length > 0 ? ['', 'Not downgraded (file not matched):', ...unmatchedNotes] : []),
      '',
      peeled.rest,
    ].join('\n').trim(),
    downgraded: rejected.length,
  };
}

const MERGE_ONLY_RE = /^<!-- merge-only: (\{.*\}) -->$/m;
const mergeOnlySchema = z.object({ from: z.string(), to: z.string(), files: z.array(z.string()) });

/** Machine-readable record of a merge-only round for the incremental re-review: the head it started from, the commit it pushed and the conflicted files it resolved. */
export const mergeOnlyMarker = (round: { from: string; to: string; files: readonly string[] }): string =>
  `<!-- merge-only: ${JSON.stringify({ from: round.from, to: round.to, files: round.files }).replace(/-->/g, '--\\u003e')} -->`;

/**
 * The files resolved by merge-only rounds, when the Revision Summaries (oldest first) are all merge-only and
 * their commits chain exactly from `from` (the last reviewed head) to `to` (the current head). Undefined
 * otherwise: any other push in that range (a human commit, an ordinary round) is reviewed in full.
 */
export function mergeOnlyResolvedFiles(summaries: readonly string[], from: string, to: string): string[] | undefined {
  if (summaries.length === 0) return undefined;
  const files = new Set<string>();
  let at = from;
  for (const body of summaries) {
    const raw = MERGE_ONLY_RE.exec(body)?.[1];
    if (raw === undefined) return undefined;
    let round: z.infer<typeof mergeOnlySchema>;
    try {
      round = mergeOnlySchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
    if (round.from !== at) return undefined;
    at = round.to;
    for (const f of round.files) files.add(f);
  }
  return at === to ? [...files] : undefined;
}

/** Keep only the `diff --git` blocks of `files` (a block starts at a line-initial header, split on \n only). */
export function restrictDiffToFiles(diff: string, files: readonly string[]): string {
  const keep = new Set(files);
  return diff.split(/(?<=\n)(?=diff --git )/).filter((block) => changedFilesOf(block).some((f) => keep.has(f))).join('');
}
