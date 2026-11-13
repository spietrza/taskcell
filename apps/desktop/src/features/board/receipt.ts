import type { RunDetail } from '../../wire';

const NOT_AVAILABLE = 'not available';
export interface ReceiptFact {
  key: 'tests' | 'review' | 'secrets' | 'cost';
  label: string;
  value: string;
  tone: 'pass' | 'fail' | 'none';
}

/** The four facts of the receipt. A fact the run record does not carry reads "not available" — never a guess. */
export function receipt(run: RunDetail | undefined, totalCostUsd?: number): ReceiptFact[] {
  const none = (key: ReceiptFact['key'], label: string): ReceiptFact => ({ key, label, value: NOT_AVAILABLE, tone: 'none' });
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
