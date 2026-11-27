import { describe, expect, it, vi } from 'vitest';
import { githubForgeCi, gitlabForgeCi } from './base-ci.js';

const gh = (out: string | Error) => vi.fn(async (_args: string[]) => { if (out instanceof Error) throw out; return out; });

describe('githubForgeCi', () => {
  it('green: all completed runs success/skipped/neutral', async () => {
    const ci = githubForgeCi('o/r', gh('completed\tsuccess\ncompleted\tskipped\ncompleted\tneutral\n'));
    expect(await ci.greenOn('abc123')).toBe('GitHub checks on abc123');
  });
  it('failed run is not green', async () => {
    expect(await githubForgeCi('o/r', gh('completed\tsuccess\ncompleted\tfailure\n')).greenOn('abc')).toBeUndefined();
  });
  it('pending-only and none are not green', async () => {
    expect(await githubForgeCi('o/r', gh('in_progress\t\n')).greenOn('abc')).toBeUndefined();
    expect(await githubForgeCi('o/r', gh('')).greenOn('abc')).toBeUndefined();
  });
  it('API error is not green', async () => {
    expect(await githubForgeCi('o/r', gh(new Error('boom'))).greenOn('abc')).toBeUndefined();
  });
});

describe('gitlabForgeCi', () => {
  it('green: newest pipeline success', async () => {
    const glab = gh(JSON.stringify([{ id: 42, status: 'success' }]));
    expect(await gitlabForgeCi('g/p', glab).greenOn('abc123')).toBe('GitLab pipeline 42 on abc123');
    expect(glab.mock.calls[0]![0][1]).toContain('projects/g%2Fp/pipelines?sha=abc123');
  });
  it('failed pipeline is not green', async () => {
    expect(await gitlabForgeCi('g/p', gh(JSON.stringify([{ id: 1, status: 'failed' }]))).greenOn('abc')).toBeUndefined();
  });
  it('none is not green', async () => {
    expect(await gitlabForgeCi('g/p', gh('[]')).greenOn('abc')).toBeUndefined();
  });
  it('API error is not green', async () => {
    expect(await gitlabForgeCi('g/p', gh(new Error('boom'))).greenOn('abc')).toBeUndefined();
  });
});
