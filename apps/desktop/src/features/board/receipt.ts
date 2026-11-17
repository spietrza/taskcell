import type { RunDetail } from '../../wire';
import { diffStat } from './stationNotes';

const NOT_YET = 'not yet';
const NOT_RECORDED = 'not recorded';
export interface ReceiptFact {
  key: 'tests' | 'review' | 'secrets' | 'cost';
  label: string;
  value: string;
  tone: 'pass' | 'fail' | 'none';
}

/** The four facts of the receipt: "not yet" with no finished run, "not recorded" for a fact its record does not carry — never a guess. */
export function receipt(run: RunDetail | undefined, totalCostUsd?: number): ReceiptFact[] {
  const none = (key: ReceiptFact['key'], label: string): ReceiptFact => ({ key, label, value: run === undefined ? NOT_YET : NOT_RECORDED, tone: 'none' });
  if (run === undefined) return [none('tests', 'Tests'), none('review', 'Second-AI review'), none('secrets', 'Secret scan'), none('cost', 'Cost')];

  const proof = run.proof;
  const verdict = run.stages.find((s) => s.record.stage === 'reviewer')?.record.verdict;
  // Only the scan's own verdict counts: 'secret-scan' withheld a flagged diff. 'secret-blocked' also marks a revise
  // round whose diff could not be captured, so it says nothing either way. Clean = the implementer's diff was kept.
  const found = run.stages.some((s) => s.record.diffOmitted === 'secret-scan');
  const ambiguous = run.stages.some((s) => s.record.diffOmitted === 'secret-blocked');
  const clean = !ambiguous && run.stages.some((s) => s.record.stage === 'implementer' && s.diff !== undefined);

  return [
    proof === undefined
      ? none('tests', 'Tests')
      : { key: 'tests', label: 'Tests', value: proof.passed ? 'passed' : 'failed', tone: proof.passed ? 'pass' : 'fail' },
    verdict === undefined
      ? none('review', 'Second-AI review')
      : {
          key: 'review',
          label: 'Second-AI review',
          value: verdict === 'pass' ? 'passed' : verdict === 'changes' ? 'changes requested' : 'incomplete',
          tone: verdict === 'pass' ? 'pass' : 'fail',
        },
    found
      ? { key: 'secrets', label: 'Secret scan', value: 'secret found', tone: 'fail' }
      : clean
        ? { key: 'secrets', label: 'Secret scan', value: 'clean', tone: 'pass' }
        : none('secrets', 'Secret scan'),
    totalCostUsd === undefined || totalCostUsd <= 0
      ? none('cost', 'Cost')
      : { key: 'cost', label: 'Cost', value: `$${totalCostUsd.toFixed(2)}`, tone: 'none' },
  ];
}

export interface ReceiptRow {
  label: string;
  value: string;
  tone: ReceiptFact['tone'];
}

// shortcut: mirrors workflowPaths() in src/core/taskcell.ts (no wire for it); update both together.
const CI_CONFIG = /^(\.github\/(workflows|actions)\/|\.gitlab-ci\.yml$|\.gitlab\/.*\.ya?ml$)/;

/** The paths a unified diff touches (its `diff --git a/<path>` lines). */
function diffPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]!);
}

/**
 * The run page's receipt (v3 "Receipt so far"): the four facts plus who wrote and reviewed it, the gate
 * command, CI config, the diff size and the skills used. A missing value reads "not yet" on a live run, "not recorded" after.
 * Skills used: "none" for a recorded empty list, no row at all for a run recorded before the field.
 */
export function receiptRows(run: RunDetail, cost: string | undefined, live = false): ReceiptRow[] {
  const facts = Object.fromEntries(receipt(run).map((f) => [f.key, f]));
  const row = (label: string, value: string | undefined, tone: ReceiptFact['tone'] = 'none'): ReceiptRow =>
    value === undefined || value === '' ? { label, value: live ? NOT_YET : NOT_RECORDED, tone: 'none' } : { label, value, tone };
  const record = (re: RegExp) => run.stages.find((s) => s.record.stage !== undefined && re.test(s.record.stage));
  const spec = record(/spec|plan/i);
  const author = record(/implement/i);
  const reviewer = record(/review/i);
  const review = facts.review!;
  const tests = facts.tests!;
  const ci = author?.diff === undefined ? undefined : diffPaths(author.diff).filter((p) => CI_CONFIG.test(p));
  const recorded = run.stages.filter((s) => s.record.skillsUsed !== undefined);
  const skills = [...new Set(recorded.flatMap((s) => s.record.skillsUsed ?? []))];

  return [
    // A finished run without a spec stage built from the card itself.
    row('Spec', spec?.record.model ?? (live ? undefined : 'from the issue')),
    row('Author', author?.record.model),
    reviewer === undefined
      ? row('Reviewer', undefined)
      : row('Reviewer', [reviewer.record.model, review.tone === 'none' ? undefined : review.value].filter(Boolean).join(' · '), review.tone),
    tests.tone === 'none' ? row('Gates', undefined) : row('Gates', `${tests.value} · ${run.proof!.command}`, tests.tone),
    row('Secret scan', facts.secrets!.tone === 'none' ? undefined : facts.secrets!.value, facts.secrets!.tone),
    row('CI config', ci === undefined ? undefined : ci.length === 0 ? 'untouched' : `changed: ${ci.join(', ')}`, ci !== undefined && ci.length > 0 ? 'fail' : 'none'),
    row('Diff', diffStat(author?.diff)),
    ...(recorded.length === 0 ? [] : [row('Skills used', skills.length === 0 ? 'none' : skills.join(', '))]),
    row('Cost', cost),
  ];
}
