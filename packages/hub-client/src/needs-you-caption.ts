// GENERATED from src/needs-you-caption.ts — do not edit; run pnpm gen:wire
/**
 * The Needs-you caption, alert flag and age wording: one rule for the hub's push notification, the desktop Home/inbox
 * and the mobile app. Copied to packages/hub-client/src by `pnpm gen:wire` (drift guard: src/wire.test.ts).
 *
 * RULES (enforced by src/wire.test.ts): ZERO imports, static or dynamic — safe in Node, the browser and React Native.
 */

/** The parts of a Needs-you item the caption depends on. */
export interface NeedsYouCaptionInput {
  kind: 'issue' | 'pr' | 'card';
  reason: string;
  ask?: string;
}

/** What the item is: PR first (changes requested, verify failed as the `:verify-failed` suffix of either label prefix), else the agent's question. */
export function needsYouCaption(item: NeedsYouCaptionInput): string {
  if (item.kind === 'pr') {
    if (item.reason === 'changes requested') return 'Changes requested';
    return item.reason.endsWith(':verify-failed') ? 'Verify failed' : 'PR ready';
  }
  return item.ask === 'too-vague' ? 'Too vague' : 'Question';
}

/** True for a state that is broken, not just waiting. */
export const needsYouAlert = (item: NeedsYouCaptionInput): boolean => needsYouCaption(item) === 'Verify failed';

/** Compact "Ns/m/h/d ago" from elapsed milliseconds; negative (future) clamps to "0s ago". */
export function agoWords(elapsedMs: number): string {
  const s = Math.max(0, Math.round(elapsedMs / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
