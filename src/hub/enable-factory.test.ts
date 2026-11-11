import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGithubFactory,
  CALLER_NAMES,
  enableFactory,
  FACTORY_LABELS,
  githubSecretCommand,
  planGithubFactory,
  verifyGithubFactory,
  type FactoryExec,
  type FactoryPlan,
} from './enable-factory.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(scripts: Record<string, string> = { typecheck: 'tsc', lint: 'eslint .', test: 'vitest run', build: 'tsc -p .' }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enable-factory-test-'));
  roots.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts }));
  return dir;
}

interface Call {
  file: string;
  args: string[];
  cwd: string | undefined;
}

interface FakeOptions {
  /** `git status --porcelain` output — non-empty means the callers changed. */
  status?: string;
  /** `git status --porcelain --untracked-files=no` output — non-empty means a dirty tree. */
  dirty?: string;
  /** URL `gh pr list` reports for an already-open PR ('' = none). */
  openPr?: string;
  /** `gh run list` results per call, in order (the last one repeats). */
  runLists?: unknown[][];
}

const doctorRun = (id: number, event = 'workflow_dispatch'): unknown => ({
  databaseId: id,
  status: 'completed',
  conclusion: 'success',
  displayTitle: 'Vanguard Doctor',
  headBranch: 'main',
  workflowName: 'Vanguard Doctor',
  createdAt: '2026-01-01T00:00:00Z',
  event,
  url: `https://github.com/acme/widgets/actions/runs/${id}`,
});

const noSleep = async (): Promise<void> => {};

function fakeExec(calls: Call[], opts: FakeOptions = {}): FactoryExec {
  const runLists = opts.runLists ?? [[], [doctorRun(1)]];
  let runListCalls = 0;
  return async (file, args, options) => {
    calls.push({ file, args, cwd: options?.cwd });
    if (file === 'git' && args[0] === 'status') {
      // With a pathspec: did the callers change. Without: the up-front dirty-tree check.
      if (args.includes('--')) return { stdout: opts.status ?? 'M  .github/workflows/vanguard-implement.yml\n', stderr: '' };
      return { stdout: opts.dirty ?? '', stderr: '' };
    }
    if (file === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'feature/wip\n', stderr: '' };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { stdout: `${opts.openPr ?? ''}\n`, stderr: '' };
    }
    if (file === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }), stderr: '' };
    }
    if (file === 'gh' && args[0] === 'api' && args[1] === 'user') {
      return { stdout: JSON.stringify({ login: 'octocat' }), stderr: '' };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return { stdout: 'https://github.com/acme/widgets/pull/42\n', stderr: '' };
    }
    if (file === 'gh' && args[0] === 'run' && args[1] === 'list') {
      const runs = runLists[Math.min(runListCalls, runLists.length - 1)];
      runListCalls++;
      return { stdout: JSON.stringify(runs), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('planGithubFactory', () => {
  it('reports the detected verify command, package manager and scripts', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const plan = await planGithubFactory(repoPath, { exec: fakeExec(calls) });

    expect(plan.repoSlug).toBe('acme/widgets');
    expect(plan.defaultBranch).toBe('main');
    expect(plan.login).toBe('octocat');
    expect(plan.packageManager).toBe('pnpm');
    expect(plan.verifyCommand).toMatch(/pnpm/);
    expect(plan.verifyCommand).toMatch(/typecheck/);
    expect(plan.verifyCommand).toMatch(/pnpm test/);
    expect(plan.scripts).toEqual({ typecheck: true, lint: true, test: true, build: true });
    expect(plan.callerFiles).toHaveLength(CALLER_NAMES.length);
    expect(plan.labels).toEqual(FACTORY_LABELS.map((l) => l.name));
  });

  it('falls back gracefully when there is no package.json', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'enable-factory-test-'));
    roots.push(repoPath);
    const calls: Call[] = [];
    const plan = await planGithubFactory(repoPath, { exec: fakeExec(calls) });
    expect(plan.packageManager).toBe('none');
    expect(plan.verifyCommand).toBeUndefined();
    expect(plan.scripts).toEqual({ typecheck: false, lint: false, test: false, build: false });
  });
});

