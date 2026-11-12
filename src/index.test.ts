import { describe, expect, it } from 'vitest';
import { taskcell, vanguard } from './index.js';

describe('package exports', () => {
  it('keeps the deprecated vanguard namespace as an alias of taskcell', () => {
    expect(vanguard).toBe(taskcell);
    expect(vanguard.run).toBe(taskcell.run);
  });
});
