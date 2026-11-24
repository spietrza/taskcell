import { describe, it, expect, assert } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli watch-mrs', () => {
  it('parses watch-mrs with required flags', () => {
    const cmd = parseCli(['watch-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'watch-mrs');
    expect(cmd.project).toBe('g/p');
    expect(cmd.label).toBe('ready for review');
    expect(cmd.reviewingLabel).toBe('taskcell::reviewing');
    expect(cmd.reviewedLabel).toBe('taskcell::reviewed');
  });
});