describe('applyGithubFactory', () => {
  async function plannedRepo(): Promise<{ repoPath: string; plan: FactoryPlan; calls: Call[] }> {
    const repoPath = await repo();
    const calls: Call[] = [];
    const plan = await planGithubFactory(repoPath, { exec: fakeExec(calls) });
    return { repoPath, plan, calls };
  }

  it('creates a branch from origin/<default>, commits the callers, opens a PR and creates the labels', async () => {
    const { repoPath, plan, calls } = await plannedRepo();
    const result = await applyGithubFactory(repoPath, plan, { exec: fakeExec(calls) });

    expect(result.branch).toBe('vanguard/enable-factory');
    expect(result.prUrl).toBe('https://github.com/acme/widgets/pull/42');
    expect(result.labelsCreated).toEqual(FACTORY_LABELS.map((l) => l.name));

    const fetchIdx = calls.findIndex((c) => c.file === 'git' && c.args[0] === 'fetch');
    const checkoutIdx = calls.findIndex((c) => c.file === 'git' && c.args[0] === 'checkout');
    expect(calls[fetchIdx]?.args).toEqual(['fetch', 'origin', 'main']);
    expect(calls[checkoutIdx]?.args).toEqual(['checkout', '-B', 'vanguard/enable-factory', 'origin/main']);
    expect(fetchIdx).toBeLessThan(checkoutIdx);

    // Commits the callers only (pathspec), never whatever else the user had staged.
    const commit = calls.find((c) => c.file === 'git' && c.args[0] === 'commit');
    expect(commit?.args.slice(commit.args.indexOf('--') + 1)).toEqual(plan.callerFiles);

    // The user's original branch is checked out again at the end.
    const lastGit = calls.filter((c) => c.file === 'git').at(-1);
    expect(lastGit?.args).toEqual(['checkout', '-f', 'feature/wip']);

    const labelCreates = calls.filter((c) => c.file === 'gh' && c.args[0] === 'label' && c.args[1] === 'create');
    expect(labelCreates).toHaveLength(FACTORY_LABELS.length);
    for (const call of labelCreates) expect(call.args).toContain('--force');

    const prCreate = calls.find((c) => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
    expect(prCreate?.args).toEqual(
      expect.arrayContaining(['--base', 'main', '--head', 'vanguard/enable-factory']),
    );

    // The five callers landed on disk with the author gate set to the signed-in login.
    for (const name of CALLER_NAMES) {
      const content = await readFile(join(repoPath, '.github', 'workflows', `vanguard-${name}.yml`), 'utf8');
      expect(content).toContain('octocat');
      expect(content).not.toContain('YOUR_LOGIN');
    }
  });

  it('never pushes to the default branch', async () => {
    const { repoPath, plan, calls } = await plannedRepo();
    await applyGithubFactory(repoPath, plan, { exec: fakeExec(calls) });

    const pushes = calls.filter((c) => c.file === 'git' && c.args[0] === 'push');
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) {
      expect(push.args).not.toContain(plan.defaultBranch);
      expect(push.args).toContain('vanguard/enable-factory');
    }
  });
});

