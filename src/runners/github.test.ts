import { describe, it, expect, vi } from 'vitest';
vi.mock('../tasks/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tasks/github.js')>()),
  addPrGateLabel: vi.fn(async () => {}),
}));
import { addPrGateLabel } from '../tasks/github.js';
import { githubAdapter, sameRepoTasks, runGithubIssue } from './github.js';
import { DEPENDENCY_MARKER } from '../tasks/dependencies.js';
import { GITHUB_GATE_CONFIG_LABEL, GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import type { RunGithubIssueDeps } from './github.js';
import type { GhRunner } from '../tasks/github.js';
import type { Task } from '../tasks/fetcher.js';

function makeDeps(): RunGithubIssueDeps {
  return { repoPath: '/repo', repoSlug: 'owner/repo' };
}

function makeGh(failOn?: (args: string[]) => boolean): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (failOn?.(args) === true) throw new Error('gh: failed');
    return '';
  };
  return { gh, calls };
}

const task: Task = { id: 'owner/repo#7', title: 't', description: '', labels: [], children: [], comments: [] };

describe('githubAdapter', () => {
  it('signalSecretBlock creates the secret-blocked label before adding it, and posts the masked comment', async () => {
    const { gh, calls } = makeGh();
    const adapter = githubAdapter(makeDeps(), gh);

    await adapter.signalSecretBlock('owner/repo#7', task, {
      reason: 'findings',
      findings: [{ file: '.env', patternName: 'generic-api-key', masked: 'KEY=ab****' }],
    });

    const create = calls.findIndex((c) => c[0] === 'label' && c[1] === 'create' && c[2] === GITHUB_SECRET_BLOCKED_LABEL && c.includes('--force'));
    const add = calls.findIndex((c) => c[0] === 'issue' && c[1] === 'edit' && c[2] === '7' && c.includes('--add-label') && c.includes(GITHUB_SECRET_BLOCKED_LABEL));
    expect(create).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(create); // `gh issue edit --add-label` fails on a repo without the label
    const comment = calls.find((c) => c[0] === 'issue' && c[1] === 'comment' && c[2] === '7');
    expect(comment?.at(-1)).toContain('blocked publish');
    expect(comment?.at(-1)).toContain('KEY=ab****');
    expect(comment?.at(-1)).not.toContain('trigger label'); // the release step is per watch source, posted by the primitive
  });

  it('signalSecretBlock never throws: a failed label create still attempts the add and the comment', async () => {
    const { gh, calls } = makeGh((args) => args[0] === 'label');
    const adapter = githubAdapter(makeDeps(), gh);

    await expect(adapter.signalSecretBlock('owner/repo#7', task, { reason: 'scan-error', message: 'gitleaks missing' })).resolves.toBeUndefined();

    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit' && c.includes(GITHUB_SECRET_BLOCKED_LABEL))).toBe(true);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'comment')).toBe(true);
  });

  it('signalSecretBlock never throws when every gh call fails', async () => {
    const { gh } = makeGh(() => true);
    const adapter = githubAdapter(makeDeps(), gh);

    await expect(adapter.signalSecretBlock('owner/repo#7', task, { reason: 'scan-error', message: 'x' })).resolves.toBeUndefined();
  });

  it('addGateConfigLabel flags the PR with the gate-config label', async () => {
    vi.mocked(addPrGateLabel).mockClear();
    await githubAdapter(makeDeps()).addGateConfigLabel('https://github.com/owner/repo/pull/7');

    expect(addPrGateLabel).toHaveBeenCalledWith('/repo', 'https://github.com/owner/repo/pull/7', GITHUB_GATE_CONFIG_LABEL);
  });

  it('addGateConfigLabel is not best-effort: a failed flip rejects rather than leaving the PR unflagged', async () => {
    vi.mocked(addPrGateLabel).mockRejectedValueOnce(new Error('gh: 403'));

    await expect(githubAdapter(makeDeps()).addGateConfigLabel('https://github.com/owner/repo/pull/7')).rejects.toThrow('gh: 403');
  });
});

describe('sameRepoTasks', () => {
  const task = (id: string): Task => ({ id, title: '', description: '', labels: [], children: [], comments: [] });

  it('keeps items of the configured repo (case-insensitive) and skips foreign ones with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const kept = sameRepoTasks([task('owner/repo#1'), task('other-org/other-repo#7'), task('Owner/Repo#2')], 'owner/repo');
      expect(kept.map((t) => t.id)).toEqual(['owner/repo#1', 'Owner/Repo#2']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('other-org/other-repo#7');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runGithubIssue dependency gate (#760)', () => {
  /** owner/repo#7 is blocked by owner/repo#9; `dep` is #9's state, `comments` #7's comments. */
  function gateGh(dep: { state: string; state_reason?: string | null } | 'missing', comments: unknown[] = []): { gh: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      const path = args[1] ?? '';
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 7, title: 't', body: '', labels: [], comments });
      if (path === 'repos/owner/repo/issues/7/dependencies/blocked_by') return JSON.stringify([{ number: 9 }]);
      if (path.endsWith('/dependencies/blocked_by')) return '[]';
      if (path === 'repos/owner/repo/issues/9') {
        if (dep === 'missing') throw new Error('HTTP 404: Not Found');
        return JSON.stringify(dep);
      }
      if (args[0] === 'issue' && args[1] === 'comment') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    return { gh, calls };
  }
  const posted = (calls: string[][]): string[][] => calls.filter((a) => a[0] === 'issue' && a[1] === 'comment');

  it('parks a waiting issue, flags it waiting, and posts the reason once', async () => {
    const { gh, calls } = gateGh({ state: 'open' });
    const result = await runGithubIssue('owner/repo#7', makeDeps(), gh);
    expect(result).toMatchObject({ parked: true, waiting: true });
    expect(posted(calls)).toHaveLength(1);
    expect(posted(calls)[0]?.join(' ')).toContain('owner/repo#9');
  });

  it('does not repeat a comment it already posted', async () => {
    const first = gateGh({ state: 'open' });
    await runGithubIssue('owner/repo#7', makeDeps(), first.gh);
    const body = posted(first.calls)[0]?.[(posted(first.calls)[0]?.indexOf('--body') ?? 0) + 1] ?? '';
    expect(body).toContain(DEPENDENCY_MARKER);
    const again = gateGh({ state: 'open' }, [{ author: { login: 'owner' }, authorAssociation: 'OWNER', body }]);
    await runGithubIssue('owner/repo#7', makeDeps(), again.gh);
    expect(posted(again.calls)).toHaveLength(0);
  });

  it('releases (not waiting) on a missing dependency, so the watch drops the claim', async () => {
    const { gh } = gateGh('missing');
    expect(await runGithubIssue('owner/repo#7', makeDeps(), gh)).toMatchObject({ parked: true, released: true });
  });
});
