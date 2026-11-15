import { describe, expect, test } from 'vitest';
import type { RunSummary } from '../wire.js';
import { composeSnippet, watchArgs, workerCredentials, workerSeen, WORKER_RECENT_MS } from './watch-worker.js';

const run = (timestamp: string, extra: Partial<RunSummary> = {}): RunSummary => ({ taskId: 't', timestamp, stages: [], totalCostUsd: 0, anyFailed: false, ...extra });

describe('watch worker checklist', () => {
  test('GitHub snippet and command name the repo and credentials, not values', () => {
    const snippet = composeSnippet('github', 'acme/widgets');
    expect(snippet).toContain('- --github-repo=acme/widgets');
    expect(snippet).toContain('CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}');
    expect(snippet).toContain('GH_TOKEN: ${GH_TOKEN}');
    expect(snippet).not.toContain('LINEAR_API_KEY');
    expect(watchArgs('github', 'acme/widgets', '.')).toEqual(['watch', '--loop-v1', '--source=github', '--github-repo=acme/widgets', '--repo=.', '--interval=120', '--llm-proxy']);
  });

  test('GitLab and Linear need their own credential and a label', () => {
    expect(workerCredentials('gitlab')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'GITLAB_TOKEN']);
    expect(workerCredentials('linear')).toContain('LINEAR_API_KEY');
    expect(watchArgs('gitlab', 'g/p', '/work/repo')).toContain('--gitlab-project=g/p');
    expect(watchArgs('gitlab', 'g/p', '/work/repo')).toContain('--label=vanguard');
  });

  test('worker seen: recent, stale, and unknown when there are no records', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(workerSeen([], now)).toEqual({ seen: 'unknown' });
    const recent = new Date(now - 1000).toISOString();
    expect(workerSeen([run(recent)], now)).toEqual({ seen: 'recent', lastRunAt: recent });
    const old = new Date(now - WORKER_RECENT_MS - 1000).toISOString();
    expect(workerSeen([run(old)], now)).toEqual({ seen: 'stale', lastRunAt: old });
  });

  test('hub-started and CI-only runs do not count as a worker', () => {
    const now = Date.now();
    const ts = new Date(now).toISOString();
    expect(workerSeen([run(ts, { startedBy: 'owner' }), run(ts, { source: 'ci' })], now).seen).toBe('unknown');
  });
});