describe('applyGithubFactory re-runs', () => {
  it('reuses an already-open PR instead of creating a second one', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const exec = fakeExec(calls, { openPr: 'https://github.com/acme/widgets/pull/7' });
    const plan = await planGithubFactory(repoPath, { exec });
    const result = await applyGithubFactory(repoPath, plan, { exec });

    expect(result.prUrl).toBe('https://github.com/acme/widgets/pull/7');
    expect(calls.some((c) => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
  });

  it('skips the commit and push when the callers did not change', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const exec = fakeExec(calls, { status: '', openPr: 'https://github.com/acme/widgets/pull/7' });
    const plan = await planGithubFactory(repoPath, { exec });
    const result = await applyGithubFactory(repoPath, plan, { exec });

    expect(result.prUrl).toBe('https://github.com/acme/widgets/pull/7');
    expect(calls.some((c) => c.file === 'git' && (c.args[0] === 'commit' || c.args[0] === 'push'))).toBe(false);
  });

  it('refuses a dirty working tree before touching the checkout', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const exec = fakeExec(calls, { dirty: ' M src/index.ts\n' });
    const plan = await planGithubFactory(repoPath, { exec });
    await expect(applyGithubFactory(repoPath, plan, { exec })).rejects.toThrow(/uncommitted changes/);
    expect(calls.some((c) => c.file === 'git' && (c.args[0] === 'checkout' || c.args[0] === 'fetch'))).toBe(false);
  });

  it('restores the original branch when a step after checkout fails', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const base = fakeExec(calls);
    const exec: FactoryExec = async (file, args, options) => {
      if (file === 'git' && args[0] === 'push') throw new Error('push rejected');
      return base(file, args, options);
    };
    const plan = await planGithubFactory(repoPath, { exec });
    await expect(applyGithubFactory(repoPath, plan, { exec })).rejects.toThrow('push rejected');
    expect(calls.filter((c) => c.file === 'git').at(-1)?.args).toEqual(['checkout', '-f', 'feature/wip']);
  });

  it('reports a clear error when nothing changed and no PR is open', async () => {
    const repoPath = await repo();
    const exec = fakeExec([], { status: '' });
    const plan = await planGithubFactory(repoPath, { exec });
    await expect(applyGithubFactory(repoPath, plan, { exec })).rejects.toThrow(/already on main/);
  });
});

describe('githubSecretCommand', () => {
  it('returns the command text only, with no exec dependency at all', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const plan = await planGithubFactory(repoPath, { exec: fakeExec(calls) });

    const callsBefore = calls.length;
    const step = githubSecretCommand(plan);

    expect(step.secretName).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(step.command).toBe('gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme/widgets');
    // secretCommand is a pure function: calling it must not have shelled out at all.
    expect(calls).toHaveLength(callsBefore);
  });
});

describe('verifyGithubFactory', () => {
  it('dispatches the doctor workflow and reports the run that dispatch created', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const plan = await planGithubFactory(repoPath, { exec: fakeExec([]) });
    const result = await verifyGithubFactory(repoPath, plan, {
      exec: fakeExec(calls, { runLists: [[doctorRun(1)], [doctorRun(1)], [doctorRun(2), doctorRun(1)]] }),
      sleep: noSleep,
    });

    expect(result).toEqual({
      dispatched: true,
      run: { url: 'https://github.com/acme/widgets/actions/runs/2', status: 'completed', conclusion: 'success' },
    });

    const listIdx = calls.findIndex((c) => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'list');
    const dispatchIdx = calls.findIndex((c) => c.file === 'gh' && c.args[0] === 'workflow' && c.args[1] === 'run');
    expect(calls[dispatchIdx]?.args).toEqual(['workflow', 'run', 'vanguard-doctor.yml']);
    expect(listIdx).toBeLessThan(dispatchIdx);
  });

  it('never reports a stale or unrelated run; returns dispatched with no run instead', async () => {
    const repoPath = await repo();
    const plan = await planGithubFactory(repoPath, { exec: fakeExec([]) });
    const unrelated = { ...(doctorRun(3) as object), workflowName: 'CI' };
    const result = await verifyGithubFactory(repoPath, plan, {
      exec: fakeExec([], { runLists: [[doctorRun(1)], [unrelated, doctorRun(4, 'push'), doctorRun(1)]] }),
      sleep: noSleep,
    });
    expect(result).toEqual({ dispatched: true });
  });
});

describe('enableFactory', () => {
  it('rejects a provider that is not implemented yet', async () => {
    const repoPath = await repo();
    expect(() => enableFactory(repoPath, 'gitlab')).toThrow(/not implemented/);
  });

  it('wires plan/apply/secret/verify to one repo for github, and never calls `gh secret set`', async () => {
    const repoPath = await repo();
    const calls: Call[] = [];
    const provider = enableFactory(repoPath, 'github', { exec: fakeExec(calls), sleep: noSleep });

    const plan = await provider.plan();
    await provider.apply(plan);
    provider.secretCommand(plan);
    await provider.verify(plan);

    const secretSets = calls.filter(
      (c) => c.file === 'gh' && c.args.includes('secret') && c.args.includes('set'),
    );
    expect(secretSets).toHaveLength(0);
  });
});
