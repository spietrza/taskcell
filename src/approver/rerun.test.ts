import { describe, it, expect, vi } from 'vitest';

vi.mock('./approve.js', () => ({ runApprover: vi.fn(async (i: { prNumber: number }) => ({ record: { verdict: 'APPROVE', prNumber: i.prNumber } })) }));
vi.mock('./policy.js', () => ({ loadPolicy: vi.fn(async () => ({ policy: { factoryBranchPrefix: 'chore/vanguard-' }, policyHash: 'sha256:x', raw: '' })) }));

const { rerunOpenPrs } = await import('./rerun.js');
const { runApprover } = await import('./approve.js');

const view = (n: number, head: string): string => JSON.stringify({ number: n, state: 'OPEN', headRefName: head, baseRefName: 'main', headRepository: { name: 'r' }, headRepositoryOwner: { login: 'o' } });

describe('rerunOpenPrs', () => {
  it('re-judges only open factory PRs into the default branch, and keeps going after a failure', async () => {
    const gh = async (args: string[]): Promise<string> => {
      if (args[0] === 'repo') return 'main\n';
      if (args[1] === 'list') return JSON.stringify([{ number: 1, baseRefName: 'main' }, { number: 2, baseRefName: 'main' }, { number: 3, baseRefName: 'dev' }, { number: 4, baseRefName: 'main' }]);
      const n = Number(args[2]);
      if (n === 4) throw new Error('boom');
      return view(n, n === 2 ? 'feature/x' : 'chore/vanguard-1');
    };
    const out = await rerunOpenPrs({ repoPath: '/r', repoSlug: 'o/r', mode: 'enforce', gh });
    expect(out.judged.map((j) => j.prNumber)).toEqual([1]);
    expect(out.failed).toMatchObject([{ prNumber: 4, error: 'boom' }]);
    expect(vi.mocked(runApprover).mock.calls.map((c) => c[0].prNumber)).toEqual([1]);
    expect(vi.mocked(runApprover)).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 1, mode: 'enforce' }));
  });
});
