import { describe, it, expect, vi } from 'vitest';
vi.mock('../tasks/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tasks/github.js')>()),
  addPrGateLabel: vi.fn(async () => {}),
  addPrFailureLabel: vi.fn(async () => {}),
}));
import { addPrFailureLabel, addPrGateLabel } from '../tasks/github.js';
import { publishReviewVerdict } from '../pipeline/review-publish.js';
import { githubTracker, githubReviewHost, sameRepoTasks } from './github.js';
import { GITHUB_GATE_CONFIG_LABEL, GITHUB_SECRET_BLOCKED_LABEL, GITHUB_VERIFY_FAILED_LABEL } from '../github-labels.js';
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

describe('githubTracker', () => {
  it('signalSecretBlock creates the secret-blocked label before adding it, and posts the masked comment', async () => {
    const { gh, calls } = makeGh();
    const adapter = githubTracker(makeDeps(), gh);

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
    const adapter = githubTracker(makeDeps(), gh);

    await expect(adapter.signalSecretBlock('owner/repo#7', task, { reason: 'scan-error', message: 'gitleaks missing' })).resolves.toBeUndefined();

    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit' && c.includes(GITHUB_SECRET_BLOCKED_LABEL))).toBe(true);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'comment')).toBe(true);
  });

  it('signalSecretBlock never throws when every gh call fails', async () => {
    const { gh } = makeGh(() => true);
    const adapter = githubTracker(makeDeps(), gh);

    await expect(adapter.signalSecretBlock('owner/repo#7', task, { reason: 'scan-error', message: 'x' })).resolves.toBeUndefined();
  });

  it('taskId sanitises the issue ref to a gh- prefix and the issue closes on merge', () => {
    const tracker = githubTracker(makeDeps());
    expect(tracker.taskId(task)).toBe('gh-owner-repo-7');
    expect(tracker.closeIssueOnMerge).toBe(true);
  });

  it('signalBaseRed comments only, and never throws', async () => {
    const { gh, calls } = makeGh((a) => a[0] === 'issue');
    await expect(githubTracker(makeDeps(), gh).signalBaseRed('owner/repo#7', task, 'base is red')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(['issue', 'comment']);
  });
});

describe('githubReviewHost', () => {
  it('opens PRs with gh and posts the verdict through the shared publisher', () => {
    const host = githubReviewHost('/repo');
    expect(host.kind).toBe('gh');
    expect(host.publishVerdict).toBe(publishReviewVerdict);
  });

  it('newPrTarget: gh, with the push-token provider', () => {
    const target = githubReviewHost('/repo').newPrTarget({ title: 't', body: () => 'b', draft: true });
    expect(target).toMatchObject({ kind: 'new-pr', cli: 'gh', title: 't', draft: true, tokenProvider: expect.any(Function) });
  });

  it('addFailureLabel labels the PR with the GitHub label for the proof kind', async () => {
    vi.mocked(addPrFailureLabel).mockClear();
    await githubReviewHost('/repo').addFailureLabel('https://github.com/owner/repo/pull/7', 'verify');

    expect(addPrFailureLabel).toHaveBeenCalledWith('/repo', 'https://github.com/owner/repo/pull/7', GITHUB_VERIFY_FAILED_LABEL);
  });

  it('addGateConfigLabel flags the PR with the gate-config label', async () => {
    vi.mocked(addPrGateLabel).mockClear();
    await githubReviewHost('/repo').addGateConfigLabel('https://github.com/owner/repo/pull/7');

    expect(addPrGateLabel).toHaveBeenCalledWith('/repo', 'https://github.com/owner/repo/pull/7', GITHUB_GATE_CONFIG_LABEL);
  });

  it('addGateConfigLabel is not best-effort: a failed flip rejects rather than leaving the PR unflagged', async () => {
    vi.mocked(addPrGateLabel).mockRejectedValueOnce(new Error('gh: 403'));

    await expect(githubReviewHost('/repo').addGateConfigLabel('https://github.com/owner/repo/pull/7')).rejects.toThrow('gh: 403');
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
