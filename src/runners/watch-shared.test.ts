import { describe, it, expect, vi } from 'vitest';
import { specComment, holdMessage, commentAndRevert, failureOrCapComment, triageAgentRun } from './watch-shared.js';
import * as watch from './watch.js';
import * as linear from './linear.js';
import * as github from './github.js';
import * as gitlab from './gitlab.js';
import type { Task } from '../tasks/fetcher.js';

describe('watch-shared', () => {
  it('wraps a spec in the tagged comment, white-label drops the heading', () => {
    expect(specComment('x')).toMatch(/^Taskcell tech spec:\n\n<[a-z_]+>\nx\n<\/[a-z_]+>$/);
    expect(specComment('x', { whiteLabel: true })).toMatch(/^Tech spec:/);
  });

  it('holdMessage names the claim note and the resume step', () => {
    expect(holdMessage('Kept.', 'move it back')).toContain('Kept. To retry once the secret is out of the change, move it back.');
  });

  it('commentAndRevert runs both, and tolerates no revert', async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    await commentAndRevert(a(), b());
    await commentAndRevert(a());
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('failureOrCapComment formats a plain failure', () => {
    expect(failureOrCapComment('Taskcell run failed', new Error('boom'))).toContain('boom');
  });

  it('triageAgentRun parks a vague ticket and otherwise delegates', async () => {
    const vague = { id: '1', title: 't', description: '', labels: [], comments: [] } as unknown as Task;
    const comment = vi.fn(async () => undefined);
    const toNeedsInfo = vi.fn(async () => undefined);
    const runner = vi.fn(async () => ({ prUrl: 'u' }));
    const out = await triageAgentRun('1', { fetch: async () => vague }, runner, { comment, toNeedsInfo });
    expect(out).toEqual({ parked: true });
    expect(comment).toHaveBeenCalledOnce();
    expect(toNeedsInfo).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
  });

  it('each source module owns its primitives; watch.ts re-exports them', () => {
    expect(watch.linearWatchPrimitives).toBe(linear.linearWatchPrimitives);
    expect(watch.linearSpecPrimitives).toBe(linear.linearSpecPrimitives);
    expect(watch.githubIssueWatchPrimitives).toBe(github.githubIssueWatchPrimitives);
    expect(watch.githubSpecPrimitives).toBe(github.githubSpecPrimitives);
    expect(watch.githubProjectWatchPrimitives).toBe(github.githubProjectWatchPrimitives);
    expect(watch.gitlabWatchPrimitives).toBe(gitlab.gitlabWatchPrimitives);
    expect(watch.gitlabSpecPrimitives).toBe(gitlab.gitlabSpecPrimitives);
  });
});
