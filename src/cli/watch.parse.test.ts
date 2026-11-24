import { describe, it, expect, assert } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli watch', () => {
  it('parses provider flags on watch too', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--provider', 'codex'], '/work');
    expect(cmd.kind === 'watch' && cmd.provider).toBe('codex');
  });

  it('rejects the run-only flags on watch and doctor instead of ignoring them', () => {
    for (const command of ['watch', 'doctor']) {
      const base = [command, '--source', 'linear', '--label', 'vanguard'];
      expect(parseCli([...base, '--spec-file', 's.md'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining(`${command} does not accept --spec-file`) });
      expect(parseCli([...base, '--fork', '3'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining(`${command} does not accept --fork;`) });
      expect(parseCli([...base, '--fork-scorer', 'llm'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining(`${command} does not accept --fork-scorer`) });
    }
    // The same flags are fine on run.
    expect(parseCli(['run', '--github', 'o/r#1', '--spec-file', 's.md', '--fork', '3', '--fork-scorer', 'llm'], '/work')).toMatchObject({ kind: 'run', specFile: 's.md', forkN: 3, forkScorer: 'llm' });
  });

  it('parses --max-turns and --max-repair-iterations on watch', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--github-repo', 'o/r', '--max-turns', '80', '--max-repair-iterations', '5'],
      '/work',
    );
    expect(cmd.kind === 'watch' && cmd.maxTurns).toBe(80);
    expect(cmd.kind === 'watch' && cmd.maxRepairIterations).toBe(5);
  });

  it('parses --provider-model and --review-model on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--provider-model', 'sonnet', '--review-model', 'haiku'], '/work');
    expect(cmd.kind === 'watch' && cmd.providerModel).toBe('sonnet');
    expect(cmd.kind === 'watch' && cmd.reviewModel).toBe('haiku');
  });

  it('parses a linear watch with defaults and a required label', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--team', 'TES'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('parses a valid --max-tasks on watch', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--max-tasks', '3'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      maxTasks: 3,
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('rejects a --max-tasks that is not a positive integer instead of processing everything', () => {
    for (const raw of ['soon', '0', '-2']) {
      const cmd = parseCli(['watch', '--label', 'vanguard', `--max-tasks=${raw}`], '/work');
      expect(cmd).toEqual({ kind: 'error', message: `--max-tasks needs a positive integer, got "${raw}".` });
    }
  });

  it('leaves maxTasks unset when --max-tasks is absent', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && cmd.maxTasks === undefined).toBe(true);
  });

  it('parses --issue on a github watch, running only that issue instead of the sweep', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--label', 'vanguard', '--issue', '42', '--once'], '/work');
    expect(cmd).toMatchObject({ kind: 'watch', source: 'github', issue: '42', once: true });
  });

  it('rejects --issue on a non-github watch source', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--issue', '42'], '/work')).toEqual({
      kind: 'error',
      message: 'watch --issue requires --source github.',
    });
  });

  it('accepts an owner/repo#n --issue that names the watched repo', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--label', 'vanguard', '--issue', 'o/r#42'], '/work');
    expect(cmd).toMatchObject({ kind: 'watch', issue: 'o/r#42' });
  });

  it('rejects an owner/repo#n --issue naming a repo other than --github-repo', () => {
    expect(parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--label', 'vanguard', '--issue', 'other/repo#42'], '/work')).toEqual({
      kind: 'error',
      message: 'watch --issue other/repo#42 names repo "other/repo", but --github-repo is "o/r"; the issue must live in the watched repo.',
    });
  });

  it('rejects an --issue that is not a positive number or owner/repo#n', () => {
    // `--issue=<ref>`: a bare `--issue -1` would be read as an unknown flag, not as a value.
    for (const ref of ['abc', '0', '-1', '12x', '#12']) {
      expect(parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--label', 'vanguard', `--issue=${ref}`], '/work')).toEqual({
        kind: 'error',
        message: `watch --issue expects a positive issue number or owner/repo#n, got "${ref}".`,
      });
    }
  });

  it('--issue implies --once: one named issue is not polled for again', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--label', 'vanguard', '--issue', '42'], '/work');
    expect(cmd.kind === 'watch' && cmd.once).toBe(true);
  });

  it('leaves issue unset when --issue is absent', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && cmd.issue === undefined).toBe(true);
  });

  it('parses a github watch with markers and interval', () => {
    expect(
      parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--claimed-state', 'wip', '--interval', '30', '--once'], '/work'),
    ).toEqual({
      kind: 'watch',
      source: 'github',
      label: 'vanguard',
      claimedState: 'wip',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 30000,
      once: true,
      egress: false,
    });
  });

  it('infers github source when --github-repo is supplied on watch', () => {
    const cmd = parseCli(['watch', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.source).toBe('github');
      expect(cmd.repoSlug).toBe('o/r');
    }
  });

  it('uses safe github loop-v1 defaults for a repo-only watch command', () => {
    expect(parseCli(['watch', '--source', 'github', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'watch',
      source: 'github',
      repoPath: '/work',
      repoSlug: 'o/r',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
    });
  });

  it('uses loop-v1 defaults with an explicit github ownership label', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--loop-v1', '--label', 'ai', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('ai');
      expect(cmd.specLabel).toBe('ready for spec');
      expect(cmd.agentLabel).toBe('ready for agent');
      expect(cmd.needsInfoLabel).toBe('needs info');
    }
  });

  it('uses safe linear loop-v1 defaults when --loop-v1 is supplied', () => {
    expect(parseCli(['watch', '--loop-v1', '--team', 'TES'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
    });
  });

  it('watch requires --label', () => {
    expect(parseCli(['watch'], '/work')).toMatchObject({
      kind: 'error',
      message: 'watch --source linear requires --label <name>.',
    });
  });

  it('parses --verify into verifyCmd on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--verify', 'npm test'], '/work');
    expect(cmd.kind === 'watch' && cmd.verifyCmd).toBe('npm test');
  });

  it('omits verifyCmd when --verify is not passed on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && 'verifyCmd' in cmd).toBe(false);
  });

  it('parses --visual-proof into visualProofCmd on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--visual-proof', 'npm shot'], '/work');
    expect(cmd.kind === 'watch' && cmd.visualProofCmd).toBe('npm shot');
  });

  it('omits visualProofCmd when --visual-proof is not passed on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && 'visualProofCmd' in cmd).toBe(false);
  });

  it('parses --conformance flags on watch but not doctor', () => {
    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--conformance', '--conformance-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.conformance).toBe(true);
    expect(watch.kind === 'watch' && watch.conformanceModel).toBe('opus');

    const doctor = parseCli(['doctor', '--source', 'github', '--label', 'vanguard', '--conformance'], '/work');
    expect(doctor.kind).toBe('doctor');
    expect('conformance' in doctor).toBe(false);
    expect('conformanceModel' in doctor).toBe(false);
  });

  it('rejects an unsafe or empty watch --base before any polling starts', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base=-dev'], '/work');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/Invalid base branch "-dev"/);
    const empty = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base='], '/work');
    expect(empty.kind === 'error' && empty.message).toMatch(/cannot be empty/);
  });

  // --- Loop v1 flag tests ---

  it('parses a github loop-v1 watch with spec/agent/needs-info labels and spec-model', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
        '--spec-model', 'haiku',
        '--github-repo', 'o/r',
      ],
      '/work',
    );
    expect(cmd).toEqual({
      kind: 'watch',
      source: 'github',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      specModel: 'haiku',
      repoSlug: 'o/r',
    });
  });

  it('parses a linear loop-v1 watch with spec-state/spec-state-name/needs-info-state and spec-model', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--spec-model', 'haiku',
        '--trigger-state', 'unstarted',
      ],
      '/work',
    );
    expect(cmd).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
      specModel: 'haiku',
      triggerState: 'unstarted',
    });
  });

  it('omits all loop-v1 fields when their flags are absent (existing watch parse unchanged)', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--team', 'TES'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specLabel' in cmd).toBe(false);
      expect('agentLabel' in cmd).toBe(false);
      expect('needsInfoLabel' in cmd).toBe(false);
      expect('specState' in cmd).toBe(false);
      expect('specStateName' in cmd).toBe(false);
      expect('agentState' in cmd).toBe(false);
      expect('needsInfoState' in cmd).toBe(false);
      expect('specModel' in cmd).toBe(false);
    }
  });

  it('parses --agent-state on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--agent-state', 'Ready',
      ],
      '/work',
    );
    if (cmd.kind !== 'watch') throw new Error('expected watch');
    expect(cmd.agentState).toBe('Ready');
  });

  it('returns an error when a github loop-v1 flag is supplied on --source linear', () => {
    expect(
      parseCli(['watch', '--source', 'linear', '--spec-label', 'ready for spec'], '/work'),
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('GitHub loop-v1 flags'),
    });
  });

  it('defaults github loop-v1 agent label when --agent-label is missing', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--spec-label', 'ready for spec', '--needs-info-label', 'needs info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
      expect(cmd.agentLabel).toBe('ready for agent');
    }
  });

  it('defaults github loop-v1 needs-info label when --needs-info-label is missing', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--spec-label', 'ready for spec', '--agent-label', 'ready for agent'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
      expect(cmd.needsInfoLabel).toBe('needs info');
    }
  });

  it('defaults linear loop-v1 spec state name when --spec-state-name is missing', () => {
    const cmd = parseCli(
      ['watch', '--label', 'vanguard', '--spec-state', 'triage', '--needs-info-state', 'Needs Info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specStateName).toBe('Spec');
    }
  });

  it('defaults linear loop-v1 needs-info state when --needs-info-state is missing', () => {
    const cmd = parseCli(
      ['watch', '--label', 'vanguard', '--spec-state', 'triage', '--spec-state-name', 'Spec'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.needsInfoState).toBe('Needs Info');
    }
  });

  it('defaults linear loop-v1 ownership label when --label is missing', () => {
    const cmd = parseCli(
      ['watch', '--spec-state', 'triage', '--spec-state-name', 'Spec', '--needs-info-state', 'Needs Info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('vanguard');
    }
  });

  it('returns an error when loop-v1 is attempted on project source', () => {
    expect(
      parseCli(
        ['watch', '--source', 'project', '--project', '7', '--spec-state', 'triage', '--spec-state-name', 'Spec', '--needs-info-state', 'Needs Info'],
        '/work',
      ),
    ).toMatchObject({
      kind: 'error',
      message: 'loop-v1 is not supported with --source project.',
    });
  });

  // --- FIX 1: --label as ownership filter for github loop-v1 ---

  it('parses --label into github loop-v1 when supplied alongside spec/agent/needs-info flags', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--label', 'vanguard',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('vanguard');
      expect(cmd.specLabel).toBe('ready for spec');
      expect(cmd.agentLabel).toBe('ready for agent');
    }
  });

  it('omits github loop-v1 ownership label when --label is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
    }
  });

  // --- FIX 2: --spec-claimed-state and --spec-claimed-label flags ---

  it('parses --spec-claimed-state on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--spec-claimed-state', 'Analyzing',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specClaimedState).toBe('Analyzing');
    }
  });

  it('omits specClaimedState when --spec-claimed-state is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specClaimedState' in cmd).toBe(false);
    }
  });

  it('parses --spec-claimed-label on github loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
        '--spec-claimed-label', 'wip:speccing',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specClaimedLabel).toBe('wip:speccing');
    }
  });

  it('omits specClaimedLabel when --spec-claimed-label is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specClaimedLabel' in cmd).toBe(false);
    }
  });

  // --- --spec-only: spec pass without the agent pass ---

  it('parses --spec-only with --once on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'ready-for-agent',
        '--team', 'DEV',
        '--once',
        '--spec-only',
        '--spec-state', 'triage',
        '--spec-state-name', 'Triage',
        '--agent-state', 'Spec Review',
        '--needs-info-state', 'Needs Info',
      ],
      '/work',
    );
    expect(cmd).toMatchObject({ kind: 'watch', source: 'linear', once: true, specOnly: true, agentState: 'Spec Review' });
  });

  it('parses --spec-only on github loop-v1 defaults with a review label', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--agent-label', 'spec review', '--spec-only'], '/work');
    expect(cmd).toMatchObject({ kind: 'watch', source: 'github', specLabel: 'ready for spec', agentLabel: 'spec review', specOnly: true, once: false });
  });

  const linearTargetError =
    'watch --spec-only requires --agent-state <review state> other than "Todo"; that default is the build trigger, so specced issues would get no review window.';
  const labelTargetError =
    'watch --spec-only requires --agent-label <review label> other than "ready for agent"; that default is the build trigger, so specced issues would get no review window.';

  it.each([
    ['linear', ['--loop-v1', '--label', 'vanguard'], linearTargetError],
    ['github', ['--source', 'github', '--github-repo', 'o/r'], labelTargetError],
    ['gitlab', ['--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1'], labelTargetError],
  ])('rejects --spec-only on %s without an explicit review target', (_name, args, message) => {
    expect(parseCli(['watch', ...args, '--once', '--spec-only'], '/work')).toEqual({ kind: 'error', message });
  });

  it.each([
    ['linear', ['--loop-v1', '--label', 'vanguard', '--agent-state', ' todo'], linearTargetError],
    ['github', ['--source', 'github', '--github-repo', 'o/r', '--agent-label', 'Ready for agent'], labelTargetError],
  ])('rejects --spec-only on %s when the review target is the default build trigger given explicitly', (_name, args, message) => {
    expect(parseCli(['watch', ...args, '--once', '--spec-only'], '/work')).toEqual({ kind: 'error', message });
  });

  it('omits specOnly when --spec-only is absent', () => {
    const cmd = parseCli(['watch', '--loop-v1', '--label', 'vanguard', '--once'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specOnly' in cmd).toBe(false);
    }
  });

  it('returns an error when --spec-only is used without loop-v1', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--once', '--spec-only'], '/work')).toEqual({
      kind: 'error',
      message: 'watch --spec-only requires loop-v1, which any loop-v1 flag turns on (for example --loop-v1, --spec-state or --spec-label); single-pass watch has no spec pass.',
    });
  });

  it('returns an error when --spec-only advances to the spec trigger state, ignoring case', () => {
    expect(
      parseCli(['watch', '--loop-v1', '--label', 'vanguard', '--spec-state-name', 'Spec', '--agent-state', 'spec', '--spec-only'], '/work'),
    ).toEqual({
      kind: 'error',
      message: 'watch --spec-only cannot advance specced issues into the spec trigger state "Spec"; set --agent-state to another state, or the spec pass specs the same issues again on every poll.',
    });
  });

  it('rejects --spec-only with an --agent-state matching the default spec state name in another case', () => {
    expect(parseCli(['watch', '--loop-v1', '--label', 'vanguard', '--agent-state', ' SPEC ', '--spec-only'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--spec-only cannot advance specced issues into the spec trigger state "Spec"'),
    });
  });

  it.each([
    ['github', ['--source', 'github', '--github-repo', 'o/r']],
    ['gitlab', ['--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard']],
  ])('rejects --spec-only on %s when --agent-label is the spec trigger label, ignoring case', (_name, sourceArgs) => {
    expect(parseCli(['watch', ...sourceArgs, '--spec-label', 'Ready', '--agent-label', 'ready', '--once', '--spec-only'], '/work')).toEqual({
      kind: 'error',
      message: 'watch --spec-only cannot advance specced issues into the spec trigger label "Ready"; set --agent-label to another label, or the spec pass specs the same issues again on every poll.',
    });
  });

  it.each(['watch', 'doctor'])('applies the spec trigger guard to %s only with --spec-only', (kind) => {
    const args = [kind, '--loop-v1', '--label', 'vanguard', '--agent-state', 'Spec'];
    expect(parseCli(args, '/work')).toMatchObject({ kind, agentState: 'Spec' });
    expect(parseCli([...args, '--spec-only'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining(`${kind} --spec-only cannot advance specced issues into the spec trigger state "Spec"`),
    });
  });

  it('returns an error when --spec-only is used on the project source', () => {
    expect(parseCli(['watch', '--source', 'project', '--project', '7', '--spec-only'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--spec-only requires loop-v1'),
    });
  });
});

describe('parseCli watch gitlab', () => {
  it('parses --spec-only on gitlab loop-v1', () => {
    const cmd = parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1', '--agent-label', 'spec review', '--once', '--spec-only'], '/repo');
    expect(cmd).toMatchObject({ kind: 'watch', source: 'gitlab', specLabel: 'ready for spec', once: true, specOnly: true });
  });

  it('rejects --spec-only on single-pass gitlab watch', () => {
    expect(parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--spec-only'], '/repo')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--spec-only requires loop-v1'),
    });
  });

  it('parses --source gitlab with --gitlab-project', () => {
    const cmd = parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'owner/project', '--label', 'vanguard'], '/repo');
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.project).toBe('owner/project');
    expect(cmd.label).toBe('vanguard');
  });

  it('parses --source gitlab with loop-v1 flags', () => {
    const cmd = parseCli(
      ['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard',
       '--spec-label', 'ready for spec', '--agent-label', 'ready for agent', '--needs-info-label', 'needs info'],
      '/repo',
    );
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.specLabel).toBe('ready for spec');
    expect(cmd.agentLabel).toBe('ready for agent');
    expect(cmd.needsInfoLabel).toBe('needs info');
  });

  it('parses --source gitlab --loop-v1 with defaults', () => {
    const cmd = parseCli(
      ['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1'],
      '/repo',
    );
    assert(cmd.kind === 'watch');
    expect(cmd.specLabel).toBe('ready for spec');
    expect(cmd.agentLabel).toBe('ready for agent');
    expect(cmd.needsInfoLabel).toBe('needs info');
  });
});
