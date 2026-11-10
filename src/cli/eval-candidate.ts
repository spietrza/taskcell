import type { RetrospectiveEntry } from '../core/retrospective-memory.js';
import { redact } from '../core/retrospective-memory.js';
import type { EvalCase } from '../evals/types.js';

/** Provenance kinds sourced from GitHub instead of the local retrospective store (S-eval-github). */
export type GitHubCandidateKind = 'pr_closed_unmerged' | 'pr_needs_human_review' | 'reverted_commit';

/** Every source a draft eval candidate can be derived from. */
export type CandidateSource = RetrospectiveEntry['kind'] | GitHubCandidateKind;

/**
 * A DRAFT eval-corpus candidate. NOT an EvalCase you can commit — it carries provenance
 * and is explicitly marked draft. A human curates `case` before it may enter src/evals/corpus.
 */
export interface EvalCaseCandidate {
  /** Draft case: id, guessed kind, derived input, expectation placeholder. */
  case: EvalCase;
  /** The retrospective or GitHub signal this was derived from (provenance). */
  source: CandidateSource;
  /** Human-readable note on why the original run/PR/commit was rejected (the redacted detail). */
  reason: string;
  /** Set for GitHub-sourced candidates: the PR or commit URL and, when known, the issue number. */
  provenance?: { url: string; issueNumber?: number };
}

/** Shared DRAFT expectation placeholder — every candidate carries it until a human rewrites it. */
export const EXPECTATION = redact('The agent handles this scenario without repeating the failure above. (DRAFT — rewrite before curating.)');

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Stable id for a GitHub-sourced candidate, derived from its source URL (dedup key). */
export function candidateIdFromUrl(url: string): string {
  return `draft-gh-${slug(url)}`;
}

/**
 * Drop a candidate whose id already names an existing corpus case, or a duplicate id already seen in
 * this batch (first occurrence wins). Keeps `eval --suggest` idempotent across repeat runs over the
 * same window and across overlapping sources (e.g. a PR that is both closed-unmerged and labeled
 * needs-human-review) without any suggestion store — the id is a pure function of its source.
 */
export function dedupeCandidates(candidates: EvalCaseCandidate[], existing: readonly EvalCase[] = []): EvalCaseCandidate[] {
  const existingIds = new Set(existing.map((c) => c.id));
  const seen = new Set<string>();
  const result: EvalCaseCandidate[] = [];
  for (const candidate of candidates) {
    const id = candidate.case.id;
    if (existingIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(candidate);
  }
  return result;
}
