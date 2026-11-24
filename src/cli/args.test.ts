import { describe, it, expect } from 'vitest';
import { parseCli, USAGE } from './args.js';
import { commandUsage, findCommand } from './commands.js';

describe('parseCli', () => {
  it('uses taskcell in help and command examples', () => {
    expect(USAGE).toMatch(/^taskcell <command>/);
    expect(USAGE).not.toMatch(/^\s+vanguard /m);
  });

  it('parses the hidden __sidecar entrypoint (no flags)', () => {
    expect(parseCli(['__sidecar'], '/work')).toEqual({ kind: 'sidecar' });
  });

  it('parses the hidden __complete entrypoint (no flags)', () => {
    expect(parseCli(['__complete'], '/work')).toEqual({ kind: 'complete' });
  });

  it('documents the shared flags under both run and watch, and the run-only ones under run only', () => {
    const runBlock = commandUsage(findCommand('run')!);
    const watchBlock = commandUsage(findCommand('watch')!);
    for (const flag of ['--fallback-provider <name>', '--conformance-model <m>', '--max-repair-iterations <n>', '--base <branch>', '--max-turns <n>']) {
      expect(runBlock).toContain(flag);
      expect(watchBlock).toContain(flag);
    }
    for (const flag of ['--fork <n>', '--fork-scorer <llm|decision>', '--spec-file <file>']) {
      expect(runBlock).toContain(flag);
      expect(watchBlock).not.toContain(flag);
    }
  });
});
