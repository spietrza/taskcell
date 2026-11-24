import { describe, it, expect, assert } from 'vitest';
import { parseCli } from './args.js';
import type { SharedRunOptions } from './flags.js';

describe('parseCli run', () => {
  it('parses a linear run with parent fan-out', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--parent', '--skills', '/s', '--concurrency', '3'], '/work')).toEqual({
      kind: 'run',
      source: 'linear',
      id: 'TES-1',
      parent: true,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 3,
      skillsDir: '/s',
    });
  });

  it('parses a github run with an explicit repo slug and defaults', () => {
    expect(parseCli(['run', '--github', 'o/r#5', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'run',
      source: 'github',
      id: 'o/r#5',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
      repoSlug: 'o/r',
    });
  });

  it('parses a project run with a label filter', () => {
    expect(parseCli(['run', '--project', '7', '--github-repo', 'o/r', '--label', 'todo'], '/work')).toEqual({
      kind: 'run',
      source: 'project',
      id: '7',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
      repoSlug: 'o/r',
      label: 'todo',
    });
  });

  it('parses --gc-before', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--gc-before'], '/work');
    expect(cmd.kind === 'run' && cmd.gcBefore).toBe(true);
  });

  it('parses --reuse', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--reuse'], '/work');
    expect(cmd.kind === 'run' && cmd.reuse).toBe(true);
  });

  it('omits reuse when --reuse is not passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'reuse' in cmd).toBe(false);
  });

  it('parses --llm-proxy into llmProxy', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--llm-proxy'], '/work');
    expect(cmd.kind === 'run' && cmd.llmProxy).toBe(true);
  });

  it('omits llmProxy when --llm-proxy is not passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'llmProxy' in cmd).toBe(false);
  });

  it('parses --provider and --review-provider (cross-provider review)', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--review-provider', 'codex'], '/work');
    expect(cmd.kind === 'run' && cmd.provider).toBe('claude');
    expect(cmd.kind === 'run' && cmd.reviewProvider).toBe('codex');
  });

  it('validates --usage-cap and returns it on the command without touching process.env', () => {
    delete process.env['TASKCELL_USAGE_CAP_PCT'];
    expect(parseCli(['run', '--linear', 'TES-1', '--usage-cap', '0'], '/work').kind).toBe('error');
    expect(parseCli(['run', '--linear', 'TES-1', '--usage-cap', '80'], '/work')).toMatchObject({ kind: 'run', usageCapPct: '80' });
    expect(process.env['TASKCELL_USAGE_CAP_PCT']).toBeUndefined();
  });

  it('accepts model pools on --provider-model/--review-model/--escalate-model and refuses bad ones', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--provider-model', 'claude/sonnet:3, codex/gpt-5.6-sol:1', '--review-model', 'codex/gpt-5.6-sol:1'], '/work');
    expect(run).toMatchObject({ kind: 'run', providerModel: 'claude/sonnet:3, codex/gpt-5.6-sol:1', reviewModel: 'codex/gpt-5.6-sol:1' });
    expect(parseCli(['run', '--linear', 'TES-1', '--provider-model', 'openrouter/auto'], '/work')).toMatchObject({ kind: 'run', providerModel: 'openrouter/auto' });
    expect(parseCli(['run', '--linear', 'TES-1', '--provider-model', 'claude/sonnet:0'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('positive integer weight') });
    expect(parseCli(['run', '--linear', 'TES-1', '--escalate-model', 'sonnet:2'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('provider/model[:weight]') });
    expect(parseCli(['revise-pr', '1', '--provider-model', 'Bad!/x:1'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('unknown provider') });
  });

  it('accepts a --fallback-provider list and refuses an unknown entry in it', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-provider', 'codex,cursor', '--fallback-model', 'gpt-5.6-sol,'], '/work')).toMatchObject({ kind: 'run', fallbackProvider: 'codex,cursor' });
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-provider', 'codex,bogus'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown fallback-provider "bogus"') });
  });

  it('parses --fallback-provider / --fallback-model on run and watch, and rejects an unknown one or a model without a provider', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--fallback-provider', 'codex', '--fallback-model', 'gpt-5.6-sol'], '/work');
    expect(run.kind === 'run' && run.fallbackProvider).toBe('codex');
    expect(run.kind === 'run' && run.fallbackModel).toBe('gpt-5.6-sol');
    const watch = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--fallback-provider', 'codex'], '/work');
    expect(watch.kind === 'watch' && watch.fallbackProvider).toBe('codex');
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-provider', 'bogus'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown fallback-provider "bogus"') });
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-model', 'x'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('--fallback-model needs --fallback-provider') });
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-provider', 'codex', '--fork', '3'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('does not apply to --fork') });
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--fallback-provider', 'openrouter'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Implementer fallback cannot mix') });
  });

  it('omits provider fields when the flags are absent', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'provider' in cmd).toBe(false);
    expect(cmd.kind === 'run' && 'reviewProvider' in cmd).toBe(false);
  });

  it('parses --fork into forkN (>=2)', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--fork', '3'], '/work');
    expect(cmd.kind === 'run' && cmd.forkN).toBe(3);
  });

  it('ignores --fork below 2 or non-numeric', () => {
    expect('forkN' in parseCli(['run', '--linear', 'TES-1', '--fork', '1'], '/work')).toBe(false);
    expect('forkN' in parseCli(['run', '--linear', 'TES-1', '--fork', 'x'], '/work')).toBe(false);
  });

  // S6 churn: run/watch/doctor --provider relaxes to the name grammar (repo customs are legal and
  // only dispatch can read app.json). A grammar-VALID unknown name now parses through and fails at
  // dispatch listing built-ins + customs; grammar-invalid names and every other command still fail
  // right here. --review-provider stays closed-set everywhere.
  it('parses a grammar-valid non-built-in provider through for run/watch/doctor (resolved at dispatch)', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'gpt'], '/work')).toMatchObject({
      kind: 'run',
      provider: 'gpt',
    });
    expect(parseCli(['watch', '--source', 'github', '--label', 'x', '--provider', 'my-proxy'], '/work')).toMatchObject({
      kind: 'watch',
      provider: 'my-proxy',
    });
  });

  it('still rejects grammar-invalid providers, custom names on other commands, and unknown review-providers at parse', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'GPT'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown provider "GPT"'),
    });
    expect(parseCli(['review-pr', '1', '--provider', 'my-proxy'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown provider "my-proxy"'),
    });
    expect(parseCli(['run', '--linear', 'TES-1', '--review-provider', 'bard'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown review-provider "bard"'),
    });
  });

  it('returns an error when implement and review providers share a transport', () => {
    expect(
      parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--review-provider', 'zai'], '/work'),
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('transport'),
    });
  });

  it('parses --escalate-model on run and watch', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--escalate-model', 'claude-fable-5'], '/work');
    expect(run.kind === 'run' && run.escalateModel).toBe('claude-fable-5');
    const watch = parseCli(['watch', '--label', 'vanguard', '--escalate-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.escalateModel).toBe('opus');
    const bare = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(bare.kind === 'run' && 'escalateModel' in bare).toBe(false);
  });

  it('parses --fork-scorer on run, rejects it on watch and rejects unknown values', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--fork', '3', '--fork-scorer', 'decision'], '/work');
    expect(run.kind === 'run' && run.forkScorer).toBe('decision');
    const watch = parseCli(['watch', '--label', 'vanguard', '--fork-scorer', 'llm'], '/work');
    expect(watch.kind === 'error' && watch.message).toMatch(/watch does not accept --fork-scorer/);
    const bare = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(bare.kind === 'run' && 'forkScorer' in bare).toBe(false);
    const bad = parseCli(['run', '--linear', 'TES-1', '--fork-scorer', 'coin'], '/work');
    expect(bad.kind === 'error' && bad.message).toMatch(/--fork-scorer expects llm or decision/);
    const noFork = parseCli(['run', '--linear', 'TES-1', '--fork-scorer', 'decision'], '/work');
    expect(noFork.kind === 'error' && noFork.message).toMatch(/only applies with --fork/);
  });

  it('parses the shared RunOptions flags identically on run and watch (one parseRunOptions)', () => {
    const shared = [
      '--provider', 'codex', '--review-provider', 'claude', '--fallback-provider', 'cursor', '--fallback-model', 'cursor-fast',
      '--provider-model', 'gpt-5', '--review-model', 'claude-opus', '--escalate-model', 'claude-fable-5',
      '--no-simplify', '--verify', 'pnpm test', '--visual-proof', 'pnpm shot', '--conformance', '--conformance-model', 'opus',
      '--commit-author', 'Seba <seba@example.com>', '--flow', 'flow-b', '--base', 'dev', '--max-turns', '80', '--max-repair-iterations', '5',
      '--skills', '/skills', '--feedback-authors', 'maintainer', '--pnpm-store',
    ];
    // Required<>: a RunOptions field added without an entry here fails to compile, as it does in parseRunOptions.
    // --plan is asserted separately because it excludes --flow.
    const expected: Required<Omit<SharedRunOptions, 'plan'>> = {
      provider: 'codex',
      reviewProvider: 'claude',
      fallbackProvider: 'cursor',
      fallbackModel: 'cursor-fast',
      providerModel: 'gpt-5',
      reviewModel: 'claude-opus',
      escalateModel: 'claude-fable-5',
      noSimplify: true,
      verifyCmd: 'pnpm test',
      visualProofCmd: 'pnpm shot',
      conformance: true,
      conformanceModel: 'opus',
      commitAuthor: { name: 'Seba', email: 'seba@example.com' },
      flow: 'flow-b',
      baseBranch: 'dev',
      maxTurns: 80,
      maxRepairIterations: 5,
      skillsDir: '/skills',
      feedbackAuthors: ['maintainer'],
      pnpmStore: true,
    };
    const run = parseCli(['run', '--github', 'o/r#1', ...shared], '/work');
    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', ...shared], '/work');
    expect(run).toMatchObject({ kind: 'run', ...expected });
    expect(watch).toMatchObject({ kind: 'watch', ...expected });
    for (const key of Object.keys(expected)) {
      expect(watch[key as keyof typeof watch]).toEqual(run[key as keyof typeof run]);
    }
    expect(parseCli(['run', '--github', 'o/r#1', '--plan'], '/work')).toMatchObject({ kind: 'run', plan: true });
    expect(parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--plan'], '/work')).toMatchObject({ kind: 'watch', plan: true });
    // Absent flags leave no key on either command.
    const bareRun = parseCli(['run', '--github', 'o/r#1'], '/work');
    const bareWatch = parseCli(['watch', '--source', 'github', '--label', 'vanguard'], '/work');
    expect(bareRun.kind).toBe('run');
    expect(bareWatch.kind).toBe('watch');
    for (const key of [...Object.keys(expected), 'plan']) {
      expect(key in bareRun).toBe(false);
      expect(key in bareWatch).toBe(false);
    }
  });

  it('parses --provider-model and --review-model on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--provider-model', 'opus', '--review-model', 'haiku'], '/work');
    expect(cmd.kind === 'run' && cmd.providerModel).toBe('opus');
    expect(cmd.kind === 'run' && cmd.reviewModel).toBe('haiku');
  });

  it('parses --no-simplify on run and watch (absent => undefined)', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--no-simplify'], '/work').kind === 'run' && parseCli(['run', '--linear', 'TES-1', '--no-simplify'], '/work')).toMatchObject({ noSimplify: true });
    expect(parseCli(['watch', '--label', 'vanguard', '--no-simplify'], '/work')).toMatchObject({ noSimplify: true });
    expect('noSimplify' in parseCli(['run', '--linear', 'TES-1'], '/work')).toBe(false);
  });

  it('parses --max-turns and --max-repair-iterations on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--max-turns', '80'], '/work');
    expect(cmd.kind === 'run' && cmd.maxTurns).toBe(80);
    const cmd2 = parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '5'], '/work');
    expect(cmd2.kind === 'run' && cmd2.maxRepairIterations).toBe(5);
  });

  it('rejects --max-turns 0, negative, or non-numeric (no override set)', () => {
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', '0'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', '-3'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', 'x'], '/work')).toBe(false);
  });

  it('rejects --max-repair-iterations 0, negative, or non-numeric (no override set)', () => {
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '0'], '/work')).toBe(false);
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '-3'], '/work')).toBe(false);
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', 'x'], '/work')).toBe(false);
  });

  it('omits maxTurns and maxRepairIterations when neither flag is passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect('maxTurns' in cmd).toBe(false);
    expect('maxRepairIterations' in cmd).toBe(false);
  });

  it('omits providerModel and reviewModel when flags are absent', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'providerModel' in cmd).toBe(false);
    expect(cmd.kind === 'run' && 'reviewModel' in cmd).toBe(false);
  });

  // Expected values are what main's parseCli returns for the same argv: `--skills` is a boolean only when
  // the parsed command is `stats`, so nothing else changes.
  it.each<[string[], Record<string, unknown>]>([
    [['run', '--linear', 'TES-1', '--skills', './dir'], { kind: 'run', skillsDir: './dir' }],
    [['run', '--linear', 'TES-1', '--skills', '-'], { kind: 'run', skillsDir: '-' }],
    [['run', '--linear', 'TES-1', '--skills', 'stats'], { kind: 'run', skillsDir: 'stats' }],
    [['run', '--linear', 'TES-1', '--skills=stats'], { kind: 'run', skillsDir: 'stats' }],
    [['run', '--linear', 'TES-1', '--skills', './skills', '--repo', 'stats'], { kind: 'run', skillsDir: './skills', repoPath: 'stats' }],
    [['--skills', 'stats', 'run', '--linear', 'TES-1'], { kind: 'run', skillsDir: 'stats' }],
    [['--skills', './dir', 'run', '--linear', 'TES-1'], { kind: 'run', skillsDir: './dir' }],
    [['--skills', '-', 'watch', '--label', 'x'], { kind: 'watch', skillsDir: '-', label: 'x' }],
    [['watch', '--label', 'x', '--skills', './dir'], { kind: 'watch', skillsDir: './dir', label: 'x' }],
    [['watch', '--label', 'x', '--skills', '-'], { kind: 'watch', skillsDir: '-', label: 'x' }],
    [['watch', '--label', 'x', '--skills', 'stats'], { kind: 'watch', skillsDir: 'stats', label: 'x' }],
    [['watch', '--label', 'stats', '--skills', './skills'], { kind: 'watch', skillsDir: './skills', label: 'stats' }],
    [['watch', '--skills'], { kind: 'help' }],
    [['watch', '--skills', '--json'], { kind: 'help' }],
    [['watch', '--skills', '-x'], { kind: 'help' }],
    [['watch', '--skills', '--', 'x'], { kind: 'help' }],
    [['watch-prs', '--skills', 'stats'], { kind: 'error', message: 'watch-prs requires --github-repo <owner/repo> and --label <name>.' }],
    [['review-pr', '1', '--skills', 'stats'], { kind: 'review-pr', prRef: '1', repoPath: '/work', skillsDir: 'stats', egress: false }],
    [['doctor', '--skills', 'stats'], { kind: 'error', message: 'doctor --source linear requires --label <name> (or pick a source: --source github --github-repo <owner/repo>).' }],
    [['skills', 'list', '--skills', 'stats'], { kind: 'error', message: 'skills does not accept --skills; see `taskcell skills --help`.' }],
    [['skills', 'update', '--pr', '--base', 'dev'], { kind: 'skills', action: 'update', dir: '/work/skills', pr: true, baseBranch: 'dev' }],
    [['--pr', 'skills', 'update', '--dir', 'stats'], { kind: 'skills', action: 'update', dir: '/work/stats', pr: true }],
    [['gc', '--skills', 'stats'], { kind: 'error', message: 'gc does not accept --skills; see `taskcell gc --help`.' }],
    [['--skills', 'stats'], { kind: 'help' }],
    [['gc', '--skill-stats'], { kind: 'help' }],
    [['stats'], { kind: 'stats', repoPath: '/work', json: false, approver: false }],
    [['stats', 'extra'], { kind: 'stats', repoPath: '/work', json: false, approver: false }],
    [['stats', '--branch', 'stats'], { kind: 'stats', repoPath: '/work', json: false, approver: false, branch: 'stats' }],
    [['--repo', 'stats', 'stats'], { kind: 'stats', repoPath: 'stats', json: false, approver: false }],
    [['stats', '--since', '30d'], { kind: 'stats', repoPath: '/work', json: false, approver: false }],
    [['stats', '--since', 'soon', '--json'], { kind: 'stats', repoPath: '/work', json: true, approver: false }],
    [['stats', '--approver', '--since', '30d'], { kind: 'stats', repoPath: '/work', json: false, approver: true }],
    [['stats', '--github-repo', 'a/b', '--feedback-authors', 'x', '--since', '2026-01-01'], { kind: 'stats', repoPath: '/work', json: false, approver: false, githubRepo: 'a/b', feedbackAuthors: ['x'] }],
  ])('parses %j as main does', (argv, expected) => {
    const parsed = parseCli(argv, '/work');
    expect(parsed).toMatchObject(expected);
    if (parsed.kind === 'stats') expect(parsed).toEqual(expected);
    if (!('skillsDir' in expected)) expect(parsed).not.toHaveProperty('skillsDir');
  });

  it('returns an error when run has no source or more than one source', () => {
    expect(parseCli(['run'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--linear', 'A', '--github', 'B'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--github', 'A', '--project', '3'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('returns an error when run --parent is used without --linear', () => {
    expect(parseCli(['run', '--github', 'o/r#1', '--parent'], '/work')).toMatchObject({
      kind: 'error',
      message: '--parent is only supported with --linear.',
    });
  });

  it('returns an error when run --project is not a positive integer', () => {
    expect(parseCli(['run', '--project', 'x'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--project expects a board number'),
    });
    expect(parseCli(['run', '--project', '0'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses --verify into verifyCmd on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--verify', 'pnpm test'], '/work');
    expect(cmd.kind === 'run' && cmd.verifyCmd).toBe('pnpm test');
  });

  it('omits verifyCmd when --verify is not passed on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'verifyCmd' in cmd).toBe(false);
  });

  it('parses --visual-proof into visualProofCmd on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--visual-proof', 'pnpm shot'], '/work');
    expect(cmd.kind === 'run' && cmd.visualProofCmd).toBe('pnpm shot');
  });

  it('omits visualProofCmd when --visual-proof is not passed on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'visualProofCmd' in cmd).toBe(false);
  });

  it('parses --conformance flags on run', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--conformance', '--conformance-model', 'opus'], '/work');
    expect(cmd.kind === 'run' && cmd.conformance).toBe(true);
    expect(cmd.kind === 'run' && cmd.conformanceModel).toBe('opus');
  });

  it('parses --conformance flags for gitlab runs and watches', () => {
    const run = parseCli(['run', '--gitlab', '7', '--conformance'], '/work');
    expect(run.kind === 'run' && run.source).toBe('gitlab');
    expect(run.kind === 'run' && run.conformance).toBe(true);

    const watch = parseCli(['watch', '--source', 'gitlab', '--label', 'vanguard', '--conformance-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.source).toBe('gitlab');
    expect(watch.kind === 'watch' && watch.conformanceModel).toBe('opus');
  });

  it('parses --commit-author "Name <email>" on run and watch', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--commit-author', 'Sebastian Pietrzak <spietrza@gmail.com>'], '/work');
    expect(run.kind === 'run' && run.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 'spietrza@gmail.com' });

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--commit-author', 'A B <a@b.co>'], '/work');
    expect(watch.kind === 'watch' && watch.commitAuthor).toEqual({ name: 'A B', email: 'a@b.co' });
  });

  it('rejects a malformed --commit-author', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--commit-author', 'no-email-here'], '/work');
    expect(cmd.kind).toBe('error');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/Invalid --commit-author/);
  });

  it('parses --plan on run and watch (off by default)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--plan'], '/work');
    expect(run.kind === 'run' && run.plan).toBe(true);

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--plan'], '/work');
    expect(watch.kind === 'watch' && watch.plan).toBe(true);

    const noPlan = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noPlan.kind === 'run' && 'plan' in noPlan).toBe(false);
  });

  it('parses --flow on run and watch (a FLOWS key)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--flow', 'flow-b'], '/work');
    expect(run.kind === 'run' && run.flow).toBe('flow-b');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--flow', 'flow-b'], '/work');
    expect(watch.kind === 'watch' && watch.flow).toBe('flow-b');

    const noFlow = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noFlow.kind === 'run' && 'flow' in noFlow).toBe(false);
  });

  it('lets an unknown --flow through as a string — repo .vanguard/flows flows resolve in the async dispatch (S5)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--flow', 'my-custom'], '/work');
    expect(run.kind === 'run' && run.flow).toBe('my-custom');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--flow', 'my-custom'], '/work');
    expect(watch.kind === 'watch' && watch.flow).toBe('my-custom');
  });

  it('rejects --plan and --flow together', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--plan', '--flow', 'flow-b'], '/work');
    expect(cmd.kind).toBe('error');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/not both/);
  });

  it('parses --base on run and watch (defaults to undefined)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--base', 'dev'], '/work');
    expect(run.kind === 'run' && run.baseBranch).toBe('dev');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base', 'dev'], '/work');
    expect(watch.kind === 'watch' && watch.baseBranch).toBe('dev');

    const noBase = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noBase.kind === 'run' && 'baseBranch' in noBase).toBe(false);
  });

  it.each([
    ['run', '--linear', 'TES-1'],
    ['watch-prs', '--github-repo', 'o/r', '--label', 'x'],
    ['watch-mrs', '--gitlab-project', 'g/p', '--label', 'x'],
  ])('rejects --spec-only on %s, which would otherwise ignore it', (...argv) => {
    expect(parseCli([...argv, '--spec-only'], '/work')).toEqual({
      kind: 'error',
      message: `${argv[0]} does not accept --spec-only; see \`taskcell ${argv[0]} --help\`.`,
    });
  });
});

describe('parseCli gitlab run', () => {
  it('parses --gitlab flag as gitlab source', () => {
    const cmd = parseCli(['run', '--gitlab', 'owner/project#42'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('owner/project#42');
  });

  it('parses --gitlab with --gitlab-project', () => {
    const cmd = parseCli(['run', '--gitlab', '42', '--gitlab-project', 'group/project'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('42');
    expect(cmd.project).toBe('group/project');
  });
});
