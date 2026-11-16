import { describe, it, expect } from 'vitest';
import { isPoolValue, parsePoolRows, formatPoolRows } from './modelPool';

describe('model pool rows', () => {
  it('round-trips a weighted pool', () => {
    const value = 'claude/sonnet:3, codex/gpt-5.6-sol:1';
    expect(isPoolValue(value)).toBe(true);
    expect(isPoolValue('sonnet')).toBe(false);
    expect(parsePoolRows(value)).toEqual([
      { provider: 'claude', model: 'sonnet', weight: 3 },
      { provider: 'codex', model: 'gpt-5.6-sol', weight: 1 },
    ]);
    expect(formatPoolRows(parsePoolRows(value))).toBe(value);
  });

  it('drops incomplete rows and keeps one row a pool', () => {
    expect(formatPoolRows([{ provider: 'codex', model: 'gpt-5.6-sol', weight: 0 }, { provider: '', model: 'x', weight: 1 }])).toBe('codex/gpt-5.6-sol:1');
    expect(formatPoolRows([])).toBeUndefined();
  });
});
