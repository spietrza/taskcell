import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./source-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source-adapter.js')>()),
  runSourcedIssue: vi.fn(async () => ({ task: { id: 'ENG-1' } })),
}));
vi.mock('../tasks/linear-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tasks/linear-cli.js')>()),
  linkLinearIssue: vi.fn(async () => {}),
  commentLinearIssue: vi.fn(async () => {}),
}));

import { runSourcedIssue } from './source-adapter.js';
import { linkLinearIssue, commentLinearIssue } from '../tasks/linear-cli.js';
import { linearTracker, runLinearIssue } from './linear.js';
import type { RunLinearIssueDeps } from './linear.js';
import type { ReviewHost } from './source-adapter.js';

function makeDeps(overrides: Partial<RunLinearIssueDeps> = {}): RunLinearIssueDeps {
  return { repoPath: '/repo', linearKey: 'lin_key', skillsDir: '/skills', ...overrides };
}

beforeEach(() => {
  vi.mocked(runSourcedIssue).mockClear();
  vi.mocked(linkLinearIssue).mockClear();
  vi.mocked(commentLinearIssue).mockClear();
});

describe('linearTracker', () => {
  it('derives a linear- task id and reads the issue through the skill variable', () => {
    const tracker = linearTracker(makeDeps());
    expect(tracker.taskId({ id: 'ENG-1', title: 't', description: '', labels: [], children: [], comments: [] })).toBe('linear-eng-1');
    expect(tracker.variables?.('ENG-1', { id: 'ENG-1', title: 't', description: '', labels: [], children: [], comments: [] })).toEqual({ ISSUE: 'ENG-1' });
    expect(tracker.secrets).toEqual({ LINEAR_API_KEY: 'lin_key' });
  });

  it('links the PR and posts the base-red notice as Linear comments', async () => {
    const task = { id: 'ENG-1', title: 't', description: '', labels: [], children: [], comments: [] };
    const tracker = linearTracker(makeDeps());
    await tracker.linkPr('ENG-1', task, 'https://github.com/owner/repo/pull/3');
    await tracker.signalBaseRed('ENG-1', task, 'base is red');
    expect(linkLinearIssue).toHaveBeenCalledWith('ENG-1', 'https://github.com/owner/repo/pull/3');
    expect(commentLinearIssue).toHaveBeenCalledWith('ENG-1', 'base is red');
  });
});

describe('runLinearIssue review surface', () => {
  let repo: string;
  beforeEach(async () => {
    vi.stubEnv('GITLAB_HOST', undefined);
    repo = await mkdtemp(join(tmpdir(), 'vanguard-linear-'));
    await execa('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(repo, { recursive: true, force: true });
  });

  async function hostFor(origin: string | undefined): Promise<ReviewHost> {
    if (origin !== undefined) await execa('git', ['remote', 'add', 'origin', origin], { cwd: repo });
    await runLinearIssue('ENG-1', makeDeps({ repoPath: repo }));
    const host = vi.mocked(runSourcedIssue).mock.calls[0]?.[3];
    if (host === undefined) throw new Error('runSourcedIssue was not called');
    return host;
  }

  it('picks glab when origin is on gitlab.com', async () => {
    expect((await hostFor('git@gitlab.com:group/project.git')).kind).toBe('glab');
  });

  it('keeps the GitHub path for a GitHub Enterprise remote', async () => {
    expect((await hostFor('git@github.corp.com:o/r.git')).kind).toBe('gh');
  });

  it('picks glab for a self-hosted remote that matches GITLAB_HOST', async () => {
    vi.stubEnv('GITLAB_HOST', 'https://git.example.com:8443');
    expect((await hostFor('git@git.example.com:group/project.git')).kind).toBe('glab');
  });

  it('keeps the GitHub path for a self-hosted remote when GITLAB_HOST is unset', async () => {
    expect((await hostFor('git@git.example.com:group/project.git')).kind).toBe('gh');
  });

  it('keeps the GitHub path when origin is a GitHub remote', async () => {
    expect((await hostFor('https://github.com/owner/repo.git')).kind).toBe('gh');
  });

  it('keeps the GitHub path when there is no origin remote', async () => {
    expect((await hostFor(undefined)).kind).toBe('gh');
  });
});
