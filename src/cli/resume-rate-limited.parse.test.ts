import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli resume-rate-limited', () => {
  it('parses resume-rate-limited', () => {
    expect(parseCli(['resume-rate-limited', '--github-repo', 'o/r', '--dry-run'], '/work')).toEqual({ kind: 'resume-rate-limited', repoSlug: 'o/r', dryRun: true });
    expect(parseCli(['resume-rate-limited'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['resume-rate-limited', '--github-repo', 'o/r', '--trigger-labels', 'a, b'], '/work')).toMatchObject({ triggerLabels: ['a', 'b'] });
    expect(parseCli(['resume-rate-limited', '--github-repo', 'o/r', '--claimed-state', 'wip'], '/work')).toMatchObject({
      startedLabels: ['wip', 'taskcell:needs-human-review', 'taskcell:speccing'],
    });
  });
});
