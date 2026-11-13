import type { ProofFailureKind } from './runners/source-adapter.js';

export const GITLAB_CLAIMED_LABEL = 'taskcell::running';
export const GITLAB_REVIEW_LABEL = 'taskcell::review';
export const GITLAB_SPEC_CLAIMED_LABEL = 'taskcell::speccing';
export const GITLAB_MR_REVIEWING_LABEL = 'taskcell::reviewing';
export const GITLAB_MR_REVIEWED_LABEL = 'taskcell::reviewed';
export const GITLAB_VERIFY_FAILED_LABEL = 'taskcell::verify-failed';
export const GITLAB_VISUAL_PROOF_FAILED_LABEL = 'taskcell::visual-proof-failed';
export const GITLAB_SECRET_BLOCKED_LABEL = 'taskcell::secret-blocked';
export const GITLAB_GATE_CONFIG_LABEL = 'taskcell::gate-config-changed';

/** Map a proof-failure kind to its GitLab label. */
export function gitlabFailureLabel(kind: ProofFailureKind): string {
  if (kind === 'gate-config') return GITLAB_GATE_CONFIG_LABEL;
  return kind === 'verify' ? GITLAB_VERIFY_FAILED_LABEL : GITLAB_VISUAL_PROOF_FAILED_LABEL;
}
