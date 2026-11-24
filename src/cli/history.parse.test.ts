import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('history command', () => {
  it('parses owner/repo#N', () => {
    expect(parseCli(['history', 'o/r#7', '--json'], '/w')).toMatchObject({ kind: 'history', repoSlug: 'o/r', issue: 7, json: true, offline: false });
  });
  it('rejects a bare number', () => {
    expect(parseCli(['history', '7'], '/w')).toMatchObject({ kind: 'error' });
  });
});
