import type { ProofFailureKind } from './runners/source-adapter.js';

export const GITHUB_SPEC_CLAIMED_LABEL = 'taskcell:speccing';
export const GITHUB_CLAIMED_LABEL = 'taskcell:running';
export const GITHUB_REVIEW_LABEL = 'taskcell:needs-human-review';
export const GITHUB_NEEDS_RESEARCH_LABEL = 'needs research';
export const GITHUB_RESEARCHING_LABEL = 'taskcell:researching';
export const GITHUB_VERIFY_FAILED_LABEL = 'taskcell:verify-failed';
export const GITHUB_VISUAL_PROOF_FAILED_LABEL = 'taskcell:visual-proof-failed';
export const GITHUB_SECRET_BLOCKED_LABEL = 'taskcell:secret-blocked';
export const GITHUB_GATE_CONFIG_LABEL = 'taskcell:gate-config-changed';
export const GITHUB_RATE_LIMITED_LABEL = 'taskcell:rate-limited';

/** Map a proof-failure kind to its GitHub label. */
export function githubFailureLabel(kind: ProofFailureKind): string {
  if (kind === 'gate-config') return GITHUB_GATE_CONFIG_LABEL;
  return kind === 'verify' ? GITHUB_VERIFY_FAILED_LABEL : GITHUB_VISUAL_PROOF_FAILED_LABEL;
}

/** Parks an issue whose dependencies are unmet or whose `Start:` date is in the future; the resume sweep swaps the trigger label back. */
export const GITHUB_WAITING_LABEL = 'taskcell:waiting';
