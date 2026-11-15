import { describe, expect, test } from 'vitest';
import { hubAdapter } from './hub.js';

const stored = { id: 'hub-3', title: 'Add a health endpoint', body: 'GET /healthz answers 200' };
const deps = { repoPath: '/repos/app' };

describe('hubAdapter', () => {
  test('the task is the stored one — no tracker is asked', async () => {
    const adapter = hubAdapter(stored, deps, undefined);
    const { task } = await adapter.prepare('hub-3');
    expect(task).toMatchObject({ id: 'hub-3', title: 'Add a health endpoint', description: 'GET /healthz answers 200', labels: [], comments: [] });
    expect(adapter.taskId(task)).toBe('hub-3');
    expect(adapter.closeIssueOnMerge).toBeUndefined(); // no issue to close
  });

  test('without a GitHub origin the result stays a local branch and nothing is written anywhere', async () => {
    const adapter = hubAdapter(stored, deps, undefined);
    expect(adapter.delivery).toBe('local');
    const { task } = await adapter.prepare('hub-3');
    await adapter.linkPr('hub-3', task, 'https://example/pr/1');
    await adapter.signalBaseRed('hub-3', task, 'red');
    await adapter.addGateConfigLabel('https://example/pr/1');
  });

  test('with a GitHub origin the result is a pull request there, as for a GitHub issue', () => {
    expect(hubAdapter(stored, deps, 'o/r').delivery).toBeUndefined();
  });
});
