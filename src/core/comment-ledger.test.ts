import { describe, expect, it } from 'vitest';
import {
  containsTrustedMarker,
  declareMarker,
  hasMarker,
  incompleteAttempts,
  lastMarkerAt,
  parseMarkers,
  readTrusted,
  reviewedAtHead,
  revisionRounds,
  soleTrailingMarker,
  stripAllMarkers,
  writeMarker,
} from './comment-ledger.js';
import type { LedgerComment } from './comment-ledger.js';

const SHA = 'abc123';
const until = new Date('2030-01-02T03:04:05.000Z');

/** One row per kind: a payload, and the legacy and (when the kind has one) white-label text for it. */
const TABLE: { kind: string; payload: unknown; legacy: string | undefined; whiteLabel?: string; authors: 'self' | 'trusted' | 'anyone' }[] = [
  { kind: 'pr-review', payload: SHA, legacy: `<!-- vanguard-pr-review: ${SHA} -->`, authors: 'trusted' },
  { kind: 'pr-review-run', payload: { sha: SHA, runId: '42' }, legacy: `<!-- vanguard-pr-review-run: ${SHA}:42 -->`, authors: 'trusted' },
  { kind: 'pr-review-incomplete', payload: SHA, legacy: `<!-- vanguard-pr-review-incomplete: ${SHA} -->`, authors: 'trusted' },
  { kind: 'pr-review-incomplete-cap', payload: SHA, legacy: `<!-- vanguard-pr-review-incomplete-cap: ${SHA} -->`, authors: 'trusted' },
  { kind: 'pr-review-incomplete-note', payload: true, legacy: '<!-- vanguard-pr-review-incomplete -->', authors: 'trusted' },
  { kind: 'mr-review', payload: SHA, legacy: `<!-- vanguard-mr-review: ${SHA} -->`, authors: 'self' },
  { kind: 'mr-review-incomplete', payload: SHA, legacy: `<!-- vanguard-mr-review-incomplete: ${SHA} -->`, authors: 'self' },
  { kind: 'mr-review-incomplete-cap', payload: SHA, legacy: `<!-- vanguard-mr-review-incomplete-cap: ${SHA} -->`, authors: 'self' },
  { kind: 'revision', payload: { head: SHA, mergeOnly: false }, legacy: `<!-- vanguard-revision: ${SHA} -->`, whiteLabel: `<!-- revision: ${SHA} -->`, authors: 'trusted' },
  { kind: 'revision-cap', payload: true, legacy: '<!-- vanguard-revision-cap -->', authors: 'trusted' },
  { kind: 'ci-failed', payload: SHA, legacy: `<!-- vanguard-ci-failed: ${SHA} -->`, authors: 'trusted' },
  { kind: 'approver', payload: SHA, legacy: `<!-- vanguard-approver: ${SHA} -->`, authors: 'trusted' },
  { kind: 'approver-act', payload: `${SHA}:revise:conflict`, legacy: `<!-- vanguard-approver-act: ${SHA}:revise:conflict -->`, authors: 'trusted' },
  { kind: 'research', payload: 3, legacy: '<!-- vanguard-research: 3 -->', whiteLabel: '<!-- research-iter: 3 -->', authors: 'trusted' },
  { kind: 'lesson', payload: true, legacy: '<!-- vanguard-lesson -->', authors: 'trusted' },
  { kind: 'merge-only', payload: { from: 'a1', to: 'b2', files: ['x.ts'] }, legacy: undefined, authors: 'trusted' },
  { kind: 'rate-limited', payload: { until, trigger: 'ready for agent' }, legacy: `<!-- vanguard-rate-limited until=${until.toISOString()} trigger="ready for agent" -->`, authors: 'trusted' },
  { kind: 'waiting', payload: { trigger: 'ready for agent', kind: 'error' }, legacy: '<!-- vanguard:waiting trigger="ready for agent" kind="error" -->', authors: 'trusted' },
  { kind: 'overlap', payload: { until, refs: [{ kind: 'pr', number: 7 }] }, legacy: `<!-- vanguard:overlap until="${until.toISOString()}" refs="pr:7" -->`, authors: 'trusted' },
  { kind: 'skills', payload: ['a', 'b'], legacy: '<!-- vanguard-skills: a,b -->', authors: 'anyone' },
  ...['gate-config-start', 'gate-config-end', 'skills-block-start', 'skills-block-end', 'pr-body-items-start', 'pr-body-items-end'].map(
    (kind) => ({ kind, payload: true, legacy: undefined, authors: 'anyone' as const }),
  ),
];

