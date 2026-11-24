import { describe, it, expect, assert } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli review-mr', () => {
  it('parses --max-turns on review-mr and review-pr, and omits it when absent', () => {
    const mr = parseCli(['review-mr', '--mr', '5', '--gitlab-project', 'g/p', '--max-turns', '48'], '/work');
    expect(mr.kind === 'review-mr' && mr.maxTurns).toBe(48);
    const pr = parseCli(['review-pr', 'o/r#7', '--max-turns', '48'], '/work');
    expect(pr.kind === 'review-pr' && pr.maxTurns).toBe(48);
    expect('maxTurns' in parseCli(['review-mr', '--mr', '5', '--gitlab-project', 'g/p'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['review-pr', 'o/r#7'], '/work')).toBe(false);
    const wm = parseCli(['watch-mrs', '--gitlab-project', 'g/p', '--label', 'l', '--max-turns', '48'], '/work');
    expect(wm.kind === 'watch-mrs' && wm.maxTurns).toBe(48);
    const wp = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'l', '--max-turns', '48'], '/work');
    expect(wp.kind === 'watch-prs' && wp.maxTurns).toBe(48);
  });

  it('clamps a huge --max-turns or --max-rounds to Number.MAX_SAFE_INTEGER', () => {
    const huge = parseCli(['review-mr', '--mr', '5', '--gitlab-project', 'g/p', '--max-turns', '1e308'], '/work');
    expect(huge.kind === 'review-mr' && huge.maxTurns).toBe(Number.MAX_SAFE_INTEGER);
    const rounds = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--max-rounds', '1e308'], '/work');
    expect(rounds.kind === 'revise-pr' && rounds.maxRounds).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('parseCli review-mr', () => {
  it('parses review-mr with --mr and --gitlab-project', () => {
    const cmd = parseCli(['review-mr', '--mr', '42', '--gitlab-project', 'owner/project'], '/repo');
    assert(cmd.kind === 'review-mr');
    expect(cmd.iid).toBe(42);
    expect(cmd.project).toBe('owner/project');
  });
});
