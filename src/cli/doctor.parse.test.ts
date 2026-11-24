import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli doctor', () => {
  it('carries every shared flag onto doctor except the stage-only three', () => {
    const argv = [
      'doctor', '--source', 'github', '--label', 'vanguard',
      '--provider', 'codex', '--review-provider', 'claude', '--fallback-provider', 'cursor', '--fallback-model', 'cursor-fast',
      '--provider-model', 'gpt-5', '--review-model', 'claude-opus', '--escalate-model', 'claude-fable-5',
      '--no-simplify', '--verify', 'pnpm test', '--visual-proof', 'pnpm shot', '--conformance', '--conformance-model', 'opus',
      '--commit-author', 'Seba <seba@example.com>', '--flow', 'flow-b', '--base', 'dev', '--max-turns', '80', '--max-repair-iterations', '5',
    ];
    const doctor = parseCli(argv, '/work');
    expect(doctor).toMatchObject({
      kind: 'doctor',
      provider: 'codex',
      reviewProvider: 'claude',
      fallbackProvider: 'cursor',
      fallbackModel: 'cursor-fast',
      providerModel: 'gpt-5',
      reviewModel: 'claude-opus',
      escalateModel: 'claude-fable-5',
      noSimplify: true,
      verifyCmd: 'pnpm test',
      commitAuthor: { name: 'Seba', email: 'seba@example.com' },
      flow: 'flow-b',
      baseBranch: 'dev',
      maxTurns: 80,
      maxRepairIterations: 5,
    });
    for (const key of ['visualProofCmd', 'conformance', 'conformanceModel']) expect(key in doctor).toBe(false);
  });

  it('parses doctor with --provider and --llm-proxy', () => {
    const cmd = parseCli(
      ['doctor', '--source', 'github', '--github-repo', 'o/r', '--provider', 'codex', '--llm-proxy'],
      '/work',
    );
    expect(cmd.kind).toBe('doctor');
    if (cmd.kind === 'doctor') {
      expect(cmd.provider).toBe('codex');
      expect(cmd.llmProxy).toBe(true);
    }
  });

  it('does not set llmProxy or provider on doctor without those flags (regression)', () => {
    const cmd = parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('doctor');
    expect('llmProxy' in cmd).toBe(false);
    expect((cmd as Extract<typeof cmd, { kind: 'doctor' }>).provider).toBeUndefined();
  });

  it('uses safe github loop-v1 defaults for a repo-only doctor command', () => {
    expect(parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'doctor',
      source: 'github',
      repoPath: '/work',
      repoSlug: 'o/r',
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
    });
  });

  it('uses safe linear loop-v1 defaults for doctor when --loop-v1 is supplied', () => {
    expect(parseCli(['doctor', '--loop-v1', '--team', 'TES'], '/work')).toEqual({
      kind: 'doctor',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
    });
  });

  it('does not leak visualProofCmd onto doctor', () => {
    const cmd = parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r', '--visual-proof', 'pnpm shot'], '/work');
    expect(cmd.kind).toBe('doctor');
    expect('visualProofCmd' in cmd).toBe(false);
  });

  it('parses --spec-only on doctor so preflight matches the spec-only watch', () => {
    const cmd = parseCli(['doctor', '--loop-v1', '--label', 'vanguard', '--agent-state', 'Spec Review', '--spec-only'], '/work');
    expect(cmd).toMatchObject({ kind: 'doctor', specOnly: true });
  });
});
