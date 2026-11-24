import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli approve', () => {
  it('parses approve --pr with --github-repo and an optional --mode, and rejects a non-numeric --pr', () => {
    expect(parseCli(['approve', '--pr', '7', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'approve', prNumber: 7, repoSlug: 'o/r', repoPath: '/work', mode: 'shadow', json: false, dryRun: false,
    });
    expect(parseCli(['approve', '7', '--github-repo', 'o/r', '--mode', 'shadow'], '/work')).toMatchObject({ prNumber: 7, mode: 'shadow' });
    expect(parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--repo', '/r', '--branch', 'b', '--json', '--dry-run'], '/work')).toMatchObject({
      repoPath: '/r', branch: 'b', json: true, dryRun: true,
    });
    expect(parseCli(['approve', '--pr', '7', '--github-repo', 'o/r'], '/work')).not.toHaveProperty('branch');

    for (const pr of ['abc', '0', '1.5', '']) {
      const bad = parseCli(['approve', '--pr', pr, '--github-repo', 'o/r'], '/work');
      expect(bad.kind === 'error' && bad.message).toMatch(/approve requires a positive --pr/);
    }
    const noPr = parseCli(['approve', '--github-repo', 'o/r'], '/work');
    expect(noPr.kind === 'error' && noPr.message).toMatch(/approve requires a positive --pr/);
    const noRepo = parseCli(['approve', '--pr', '7'], '/work');
    expect(noRepo.kind === 'error' && noRepo.message).toMatch(/approve requires --github-repo/);
    // The run pin is gone (the verdict is bound to the stamped head SHA instead): the flag no longer parses as an approve command.
    // It is refused by name (non-zero exit), not answered with help and a green exit.
    const leftover = parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--review-run-id', '42'], '/work');
    expect(leftover.kind === 'error' && leftover.message).toMatch(/--review-run-id was removed/);
    const act = parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--mode', 'act'], '/work');
    expect(act.kind === 'approve' && act.mode).toBe('act');
    const live = parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--mode', 'live'], '/work');
    expect(live.kind === 'error' && live.message).toMatch(/unknown --mode "live"/);
    const unknownMode = parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--mode', 'loud'], '/work');
    expect(unknownMode.kind === 'error' && unknownMode.message).toMatch(/unknown --mode "loud"/);
  });
});
