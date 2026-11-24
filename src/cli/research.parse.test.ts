import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli research', () => {
  it('parses --commit-author on research (white-label toggle)', () => {
    const cmd = parseCli(['research', 'o/r#1', '--commit-author', 'Sebastian Pietrzak <s@p.co>'], '/work');
    expect(cmd.kind).toBe('research');
    expect(cmd.kind === 'research' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
  });
});
