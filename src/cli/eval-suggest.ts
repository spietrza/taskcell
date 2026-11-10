import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { buildRetrospectiveMemory, redact } from '../core/retrospective-memory.js';
import type { RetrospectiveEntry, RetrospectiveReport } from '../core/retrospective-memory.js';
import { corpus } from '../evals/corpus/index.js';
import type { EvalKind } from '../evals/types.js';
import type { Command } from './args.js';
import { EXPECTATION, dedupeCandidates, slug } from './eval-candidate.js';
import type { EvalCaseCandidate } from './eval-candidate.js';
import { fetchGitHubCandidates } from './eval-github-suggest.js';

export type { EvalCaseCandidate } from './eval-candidate.js';
export type EvalSuggestCommand = Extract<Command, { kind: 'eval' }>;

const EMPTY_MARKDOWN_BODY = '_No retrospective entries or GitHub signals to draft candidates from._';
const CORPUS_DIR = resolve(process.cwd(), 'src', 'evals', 'corpus');
/** Used only when --github-repo is given without --since: fetch the repo's whole history. */
const EPOCH = '1970-01-01';

/** Exhaustive over RetrospectiveEntry['kind']; 'refusal' is never auto-guessed (no retrospective signal for it). */
function guessKind(kind: RetrospectiveEntry['kind']): Exclude<EvalKind, 'refusal'> {
  switch (kind) {
    case 'failed_run':
      return 'control';
    case 'failed_proof':
      return 'edge';
    case 'reviewer_note':
      return 'edge';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Pure, deterministic transform: RetrospectiveReport -> draft EvalCase candidates. No I/O, no LLM. */
export function suggestEvalCases(report: RetrospectiveReport): EvalCaseCandidate[] {
  const seenIds = new Set<string>();

  return report.entries.map((entry, index) => {
    const kind = guessKind(entry.kind);

    // taskId isn't documented as pre-redacted (unlike entry.detail), so mask it before use.
    const safeTaskId = redact(entry.taskId);
    const reason = redact(entry.detail);
    const baseId = `draft-${slug(safeTaskId)}-${slug(entry.timestamp)}`;
    const id = seenIds.has(baseId) ? `${baseId}-${index}` : baseId;
    seenIds.add(id);

    const input = `Reproduce and prevent the failure seen in task ${safeTaskId}: ${reason}`;

    return {
      case: { id, kind, input, expectation: EXPECTATION },
      source: entry.kind,
      reason,
    };
  });
}

/** Render candidates to deterministic markdown (pure function — no wall-clock timestamp). */
export function renderCandidatesMarkdown(candidates: EvalCaseCandidate[]): string {
  const lines: string[] = [
    '# Eval Candidates (DRAFT — not committed to the corpus)',
    '',
    'Suggest-only: these are drafts for a human to curate before adding to src/evals/corpus/.',
    '',
  ];

  if (candidates.length === 0) {
    lines.push(EMPTY_MARKDOWN_BODY);
    return lines.join('\n');
  }

  for (const candidate of candidates) {
    lines.push(`## ${candidate.case.id} (guessed kind: ${candidate.case.kind}, source: ${candidate.source})`);
    lines.push('');
    if (candidate.provenance !== undefined) {
      const issue = candidate.provenance.issueNumber !== undefined ? ` (#${candidate.provenance.issueNumber})` : '';
      lines.push(`**Source:** ${candidate.provenance.url}${issue}`);
      lines.push('');
    }
    lines.push(`**Input:** ${candidate.case.input}`);
    lines.push('');
    lines.push(`**Expectation:** ${candidate.case.expectation ?? ''}`);
    lines.push('');
    lines.push(`**Reason:** ${candidate.reason}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** True when `outPath` resolves to somewhere inside src/evals/corpus/ (the corpus itself, never a suggest target). */
function isUnderCorpusDir(outPath: string): boolean {
  const rel = relative(CORPUS_DIR, resolve(outPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Draft eval-corpus candidates from retrospective memory and, with --github-repo, from GitHub
 * (closed-unmerged factory PRs, PRs that ended needs-human-review, reverted factory commits) and
 * print them. Never writes src/evals/corpus/ — --out refuses any path under it.
 */
export async function evalSuggestCommand(cmd: EvalSuggestCommand): Promise<void> {
  // exactOptionalPropertyTypes: omit `limit` entirely when absent so the builder default applies.
  const opts = cmd.limit !== undefined ? { limit: cmd.limit } : {};
  const report = await buildRetrospectiveMemory(cmd.repoPath, opts);
  const since = cmd.since;
  const windowed = since !== undefined ? { entries: report.entries.filter((e) => e.timestamp >= since) } : report;
  const localCandidates = suggestEvalCases(windowed);

  const githubCandidates = cmd.githubRepo !== undefined ? await fetchGitHubCandidates(cmd.githubRepo, cmd.since ?? EPOCH) : [];

  const candidates = dedupeCandidates([...localCandidates, ...githubCandidates], corpus);

  const useMarkdown = cmd.markdown === true || cmd.json !== true;
  const rendered = useMarkdown ? renderCandidatesMarkdown(candidates) : JSON.stringify(candidates, null, 2);
  console.log(rendered);

  if (cmd.out !== undefined) {
    if (isUnderCorpusDir(cmd.out)) {
      throw new Error(`Refusing to write eval candidates under src/evals/corpus/ (--out was "${cmd.out}"). This command is suggest-only.`);
    }
    const outPath = resolve(cmd.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rendered, 'utf8');
  }
}
