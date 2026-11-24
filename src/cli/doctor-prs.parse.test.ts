import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli doctor-prs', () => {
  it('parses doctor-prs with PR review label defaults', () => {
    expect(parseCli(['doctor-prs', '--github-repo', 'o/r', '--label', 'ready for taskcell review'], '/work')).toEqual({
      kind: 'doctor-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'ready for taskcell review',
      reviewingLabel: 'taskcell:reviewing',
      reviewedLabel: 'taskcell:reviewed',
    });
  });

  it('requires doctor-prs to have an explicit repo and trigger label', () => {
    expect(parseCli(['doctor-prs', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['doctor-prs', '--label', 'ready for taskcell review'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses doctor-prs with --provider and --llm-proxy', () => {
    const cmd = parseCli(
      ['doctor-prs', '--github-repo', 'o/r', '--label', 'ready for taskcell review', '--provider', 'codex', '--llm-proxy'],
      '/work',
    );
    expect(cmd.kind).toBe('doctor-prs');
    if (cmd.kind === 'doctor-prs') {
      expect(cmd.provider).toBe('codex');
      expect(cmd.llmProxy).toBe(true);
    }
  });
});
