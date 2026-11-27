import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approverDoctorChecks } from './doctor.js';

const POLICY = {
  schemaVersion: 1, enabled: true,
  requiredChecks: [{ name: 'build', appId: 15368 }],
  reviewAuthors: ['bot'], pathRules: {},
  shape: { maxLines: 150, maxFiles: 5 }, ledger: { windowDays: 7, maxLines: 300 }, auditSample: { p: 0 },
};

const runner = (policy: string | undefined, protection: unknown) => async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
  if (cmd === 'gh' && args[0] === 'repo') return { stdout: 'main\n' };
  if (cmd === 'git' && policy !== undefined && args[1] === 'origin/main:.taskcell/approver.json') return { stdout: policy };
  if (cmd === 'gh' && args[0] === 'api' && protection !== undefined) return { stdout: JSON.stringify(protection) };
  throw new Error('nope');
};

async function repoWithWorkflow(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vg-adoc-'));
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'taskcell-approver.yml'), 'name: x\n');
  return dir;
}

describe('approverDoctorChecks', () => {
  it('reports nothing for a repo that does not use the approver', async () => {
    expect(await approverDoctorChecks(runner(undefined, undefined), '/nonexistent', 'o/r')).toEqual([]);
  });

  it('a missing policy fails when the approver workflow exists', async () => {
    const checks = await approverDoctorChecks(runner(undefined, undefined), await repoWithWorkflow(), 'o/r');
    expect(checks).toMatchObject([{ name: 'approver policy', ok: false }]);
  });

  it('an invalid policy fails with the schema path', async () => {
    const checks = await approverDoctorChecks(runner(JSON.stringify({ ...POLICY, reviewAuthors: [] }), undefined), '/nonexistent', 'o/r');
    expect(checks[0]).toMatchObject({ ok: false });
    expect(checks[0]?.reason).toMatch(/reviewAuthors/);
  });

  it('passes when requiredChecks match branch protection, fails on a different app id or a missing check', async () => {
    const ok = await approverDoctorChecks(runner(JSON.stringify(POLICY), { checks: [{ context: 'build', app_id: 15368 }] }), '/nonexistent', 'o/r');
    expect(ok.every((c) => c.ok)).toBe(true);
    const wrongApp = await approverDoctorChecks(runner(JSON.stringify(POLICY), { checks: [{ context: 'build', app_id: 1 }] }), '/nonexistent', 'o/r');
    expect(wrongApp.find((c) => c.name === 'approver requiredChecks')).toMatchObject({ ok: false });
    const anyApp = await approverDoctorChecks(runner(JSON.stringify(POLICY), { checks: [{ context: 'build', app_id: null }] }), '/nonexistent', 'o/r');
    expect(anyApp.find((c) => c.name === 'approver requiredChecks')?.reason).toMatch(/any app/);
    const missing = await approverDoctorChecks(runner(JSON.stringify(POLICY), { checks: [] }), '/nonexistent', 'o/r');
    expect(missing.find((c) => c.name === 'approver requiredChecks')?.reason).toMatch(/not a required check/);
  });

  it('skips the protection comparison when protection is unreadable', async () => {
    const checks = await approverDoctorChecks(runner(JSON.stringify(POLICY), undefined), '/nonexistent', 'o/r');
    expect(checks).toEqual([{ name: 'approver policy', ok: true }]);
  });
});
