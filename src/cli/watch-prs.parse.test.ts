import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli watch-prs', () => {
  it('parses --feedback-authors on watch-prs (PR-author allowlist) and omits it by default', () => {
    const wp = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'l', '--feedback-authors', 'a, B'], '/work');
    expect(wp.kind === 'watch-prs' && wp.feedbackAuthors).toEqual(['a', 'B']);
    expect('feedbackAuthors' in parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'l'], '/work')).toBe(false);
  });

  it('parses watch-prs with label routing defaults', () => {
    expect(
      parseCli(
        [
          'watch-prs',
          '--github-repo', 'o/r',
          '--label', 'ready for taskcell review',
          '--provider', 'codex',
          '--review-model', 'gpt-5',
          '--interval', '15',
          '--concurrency', '1',
          '--once',
          '--egress',
        ],
        '/work',
      ),
    ).toEqual({
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
      concurrency: 1,
      intervalMs: 15000,
      once: true,
      egress: true,
      provider: 'codex',
      reviewModel: 'gpt-5',
    });
  });

  it('parses custom watch-prs state labels', () => {
    expect(
      parseCli(
        [
          'watch-prs',
          '--github-repo', 'o/r',
          '--label', 'needs review',
          '--reviewing-label', 'robot:reviewing',
          '--reviewed-label', 'robot:reviewed',
        ],
        '/work',
      ),
    ).toEqual({
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'needs review',
      reviewingLabel: 'robot:reviewing',
      reviewedLabel: 'robot:reviewed',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('parses watch-prs with an author filter', () => {
    const cmd = parseCli(
      [
        'watch-prs',
        '--github-repo', 'o/r',
        '--label', 'ready for taskcell review',
        '--author', 'SebaBoler',
      ],
      '/work',
    );
    expect(cmd).toMatchObject({ kind: 'watch-prs', author: 'SebaBoler' });
  });

  it('omits the author filter when --author is not given', () => {
    const cmd = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x'], '/work');
    expect(cmd.kind).toBe('watch-prs');
    expect((cmd as Extract<typeof cmd, { kind: 'watch-prs' }>).author).toBeUndefined();
  });

  it('requires watch-prs to have an explicit repo and trigger label', () => {
    expect(parseCli(['watch-prs', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['watch-prs', '--label', 'ready for taskcell review'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses watch-prs --pr as a pinned PR number', () => {
    const cmd = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pr', '316'], '/work');
    expect(cmd).toMatchObject({ kind: 'watch-prs', pr: 316 });
    expect(cmd).not.toHaveProperty('pinnedOnly');
    expect(parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pinned-only'], '/work')).toMatchObject({ kind: 'watch-prs', pinnedOnly: true });
  });

  it('rejects a watch-prs --pr that is not a positive PR number', () => {
    expect(parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pr', 'abc'], '/work')).toMatchObject({
      kind: 'error',
    });
    expect(parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pr', '0'], '/work')).toMatchObject({
      kind: 'error',
    });
  });
});
