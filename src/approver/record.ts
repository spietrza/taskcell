import { createHash } from 'node:crypto';
import { appendAudit, branchAdapter, BOT_ACTOR, STREAMS } from '../core/audit.js';
import { DECISIONS_FILE } from './ledger.js';
import type { ApproverFacts, Decision, DecisionRecord, Mode } from './types.js';

export interface BuildDecisionRecordInput {
  mode: Mode;
  repo: string;
  prNumber: number;
  /** Head SHA the decision is for; keeps a short-circuited record keyed per head, not one per PR forever. */
  headSha?: string;
  /** Absent for a short-circuited decision (stopped / policy-unreadable): the record carries zeroed/empty signals. */
  facts: ApproverFacts | undefined;
  decision: Decision;
  policyHash: string;
  timestamp: string;
}

export function buildDecisionRecord(input: BuildDecisionRecordInput): DecisionRecord {
  const { facts, decision } = input;
  const base = {
    schemaVersion: 1 as const,
    mode: input.mode,
    repo: input.repo,
    prNumber: input.prNumber,
    auditSample: decision.auditSample,
    rulesFired: decision.rulesFired,
    verdict: decision.verdict,
    policyHash: input.policyHash,
    timestamp: input.timestamp,
    humanOutcome: null,
  };
  if (facts === undefined) {
    return {
      ...base,
      headSha: input.headSha !== undefined && input.headSha !== '' ? input.headSha : null,
      baseSha: null,
      patchId: null,
      reviewedSha: null,
      checks: [],
      review: { verdict: null, sha: null },
      signals: { files: 0, lines: 0, testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false, paths: [] },
      ledger: {},
    };
  }
  return {
    ...base,
    headSha: facts.diff.headSha,
    baseSha: facts.diff.baseSha,
    patchId: facts.diff.headPatchId ?? null,
    reviewedSha: facts.review.sha,
    checks: facts.checks,
    review: { verdict: facts.review.verdict, sha: facts.review.sha },
    signals: {
      files: facts.diff.files,
      lines: facts.diff.lines,
      testFilesDeleted: facts.diff.testFilesDeleted,
      testCasesDelta: facts.diff.testCasesDelta,
      exportsRemoved: facts.diff.exportsRemoved,
      newDependency: facts.diff.newDependency,
      paths: facts.diff.paths,
    },
    ledger: facts.ledger,
  };
}

/** Short stable id of an action's reason, for the dedupe key and the comment marker. */
export function reasonKey(reason: unknown): string {
  return createHash('sha256').update(typeof reason === 'string' ? reason : '', 'utf8').digest('hex').slice(0, 8);
}

const SHORT_CIRCUIT_RULES = new Set(['stopped', 'policy-unreadable']);

/**
 * Dedupe key: (PR, head SHA, kind). A short-circuited placeholder (stop switch, unreadable policy) gets
 * its own kind, so once the stop is lifted the full decision for the same head is still recorded.
 */
export function decisionKey(r: Record<string, unknown>): string {
  if (r.actMerge === true) return `${String(r.prNumber)}:${String(r.headSha)}:act-merge`;
  // The reason is part of the key: a different reason on the same head is a new fact and is reported.
  if (typeof r.action === 'string') return `${String(r.prNumber)}:${String(r.headSha)}:action:${r.action}:${reasonKey(r.reasonCode ?? r.reason)}`;
  const rules = Array.isArray(r.rulesFired) ? r.rulesFired : [];
  const kind = rules.some((id) => typeof id === 'string' && SHORT_CIRCUIT_RULES.has(id)) ? 'short' : 'full';
  return `${String(r.prNumber)}:${String(r.headSha)}:${kind}`;
}

/**
 * Append one decision record to decisions.jsonl on the metrics branch (an audit stream: chained, actor =
 * the factory bot, subject = repo + PR; a failed write throws). A rerun for the same (PR, head SHA, kind) appends nothing.
 */
export async function appendDecision(repoPath: string, record: DecisionRecord, opts: { branch?: string } = {}): Promise<void> {
  await appendRecord(repoPath, record, opts);
}

async function appendRecord(repoPath: string, record: DecisionRecord | ActionRecord, opts: { branch?: string }): Promise<void> {
  const adapter = branchAdapter(repoPath, { ...(opts.branch !== undefined ? { branch: opts.branch } : {}), file: DECISIONS_FILE, key: decisionKey });
  await appendAudit(STREAMS.decisions, adapter, { ...record }, { actor: BOT_ACTOR, subject: { repo: record.repo, pr: record.prNumber } });
}

export type ActionKind = 'update-branch' | 'merge' | 'merge-failed' | 'left-for-human' | 'checks-failed' | 'base-moved' | 'error';

export interface ActionRecord {
  schemaVersion: 1;
  kind: 'action';
  mode: 'act';
  repo: string;
  prNumber: number;
  headSha: string;
  action: ActionKind;
  reason: string;
  /** Stable part of `reason` (when it carries free-form detail): keys the dedupe, so only a different code on the same head is a new record. */
  reasonCode?: string;
  timestamp: string;
}

/** An act-mode action on decisions.jsonl. It has no `verdict`, so the ledger and scorecard readers skip it. */
export async function appendAction(repoPath: string, record: ActionRecord, opts: { branch?: string } = {}): Promise<void> {
  await appendRecord(repoPath, record, opts);
}
