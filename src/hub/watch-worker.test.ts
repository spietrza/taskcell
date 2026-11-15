import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunSummary } from '../wire.js';
import { NO_REMOTE_MESSAGE } from '../wire.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { tmpGitRepo, tmpRepo } from './test-kit.js';
import { composeSnippet, watchArgs, watchCommandLine, watchTarget, watchWorkerChecklist, workerCredentials, workerSeen, WORKER_RECENT_MS, type WatchTarget } from './watch-worker.js';

const run = (timestamp: string, extra: Partial<RunSummary> = {}): RunSummary => ({ taskId: 't', timestamp, stages: [], totalCostUsd: 0, anyFailed: false, trigger: 'watch', ...extra });
const gh: WatchTarget = { source: 'github', forge: 'github', slug: 'acme/widgets' };

describe('watch worker checklist', () => {
  test('GitHub snippet and command name the repo and credentials, not values, and keep the template host guards', () => {
    const snippet = composeSnippet(gh);
    expect(snippet).toContain('- --github-repo=acme/widgets');
    expect(snippet).toContain('CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}');
    expect(snippet).toContain('GH_TOKEN: ${GH_TOKEN}');
    expect(snippet).toContain('mem_limit: 1024m');
    expect(snippet).toContain('VANGUARD_MAX_SANDBOXES: "1"');
    expect(snippet).not.toContain('LINEAR_API_KEY');
    expect(watchArgs(gh, '.')).toEqual(['watch', '--loop-v1', '--source=github', '--github-repo=acme/widgets', '--repo=.', '--interval=120', '--llm-proxy']);
    expect(watchCommandLine(gh)).toBe('taskcell watch --loop-v1 --source=github --github-repo=acme/widgets --repo=. --interval=120 --llm-proxy');
  });

  test('credentials follow where the run publishes: Linear on a GitLab origin needs GITLAB_TOKEN', () => {
    expect(workerCredentials({ source: 'gitlab', forge: 'gitlab' })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'GITLAB_TOKEN']);
    expect(workerCredentials({ source: 'linear', forge: 'gitlab' })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'GITLAB_TOKEN', 'LINEAR_API_KEY']);
    expect(workerCredentials({ source: 'linear', forge: 'github' })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'LINEAR_API_KEY']);
    const gl: WatchTarget = { source: 'gitlab', forge: 'gitlab', slug: 'g/p' };
    expect(watchArgs(gl, '/work/repo')).toContain('--gitlab-project=g/p');
    expect(watchArgs(gl, '/work/repo')).toContain('--label=vanguard');
  });

  test('origin parsing uses the enable_factory_host detection', () => {
    expect(watchTarget('git@github.com:acme/widgets.git', undefined)).toEqual(gh);
    expect(watchTarget('https://github.com/acme/widgets/', undefined)).toEqual(gh);
    expect(watchTarget('ssh://git@github.com:22/acme/widgets.git', undefined)).toEqual(gh);
    expect(watchTarget('https://gitlab.com/g/sub/p.git', undefined)).toEqual({ source: 'gitlab', forge: 'gitlab', slug: 'g/sub/p' });
    // Not github.com: neither a lookalike host nor a path containing it.
    expect(() => watchTarget('https://notgithub.com/a/b.git', undefined)).toThrow(/not on github.com/);
    expect(() => watchTarget('https://evil.example/github.com/a/b', undefined)).toThrow(/not on github.com/);
    // GitHub Enterprise is `other` for enable_factory_host, so not GitLab here either.
    expect(() => watchTarget('https://ghe.corp.example/a/b.git', 'gitlab')).toThrow(/not on GitLab/);
    expect(() => watchTarget(null, undefined)).toThrow(NO_REMOTE_MESSAGE);
  });

  test('a slug outside the charset never reaches the command', () => {
    expect(() => watchTarget('https://github.com/a/b c;rm -rf.git', undefined)).toThrow(BadRequestError);
    expect(() => watchTarget('https://github.com/a/$(id).git', undefined)).toThrow(/Could not read the GitHub repository/);
    expect(() => watchTarget('https://gitlab.com/g/p;x', undefined)).toThrow(/Could not read the GitLab project/);
  });

  test('the configured task source wins; sources a worker cannot serve say so', () => {
    expect(watchTarget('git@github.com:acme/widgets.git', 'linear')).toEqual({ source: 'linear', forge: 'github', slug: 'acme/widgets' });
    // Linear needs no slug, so an origin on another host still gets a command.
    expect(watchTarget('https://git.example.org/x/y.git', 'linear')).toMatchObject({ source: 'linear', forge: 'github' });
    expect(() => watchTarget('git@github.com:acme/widgets.git', 'hub')).toThrow(/cannot read the hub board/);
    expect(() => watchTarget('git@github.com:acme/widgets.git', 'github-project')).toThrow(/--source project --project <number>/);
    expect(() => watchTarget('https://gitlab.com/g/p.git', 'github')).toThrow(/task source is GitHub Issues/);
  });

  test('a self-hosted GitLab names its host for the worker', () => {
    const prev = process.env.GITLAB_HOST;
    process.env.GITLAB_HOST = 'git.example.org';
    try {
      const t = watchTarget('git@git.example.org:g/p.git', 'linear');
      expect(t).toEqual({ source: 'linear', forge: 'gitlab', slug: 'g/p', gitlabHost: 'git.example.org' });
      expect(composeSnippet(t)).toContain('GITLAB_HOST: git.example.org');
      expect(watchCommandLine(t)).toMatch(/^GITLAB_HOST='git.example.org' taskcell watch /);
    } finally {
      if (prev === undefined) delete process.env.GITLAB_HOST;
      else process.env.GITLAB_HOST = prev;
    }
  });

  test('worker seen: recent, stale, and unknown when there are no watch records', () => {
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(workerSeen([], now)).toEqual({ seen: 'unknown' });
    const recent = new Date(now - 1000).toISOString();
    expect(workerSeen([run(recent)], now)).toEqual({ seen: 'recent', lastRunAt: recent });
    const old = new Date(now - WORKER_RECENT_MS - 1000).toISOString();
    expect(workerSeen([run(old)], now)).toEqual({ seen: 'stale', lastRunAt: old });
  });

  test('only watch-started runs count; an unreadable time is unknown, not stale', () => {
    const now = Date.now();
    const ts = new Date(now).toISOString();
    const { trigger: _trigger, ...manual } = run(ts);
    expect(workerSeen([manual, { ...manual, startedBy: 'owner' }], now).seen).toBe('unknown');
    expect(workerSeen([run('garbage')], now)).toEqual({ seen: 'unknown' });
    expect(workerSeen([run('garbage'), run(ts)], now)).toEqual({ seen: 'recent', lastRunAt: ts });
  });
});