describe('comment ledger, one row per marker kind', () => {
  it.each(TABLE)('$kind: round-trips write → read', ({ kind, payload }) => {
    const text = writeMarker(kind, payload);
    expect(text.startsWith('<!-- ')).toBe(true);
    expect(parseMarkers(kind, `prose\n${text}\nmore`)).toEqual([payload]);
    expect(hasMarker(kind, text)).toBe(true);
  });

  it.each(TABLE.filter((r) => r.legacy !== undefined))('$kind: reads the legacy spelling', ({ kind, payload, legacy }) => {
    expect(parseMarkers(kind, `x\n${legacy}`)).toEqual([payload]);
  });

  it.each(TABLE)('$kind: white-label spelling', ({ kind, payload, whiteLabel }) => {
    const text = writeMarker(kind, payload, { whiteLabel: true });
    if (whiteLabel !== undefined) expect(text).toBe(whiteLabel);
    else expect(text).toBe(writeMarker(kind, payload));
    expect(parseMarkers(kind, text)).toEqual([payload]);
  });

  it.each(TABLE)('$kind: a forged marker by an untrusted author is ignored', ({ kind, payload, authors }) => {
    const text = writeMarker(kind, payload);
    const asUntrusted: LedgerComment[] = [{ body: text, author: 'untrusted' }];
    expect(readTrusted(kind, asUntrusted)).toEqual(authors === 'anyone' ? [payload] : []);
    expect(readTrusted(kind, [{ body: text, author: 'self' }])).toEqual([payload]);
    // `self` kinds also reject a merely trusted author; `trusted` kinds accept one.
    expect(readTrusted(kind, [{ body: text, author: 'trusted' }])).toEqual(authors === 'self' ? [] : [payload]);
  });

  it.each(TABLE)('$kind: strip-all removes it', ({ kind, payload }) => {
    const out = stripAllMarkers(`before\n${writeMarker(kind, payload)}\nafter`);
    expect(hasMarker(kind, out)).toBe(false);
    expect(out).not.toMatch(/<!--/);
  });
});

describe('merge-only payload', () => {
  it('escapes both HTML comment end forms in file names, and still round-trips', () => {
    const payload = { from: 'a1', to: 'b2', files: ['a-->.ts', 'b--!>.ts'] };
    const text = writeMarker('merge-only', payload);
    expect(text.slice(4, -3)).not.toMatch(/--!?>/);
    expect(parseMarkers('merge-only', text)).toEqual([payload]);
  });
});

