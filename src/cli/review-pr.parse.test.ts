import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli review-pr', () => {
  it('parses --feedback-authors on review-pr', () => {
    expect(parseCli(['review-pr', 'o/r#1', '--feedback-authors', 'a, B'], '/work')).toMatchObject({ kind: 'review-pr', feedbackAuthors: ['a', 'B'] });
    expect(parseCli(['review-pr', 'o/r#1'], '/work')).not.toHaveProperty('feedbackAuthors');
  });

  it('parses review-pr with a GitHub PR URL', () => {
    expect(
      parseCli(['review-pr', 'https://github.com/o/r/pull/12', '--repo', '/work', '--provider', 'codex', '--review-model', 'gpt-5'], '/cwd'),
    ).toEqual({
      kind: 'review-pr',
      prRef: 'https://github.com/o/r/pull/12',
      repoPath: '/work',
      provider: 'codex',
      reviewModel: 'gpt-5',
      egress: false,
    });
  });

  it('parses review-pr with --github-pr and --github-repo', () => {
    expect(parseCli(['review-pr', '--github-pr', '12', '--github-repo', 'o/r', '--llm-proxy'], '/work')).toEqual({
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/work',
      egress: false,
      llmProxy: true,
    });
  });

  it('parses review-pr --out (write-to-file, no PR comment)', () => {
    const cmd = parseCli(['review-pr', 'o/r#12', '--review-model', 'claude-fable-5', '--out', '.vanguard/reviews/12.md'], '/work');
    expect(cmd.kind).toBe('review-pr');
    expect(cmd.kind === 'review-pr' && cmd.out).toBe('.vanguard/reviews/12.md');
    expect(cmd.kind === 'review-pr' && cmd.reviewModel).toBe('claude-fable-5');
    const without = parseCli(['review-pr', 'o/r#12'], '/work');
    expect(without.kind === 'review-pr' && 'out' in without).toBe(false);
  });

  it('accepts the PR ref via positional, --github-pr, or --github (parity with spec/run)', () => {
    expect(parseCli(['review-pr', 'o/r#12'], '/work')).toMatchObject({ kind: 'review-pr', prRef: 'o/r#12' });
    expect(parseCli(['review-pr', '--github-pr', '12', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'review-pr', prRef: '12' });
    expect(parseCli(['review-pr', '--github', 'o/r#12'], '/work')).toMatchObject({ kind: 'review-pr', prRef: 'o/r#12' });
    expect(parseCli(['review-pr'], '/work').kind).toBe('error');
  });
});
