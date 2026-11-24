import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli spec', () => {
  it('parses --skills on the spec, revise and review commands (each runs an agent outside runSourcedIssue)', () => {
    const argvs = [
      ['spec', 'o/r#1'],
      ['revise-pr', 'o/r#7'],
      ['review-pr', 'o/r#7'],
      ['watch-prs', '--github-repo', 'o/r', '--label', 'l'],
      ['review-mr', '--mr', '5', '--gitlab-project', 'g/p'],
      ['watch-mrs', '--gitlab-project', 'g/p', '--label', 'l'],
    ];
    for (const argv of argvs) {
      expect(parseCli([...argv, '--skills', '/skills'], '/work')).toMatchObject({ kind: argv[0], skillsDir: '/skills' });
      expect('skillsDir' in parseCli(argv, '/work')).toBe(false);
    }
  });

  it('parses spec with --spec-model, --base, and --commit-author (white-label toggle)', () => {
    const cmd = parseCli(
      ['spec', 'o/r#1', '--spec-model', 'claude-fable-5', '--base', 'feat/allocation', '--commit-author', 'Sebastian Pietrzak <s@p.co>'],
      '/work',
    );
    expect(cmd.kind).toBe('spec');
    expect(cmd.kind === 'spec' && cmd.issueRef).toBe('o/r#1');
    expect(cmd.kind === 'spec' && cmd.specModel).toBe('claude-fable-5');
    expect(cmd.kind === 'spec' && cmd.baseBranch).toBe('feat/allocation');
    expect(cmd.kind === 'spec' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
  });

  it('omits spec baseBranch when --base is absent (defaults to main downstream)', () => {
    const cmd = parseCli(['spec', 'o/r#1'], '/work');
    expect(cmd.kind === 'spec' && cmd.baseBranch).toBeUndefined();
  });

  it('parses spec with a bare number and --github-repo, and returns help without a ref', () => {
    const cmd = parseCli(['spec', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind === 'spec' && cmd.repoSlug).toBe('o/r');
    expect(cmd.kind === 'spec' && cmd.issueRef).toBe('7');
    expect(parseCli(['spec'], '/work').kind).toBe('help');
  });

  it('parses spec --out and run --spec-file (local-file spec flow)', () => {
    const spec = parseCli(['spec', 'o/r#1', '--out', '.vanguard/specs/1.md'], '/work');
    expect(spec.kind === 'spec' && spec.out).toBe('.vanguard/specs/1.md');

    const run = parseCli(['run', '--github', 'o/r#1', '--spec-file', '.vanguard/specs/1.md'], '/work');
    expect(run.kind === 'run' && run.specFile).toBe('.vanguard/specs/1.md');
    const without = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(without.kind === 'run' && 'specFile' in without).toBe(false);

    // One spec file cannot describe N fan-out tasks.
    expect(parseCli(['run', '--project', '7', '--spec-file', 's.md'], '/work').kind).toBe('error');
    expect(parseCli(['run', '--linear', 'ABC-1', '--parent', '--spec-file', 's.md'], '/work').kind).toBe('error');
  });
});