describe('stripAllMarkers', () => {
  it.each(TABLE)('$kind: strips it with and without a space before -->', ({ kind, payload }) => {
    const text = writeMarker(kind, payload);
    for (const variant of [text, text.replace(/ -->$/, '-->')]) {
      expect(hasMarker(kind, variant)).toBe(true);
      const out = stripAllMarkers(`a\n${variant}\nb`);
      expect(hasMarker(kind, out)).toBe(false);
      expect(out).not.toMatch(/<!--/);
    }
  });

  it('strips an anywhere marker closed with no space, and keeps a longer name', () => {
    expect(stripAllMarkers('x <!--taskcell-lesson--> y <!-- taskcell-revision-cap--> z')).toBe('x  y  z');
    expect(stripAllMarkers('<!-- taskcell-lesson-more -->')).toBe('<!-- taskcell-lesson-more -->');
  });

  it('strips a declaration added later, with no other change', () => {
    const text = '<!-- taskcell-brand-new: 7 -->';
    expect(stripAllMarkers(text)).toBe(text);
    declareMarker({
      kind: 'brand-new',
      current: 'taskcell-brand-new',
      legacy: ['vanguard-brand-new'],
      anchor: 'anywhere',
      authors: 'trusted',
      tail: ':\\s*(\\d+)',
      render: (n: number) => `: ${n}`,
      parse: (g) => Number(g[0]),
    });
    expect(stripAllMarkers(`a ${text} b <!-- vanguard-brand-new: 8 -->`)).toBe('a  b ');
  });

  it('rejoins nothing: a marker split by another is removed once the inner one goes', () => {
    expect(stripAllMarkers(`<!-- taskcell-pr-review: <!-- taskcell-revision: ${SHA} -->${SHA} -->`)).not.toMatch(/taskcell-/);
  });

  it('drops an unclosed revision opener', () => {
    expect(hasMarker('revision', stripAllMarkers('x <!-- revision: oops'))).toBe(false);
  });
});

describe('questions', () => {
  const c = (body: string, author: LedgerComment['author'], createdAt?: string): LedgerComment => ({ body, author, ...(createdAt !== undefined ? { createdAt } : {}) });

  it('reviewed at this head', () => {
    expect(reviewedAtHead([c(writeMarker('pr-review', SHA), 'trusted')], SHA)).toBe(true);
    expect(reviewedAtHead([c(writeMarker('pr-review', SHA), 'untrusted')], SHA)).toBe(false);
    expect(reviewedAtHead([c(writeMarker('mr-review', SHA), 'trusted')], SHA, 'mr')).toBe(false);
    expect(reviewedAtHead([c(writeMarker('mr-review', SHA), 'self')], SHA, 'mr')).toBe(true);
  });

  it('incomplete attempts at this head', () => {
    const comments = [c(writeMarker('pr-review-incomplete', SHA), 'trusted'), c(writeMarker('pr-review-incomplete', SHA), 'untrusted'), c(writeMarker('pr-review-incomplete', 'other'), 'trusted')];
    expect(incompleteAttempts(comments, SHA)).toEqual({ attempts: 1, capPosted: false });
  });

  it('revision rounds since a reset, merge-only rounds not counted', () => {
    const comments = [
      c(writeMarker('revision', { head: 'a', mergeOnly: false }), 'trusted', '2030-01-01'),
      c(writeMarker('revision', { head: 'b', mergeOnly: false }), 'trusted', '2030-01-03'),
      c(writeMarker('revision', { head: 'c', mergeOnly: true }), 'trusted', '2030-01-04'),
      c(writeMarker('revision', { head: 'd', mergeOnly: false }), 'untrusted', '2030-01-05'),
    ];
    expect(revisionRounds(comments)).toBe(2);
    expect(revisionRounds(comments, '2030-01-02')).toBe(1);
    expect(lastMarkerAt('revision', comments)).toBe('2030-01-04');
  });

  it('dedupes on a trusted author’s identical marker, in either spelling', () => {
    const marker = writeMarker('approver', SHA);
    expect(containsTrustedMarker(marker, [c(`hi\n<!-- vanguard-approver: ${SHA} -->`, 'trusted')])).toBe(true);
    expect(containsTrustedMarker(marker, [c(marker, 'untrusted')])).toBe(false);
    expect(containsTrustedMarker(marker, [c(writeMarker('approver', 'other'), 'self')])).toBe(false);
  });

  it('a once-only stamp must be the last line and the only mention', () => {
    const stamp = writeMarker('pr-review-run', { sha: SHA, runId: '9' });
    expect(soleTrailingMarker('pr-review-run', `body\n\n${stamp}`)).toEqual({ sha: SHA, runId: '9' });
    expect(soleTrailingMarker('pr-review-run', `${stamp}\nbody`)).toBeUndefined();
    expect(soleTrailingMarker('pr-review-run', `quote ${stamp}\nbody\n${stamp}`)).toBeUndefined();
  });
});
