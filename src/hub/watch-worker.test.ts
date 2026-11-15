import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { NO_REMOTE_MESSAGE } from '../wire.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { tmpGitRepo, tmpRepo } from './test-kit.js';
import { composeSnippet, watchArgs, watchCommandLine, watchTarget, watchWorkerChecklist, workerCredentials, workerSeen, WORKER_RECENT_MS, type WatchTarget } from './watch-worker.js';

const gh: WatchTarget = { source: 'github', forge: 'github', slug: 'acme/widgets' };
/** One metrics-branch line, watch-stamped when `trigger` is given. */
const line = (ts: string, trigger?: 'watch'): string => JSON.stringify({ taskId: 'T-1', ts, costUsd: 0, ...(trigger !== undefined ? { trigger } : {}) });

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
    expect(() => watchTarget('https://notgithub.com/a/b.git', undefined)).toThrow(/neither github.com/);
    expect(() => watchTarget('https://evil.example/github.com/a/b', undefined)).toThrow(/neither github.com/);
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
    // No source set and an unsupported host: say that, not "task source is GitHub Issues".
    expect(() => watchTarget('https://ghe.corp.example/a/b.git', undefined)).toThrow(/No task source is set/);
  });

  test('a self-hosted GitLab names its host for the worker', () => {
    const prev = process.env.GITLAB_HOST;
    process.env.GITLAB_HOST = 'git.example.org';
    try {
      const t = watchTarget('git@git.example.org:g/p.git', 'linear');
      expect(t).toEqual({ source: 'linear', forge: 'gitlab', slug: 'g/p', gitlabHost: 'git.example.org' });
      expect(composeSnippet(t)).toContain('GITLAB_HOST: "git.example.org"');
      process.env.GITLAB_HOST = 'https://git.example.org:8443';
      const withPort = watchTarget('ssh://git@git.example.org:2222/g/p.git', 'gitlab');
      expect(withPort.gitlabHost).toBe('https://git.example.org:8443');
      expect(composeSnippet(withPort)).toContain('GITLAB_HOST: "https://git.example.org:8443"');
      expect(watchCommandLine(withPort)).toMatch(/^GITLAB_HOST='https:\/\/git.example.org:8443' taskcell /);
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
    expect(workerSeen([recent], now)).toEqual({ seen: 'recent', lastRunAt: recent });
    const old = new Date(now - WORKER_RECENT_MS - 1000).toISOString();
    expect(workerSeen([old], now)).toEqual({ seen: 'stale', lastRunAt: old });
  });

  test('an unreadable or future-dated time is unknown, not recent', () => {
    const now = Date.now();
    const ts = new Date(now).toISOString();
    expect(workerSeen(['garbage'], now)).toEqual({ seen: 'unknown' });
    expect(workerSeen(['garbage', ts], now)).toEqual({ seen: 'recent', lastRunAt: ts });
    const future = new Date(now + 60 * 60_000).toISOString();
    expect(workerSeen([future], now)).toEqual({ seen: 'unknown' });
    expect(workerSeen([future, ts], now)).toEqual({ seen: 'recent', lastRunAt: ts });
  });

  test('a timestamp a little ahead (clock skew) counts as now; far ahead is unknown', () => {
    const now = Date.now();
    const soon = new Date(now + 60_000).toISOString();
    expect(workerSeen([soon], now)).toEqual({ seen: 'recent', lastRunAt: new Date(now).toISOString() });
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
    const c = await watchWorkerChecklist(repo, undefined, Date.parse('2026-11-15T00:00:00Z'), async () => '');
    expect(c).toMatchObject({ source: 'linear', repoSlug: 'acme/widgets', credentials: ['CLAUDE_CODE_OAUTH_TOKEN', 'GITLAB_TOKEN', 'LINEAR_API_KEY'], seen: 'recent', lastRunAt: at });
    expect(c.command).toContain('--source=linear');
  });

  test('only record files inside the window are read: an older file is skipped by its name, whatever it holds', async () => {
    const repo = await tmpGitRepo('https://github.com/acme/widgets.git');
    const dir = join(repo, '.taskcell', 'runs', 'T-1');
    await mkdir(dir, { recursive: true });
    const now = Date.parse('2026-11-15T00:00:00Z');
    // Named 30 days back but claiming a recent watch run: it is only "seen" if the file is opened.
    await writeFile(join(dir, '2026-10-16T00-00-00-000Z-implement.json'), JSON.stringify({ taskId: 'T-1', timestamp: '2026-11-14T12:00:00.000Z', completed: true, trigger: 'watch' }));
    expect((await watchWorkerChecklist(repo, undefined, now, async () => '')).seen).toBe('unknown');
    const at = '2026-11-14T12:00:00.000Z';
    await writeFile(join(dir, '2026-11-14T12-00-00-000Z-implement.json'), JSON.stringify({ taskId: 'T-1', timestamp: at, completed: true, trigger: 'watch' }));
    expect(await watchWorkerChecklist(repo, undefined, now, async () => '')).toMatchObject({ seen: 'recent', lastRunAt: at });
  });

  test('a worker on another machine is seen through the metrics branch; a CI sweep carries no stamp', async () => {
    const repo = await tmpGitRepo('https://github.com/acme/widgets.git');
    const at = '2026-11-14T12:00:00.000Z';
    const now = Date.parse('2026-11-15T00:00:00Z');
    expect(await watchWorkerChecklist(repo, undefined, now, async () => `${line(at, 'watch')}\n`)).toMatchObject({ seen: 'recent', lastRunAt: at });
    expect((await watchWorkerChecklist(repo, undefined, now, async () => `${line(at)}\n`)).seen).toBe('unknown');
    expect((await watchWorkerChecklist(repo, undefined, now, async () => { throw new Error('no branch'); })).seen).toBe('unknown');
  });

  test('the metrics branch is read from its tail and the scan stops at the first line older than the window', async () => {
    const repo = await tmpGitRepo('https://github.com/acme/widgets.git');
    const now = Date.parse('2026-11-15T00:00:00Z');
    const recent = '2026-11-14T12:00:00.000Z';
    const old = '2026-10-01T00:00:00.000Z';
    // Head lines are never parsed (a malformed one does not matter); the old line ends the scan, so the
    // out-of-order watch line before it is not reached either.
    const text = ['{not json', line(recent, 'watch'), line(old), line(recent), ''].join('\n');
    expect((await watchWorkerChecklist(repo, undefined, now, async () => text)).seen).toBe('unknown');
    const withTail = `${text}${line('2026-11-14T13:00:00.000Z', 'watch')}\n`;
    expect(await watchWorkerChecklist(repo, undefined, now, async () => withTail)).toMatchObject({ seen: 'recent', lastRunAt: '2026-11-14T13:00:00.000Z' });
  });

  test('no remote is a 400 with one sentence', async () => {
    const repo = await tmpGitRepo();
    await expect(watchWorkerChecklist(repo)).rejects.toThrow(NO_REMOTE_MESSAGE);
    await expect(watchWorkerChecklist(await tmpRepo())).rejects.toThrow(BadRequestError);
  });
});
