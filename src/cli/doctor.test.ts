import { describe, it, expect } from 'vitest';
import { doctorCommand } from './doctor.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { Command } from './args.js';
import type { PreflightRunner } from './preflight.js';


type DoctorCommand = Extract<Command, { kind: 'doctor' }>;

const cmd: DoctorCommand = {
  kind: 'doctor',
  source: 'github',
  repoPath: '/repo',
  repoSlug: 'owner/repo',
  specLabel: 'ready for spec',
  agentLabel: 'ready for agent',
  needsInfoLabel: 'needs info',
};

function selfHealingRunner(): { run: PreflightRunner; calls: string[] } {
  const calls: string[] = [];
  let version = '2.1.165';
  const run: PreflightRunner = async (name, args) => {
    calls.push(`${name} ${args.join(' ')}`);
    if (name === 'docker' && args[0] === 'run' && args.includes('npm')) {
      version = '2.1.322';
      return { stdout: '' };
    }
    if (name === 'docker' && args[0] === 'run') return { stdout: `${version} (Claude Code)` };
    if (name === 'docker' && args[0] === 'image' && args.includes('{{.Config.User}}')) return { stdout: 'agent\n' };
    if (name === 'docker' && args[0] === 'image' && args.includes('{{.Config.WorkingDir}}')) return { stdout: '/workspace\n' };
    return runner(name, args, { cwd: '/repo' });
  };
  return { run, calls };
}

const runner: PreflightRunner = async (name, args) => {
  if (name === 'git' && args[0] === 'rev-parse') return { stdout: '/repo' };
  if (name === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/owner/repo.git' };
  if (name === 'docker' && args[0] === 'run') return { stdout: '2.1.322 (Claude Code)' };
  if (name === 'docker') return { stdout: '' };
  if (name === 'gh' && args[0] === 'label') {
    return {
      stdout: JSON.stringify(
        ['ready for spec', 'ready for agent', 'needs info', GITHUB_SPEC_CLAIMED_LABEL, GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL].map((label) => ({ name: label })),
      ),
    };
  }
  return { stdout: '' };
};

/** Docker stub: image codex/claude versions from the labelled `sh -c` probe, plus preflight's own calls. */
function versionRunner(codex: string, installs: string[], failInstall = false): PreflightRunner {
  let codexNow = codex;
  return async (name, args, o) => {
    if (name === 'docker' && args[0] === 'run' && args.includes('sh')) return { stdout: `claude 2.1.322\ncodex ${codexNow}\nagent \n` };
    if (name === 'docker' && args[0] === 'run' && args.includes('npm')) {
      installs.push(args.at(-1) ?? '');
      if (failInstall) throw new Error('npm down');
      codexNow = '0.167.2';
      return { stdout: '' };
    }
    return runner(name, args, o);
  };
}

describe('doctorCommand cli versions', () => {
  const base = { env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' }, nodeVersion: '24.11.1' };
  const fix = { ...cmd, fix: true };

  it('prints installed vs latest from the lookup', async () => {
    const logs: string[] = [];
    await doctorCommand(cmd, {
      ...base,
      run: runner,
      log: (l) => logs.push(l),
      cliVersions: async () => ({ enabled: true, clis: [{ name: 'codex', installed: '0.100.0', latest: '0.167.2', changelog: 'https://x', outdated: true, updatable: true }] }),
    });
    expect(logs).toContain('cli versions: codex installed 0.100.0, latest 0.167.2 — newer available (https://x)');
  });

  it('--fix rebuilds an old codex, even with the version check off', async () => {
    const installs: string[] = [];
    const logs: string[] = [];
    await doctorCommand(fix, { ...base, env: { ...base.env, VANGUARD_CLI_VERSION_CHECK: 'off' }, run: versionRunner('0.100.0', installs), log: (l) => logs.push(l) });
    expect(installs).toEqual(['@openai/codex@0.167.2']);
    expect(logs).toContain('doctor --fix: installing codex 0.167.2 into the sandbox image');
  });

  it('--fix leaves a current codex alone', async () => {
    const installs: string[] = [];
    await doctorCommand(fix, { ...base, run: versionRunner('0.167.2', installs), log: () => undefined, cliVersions: async () => ({ enabled: false, clis: [] }) });
    expect(installs).toEqual([]);
  });

  it('a failed codex install does not hide the preflight report', async () => {
    const logs: string[] = [];
    await doctorCommand(fix, { ...base, run: versionRunner('0.100.0', [], true), log: (l) => logs.push(l), cliVersions: async () => ({ enabled: false, clis: [] }) });
    expect(logs.some((l) => l.includes('codex install failed: npm down'))).toBe(true);
    expect(logs).toContain('preflight: llm auth ok');
  });
});

describe('doctorCommand', () => {
  it('prints preflight lines when checks pass', async () => {
    const logs: string[] = [];

    await doctorCommand(cmd, {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: runner,
      log: (line) => logs.push(line),
    });

    expect(logs).toContain('preflight: llm auth ok');
    expect(logs).toContain('preflight: github labels ok');
  });

  it('throws after printing failures when a check fails', async () => {
    const logs: string[] = [];

    await expect(
      doctorCommand(cmd, {
        env: { GH_TOKEN: 'gh' },
        nodeVersion: '24.11.1',
        run: runner,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow('preflight failed');

    expect(logs).toContain('preflight: llm auth missing -> stop before claim');
  });

  it('surfaces provider auth failure line when codex key is missing', async () => {
    const logs: string[] = [];
    const codexCmd: DoctorCommand = { ...cmd, provider: 'codex' };

    await expect(
      doctorCommand(codexCmd, {
        env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
        nodeVersion: '24.11.1',
        run: runner,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow('preflight failed');

    expect(logs).toContain(
      'preflight: provider auth Provider "codex" needs CODEX_API_KEY or OPENAI_API_KEY in the environment. -> stop before claim',
    );
  });
});

describe('doctorCommand --fix', () => {
  it('refreshes a stale sandbox CLI, then re-runs the checks and passes', async () => {
    const { run, calls } = selfHealingRunner();
    const lines: string[] = [];

    await doctorCommand(
      { ...cmd, fix: true },
      { env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' }, nodeVersion: '24.11.1', run, log: (l) => lines.push(l) },
    );

    expect(calls.some((c) => c.includes('npm install -g @anthropic-ai/claude-code@2.1.322'))).toBe(true);
    // USER/WorkingDir are restored from the original image, never hardcoded — a commit without them
    // bakes root into the image and the new CLI then refuses to start.
    expect(calls.some((c) => c.startsWith('docker commit') && c.includes('USER '))).toBe(true);
    expect(lines).toContain('preflight: sandbox claude cli ok');
  });

  it('leaves a stale image alone without --fix', async () => {
    const { run, calls } = selfHealingRunner();

    await expect(
      doctorCommand(cmd, {
        env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
        nodeVersion: '24.11.1',
        run,
        log: () => undefined,
      }),
    ).rejects.toThrow('preflight failed');

    expect(calls.some((c) => c.includes('npm install'))).toBe(false);
  });
});
