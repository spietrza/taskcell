import { describe, it, expect } from 'vitest';
import { corpusHash } from './corpus-hash.js';
import type { EvalCase } from './types.js';

const base: EvalCase[] = [
  { id: 'a', kind: 'control', input: 'i1', expectation: 'e1' },
  { id: 'b', kind: 'edge', input: 'i2' },
];

describe('corpusHash', () => {
  it('is stable for the same corpus', () => {
    expect(corpusHash(base)).toBe(corpusHash(base));
  });

  it('is order-independent', () => {
    expect(corpusHash(base)).toBe(corpusHash([...base].reverse()));
  });

  it('changes when a case input changes', () => {
    const changed: EvalCase[] = [{ ...base[0]!, input: 'different' }, base[1]!];
    expect(corpusHash(changed)).not.toBe(corpusHash(base));
  });

  it('changes when a case expectation changes', () => {
    const changed: EvalCase[] = [{ ...base[0]!, expectation: 'different' }, base[1]!];
    expect(corpusHash(changed)).not.toBe(corpusHash(base));
  });

  it('changes when a case is added or removed', () => {
    expect(corpusHash([...base, { id: 'c', kind: 'refusal', input: 'i3' }])).not.toBe(corpusHash(base));
  });

  it('is prefixed with sha256:', () => {
    expect(corpusHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