describe('watchWorkerChecklist', () => {
  const prev = process.env.GITLAB_HOST;
  afterEach(() => {
    if (prev === undefined) delete process.env.GITLAB_HOST;
    else process.env.GITLAB_HOST = prev;
  });

  test('reads origin, the configured source and the watch records of the repo', async () => {
    delete process.env.GITLAB_HOST;
    const repo = await tmpGitRepo('https://gitlab.com/acme/widgets.git');
    await mkdir(join(repo, '.taskcell', 'runs', 'LIN-1'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify({ taskSource: 'linear', source: 'github' }));
    const at = '2026-11-14T12:00:00.000Z';
    await writeFile(join(repo, '.taskcell', 'runs', 'LIN-1', '2026-11-14T12-00-00-000Z-implement.json'), JSON.stringify({ taskId: 'LIN-1', timestamp: at, completed: true, stage: 'implement', trigger: 'watch' }));
    const c = await watchWorkerChecklist(repo, undefined, Date.parse('2026-11-15T00:00:00Z'));
    expect(c).toMatchObject({ source: 'linear', repoSlug: 'acme/widgets', credentials: ['CLAUDE_CODE_OAUTH_TOKEN', 'GITLAB_TOKEN', 'LINEAR_API_KEY'], seen: 'recent', lastRunAt: at });
    expect(c.command).toContain('--source=linear');
  });

  test('no remote is a 400 with one sentence', async () => {
    const repo = await tmpGitRepo();
    await expect(watchWorkerChecklist(repo)).rejects.toThrow(NO_REMOTE_MESSAGE);
    await expect(watchWorkerChecklist(await tmpRepo())).rejects.toThrow(BadRequestError);
  });
});
