import { describe, expect, it, test } from 'vitest';
import { agoWords, needsYouAlert, needsYouCaption, type NeedsYouCaptionInput } from './needs-you-caption.js';

describe('needsYouCaption', () => {
  test.each<[NeedsYouCaptionInput, string, boolean]>([
    [{ kind: 'pr', reason: 'taskcell:needs-human-review' }, 'PR ready', false],
    [{ kind: 'pr', reason: 'vanguard:needs-human-review' }, 'PR ready', false],
    [{ kind: 'pr', reason: 'changes requested' }, 'Changes requested', false],
    [{ kind: 'pr', reason: 'taskcell:verify-failed' }, 'Verify failed', true],
    [{ kind: 'pr', reason: 'vanguard:verify-failed' }, 'Verify failed', true],
    [{ kind: 'pr', reason: 'x-verify-failed-not-suffix:other' }, 'PR ready', false],
    [{ kind: 'issue', reason: 'needs info' }, 'Question', false],
    [{ kind: 'issue', reason: 'needs info', ask: 'question' }, 'Question', false],
    [{ kind: 'issue', reason: 'needs info', ask: 'too-vague' }, 'Too vague', false],
    [{ kind: 'issue', reason: 'taskcell:verify-failed' }, 'Question', false],
    [{ kind: 'card', reason: 'asked', ask: 'question' }, 'Question', false],
    [{ kind: 'card', reason: 'asked', ask: 'too-vague' }, 'Too vague', false],
    [{ kind: 'card', reason: 'vanguard:verify-failed' }, 'Question', false],
  ])('%j', (item, caption, alert) => {
    expect(needsYouCaption(item)).toBe(caption);
    expect(needsYouAlert(item)).toBe(alert);
  });
});

describe('agoWords', () => {
  it('formats units and boundaries, clamping the future', () => {
    expect(agoWords(-5000)).toBe('0s ago');
    expect(agoWords(59_000)).toBe('59s ago');
    expect(agoWords(60_000)).toBe('1m ago');
    expect(agoWords(3_600_000)).toBe('1h ago');
    expect(agoWords(86_400_000)).toBe('1d ago');
  });
});
