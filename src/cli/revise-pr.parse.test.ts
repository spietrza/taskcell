import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli revise-pr', () => {
  it('parses revise-pr --provider-model (absent when the flag is not given)', () => {
    const cmd = parseCli(['revise-pr', '12', '--github-repo', 'o/r', '--provider-model', 'sonnet'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.providerModel).toBe('sonnet');
    const bare = parseCli(['revise-pr', '12', '--github-repo', 'o/r'], '/work');
    expect(bare.kind === 'revise-pr' && 'providerModel' in bare).toBe(false);
  });

  it('parses revise-pr with --commit-author (white-label) and the --github alias', () => {
    const cmd = parseCli(
      ['revise-pr', '--github', 'o/r#12', '--review-model', 'claude-fable-5', '--commit-author', 'Sebastian Pietrzak <s@p.co>'],
      '/work',
    );
    expect(cmd.kind).toBe('revise-pr');
    expect(cmd.kind === 'revise-pr' && cmd.prRef).toBe('o/r#12');
    expect(cmd.kind === 'revise-pr' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
    const without = parseCli(['revise-pr', 'o/r#12'], '/work');
    expect(without.kind === 'revise-pr' && 'commitAuthor' in without).toBe(false);
  });

  it('parses revise-pr --fallback-provider / --fallback-model, and rejects the same bad combinations as run', () => {
    const cmd = parseCli(['revise-pr', 'o/r#12', '--provider', 'claude', '--fallback-provider', 'codex', '--fallback-model', 'gpt-6-sol'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.fallbackProvider).toBe('codex');
    expect(cmd.kind === 'revise-pr' && cmd.fallbackModel).toBe('gpt-6-sol');
    const without = parseCli(['revise-pr', 'o/r#12'], '/work');
    expect(without.kind === 'revise-pr' && 'fallbackProvider' in without).toBe(false);
    expect(parseCli(['revise-pr', 'o/r#12', '--fallback-provider', 'bogus'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown fallback-provider "bogus"') });
    expect(parseCli(['revise-pr', 'o/r#12', '--fallback-model', 'x'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('--fallback-model needs --fallback-provider') });
    expect(parseCli(['revise-pr', 'o/r#12', '--provider', 'claude', '--fallback-provider', 'openrouter'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Implementer fallback cannot mix') });
  });

  it('parses revise-pr --out (dry-run to a file)', () => {
    const cmd = parseCli(['revise-pr', 'o/r#12', '--out', '.vanguard/revisions/12.md'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.out).toBe('.vanguard/revisions/12.md');
    const without = parseCli(['revise-pr', 'o/r#12'], '/work');
    expect(without.kind === 'revise-pr' && 'out' in without).toBe(false);
  });

  it('T26: parses feedback authors consistently and preserves first spelling', () => {
    for (const argv of [['revise-pr', 'o/r#1'], ['run', '--github', 'o/r#1'], ['watch', '--source', 'github', '--label', 'vanguard']]) {
      expect(parseCli([...argv, '--feedback-authors', 'a, b ,A,,'], '/work')).toMatchObject({ feedbackAuthors: ['a', 'b'] });
      expect(parseCli(argv, '/work')).not.toHaveProperty('feedbackAuthors');
      // An empty/separator-only value (the workflow passing through an empty allowed-actors) is the
      // same as not passing the flag — never an empty allowlist.
      for (const empty of ['', ' , ']) expect(parseCli([...argv, '--feedback-authors', empty], '/work')).not.toHaveProperty('feedbackAuthors');
    }
  });
});

describe('parseCli revise-pr', () => {
  it('parses a bare PR number with --github-repo', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd).toEqual({
      kind: 'revise-pr',
      prRef: '7',
      repoSlug: 'o/r',
      repoPath: '/work',
      egress: false,
    });
  });

  it('parses --github-pr as an alternative to positional', () => {
    const cmd = parseCli(['revise-pr', '--github-pr', '42', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('revise-pr');
    if (cmd.kind === 'revise-pr') expect(cmd.prRef).toBe('42');
  });

  it('returns help when the PR ref is missing', () => {
    expect(parseCli(['revise-pr'], '/work').kind).toBe('help');
  });

  it('parses --max-rounds', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--max-rounds', '3'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.maxRounds).toBe(3);
  });

  it('omits maxRounds when --max-rounds is not passed', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind === 'revise-pr' && 'maxRounds' in cmd).toBe(false);
  });

  it('parses --llm-proxy', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--llm-proxy'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.llmProxy).toBe(true);
  });

  it('parses --review-model', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--review-model', 'sonnet'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.reviewModel).toBe('sonnet');
  });

  it('parses a GitHub PR URL', () => {
    const cmd = parseCli(['revise-pr', 'https://github.com/o/r/pull/99'], '/work');
    expect(cmd.kind).toBe('revise-pr');
    if (cmd.kind === 'revise-pr') {
      expect(cmd.prRef).toBe('https://github.com/o/r/pull/99');
    }
  });
});

describe('revise-pr on a GitLab MR', () => {
  it('carries --gitlab-project', async () => {
    const { parseCli } = await import('./args.js');
    expect(parseCli(['revise-pr', '3', '--gitlab-project', 'g/p'], '/work')).toMatchObject({ kind: 'revise-pr', prRef: '3', gitlabProject: 'g/p' });
  });
});
