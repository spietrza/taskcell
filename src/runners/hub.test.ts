import { describe, expect, test } from 'vitest';
import { hubReviewHost, hubTracker } from './hub.js';
import { githubReviewHost } from './github.js';

const stored = { id: 'hub-3', title: 'Add a health endpoint', body: 'GET /healthz answers 200' };

describe('hubTracker', () => {
  test('the task is the stored one — no tracker is asked', async () => {
    const tracker = hubTracker(stored);
    const { task } = await tracker.prepare('hub-3');
    expect(task).toMatchObject({ id: 'hub-3', title: 'Add a health endpoint', description: 'GET /healthz answers 200', labels: [], comments: [] });
    expect(tracker.taskId(task)).toBe('hub-3');
    expect(tracker.closeIssueOnMerge).toBeUndefined(); // no issue to close
  });

  test('nothing is written back to a tracker', async () => {
    const tracker = hubTracker(stored);
    const { task } = await tracker.prepare('hub-3');
    await expect(tracker.linkPr('hub-3', task, 'https://example/pr/1')).resolves.toBeUndefined();
    await expect(tracker.signalBaseRed('hub-3', task, 'red')).resolves.toBeUndefined();
  });
});

describe('hubReviewHost', () => {
  test('without a GitHub origin the result stays a local branch and nothing is labelled or posted', async () => {
    const host = hubReviewHost('/repos/app', undefined);
    expect(host.kind).toBe('local');
    await expect(host.addGateConfigLabel('https://example/pr/1')).resolves.toBeUndefined();
    await expect(host.addFailureLabel('https://example/pr/1', 'verify')).resolves.toBeUndefined();
  });

  test('with a GitHub origin the result is a pull request there, as for a GitHub issue', () => {
    const host = hubReviewHost('/repos/app', 'o/r');
    expect(host.kind).toBe('gh');
    expect(host.publishVerdict).toBe(githubReviewHost('/repos/app').publishVerdict);
  });
});
