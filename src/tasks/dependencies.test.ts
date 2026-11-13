import { describe, expect, it, vi } from 'vitest';
import { applyDependencyGate, checkDependencies, parseBodyDependencies, parseStartDate } from './dependencies.js';
import type { GhRunner } from './github.js';
import type { Task } from './fetcher.js';

const task = (number: number, description = '', labels: string[] = ['ready for agent']): Task => ({
  id: `o/r#${number}`, title: 't', description, labels, children: [], comments: [], ref: String(number),
});

/** issues: number -> api JSON; blocked: number -> native blocker numbers; comments: the issue's comments. */
function fakeGh(issues: Record<string, object>, blocked: Record<string, number[]> = {}, comments: object[] = []): GhRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    const path = args[1] ?? '';
    const native = /repos\/o\/r\/issues\/(\d+)\/dependencies\/blocked_by/.exec(path);
    if (native) return JSON.stringify((blocked[native[1]!] ?? []).map((number) => ({ number, repository_url: 'https://api.github.com/repos/o/r' })));
    const m = /repos\/(.+)\/issues\/(\d+)$/.exec(path);
    if (args[0] === 'api' && m) {
      const issue = issues[`${m[1]}#${m[2]}`];
      if (issue === undefined) throw new Error('gh: Not Found (HTTP 404)');
      return JSON.stringify(issue);
    }
    return '';
  });
}

describe('parsing', () => {
  it('reads Depends on lines in the common forms', () => {
    expect(parseBodyDependencies('o/r', 'x\nDepends on #3\nDepends on: a/b#4, #5')).toEqual([
      { repo: 'o/r', number: 3 }, { repo: 'a/b', number: 4 }, { repo: 'o/r', number: 5 },
    ]);
    expect(parseBodyDependencies('o/r', 'Depends on https://github.com/x/y/issues/12\n**Depends on:** #7 and #8\n- Depends on #9')).toEqual([
      { repo: 'x/y', number: 12 }, { repo: 'o/r', number: 7 }, { repo: 'o/r', number: 8 }, { repo: 'o/r', number: 9 },
    ]);
  });
  it('stops at prose and rejects path-like repos', () => {
    expect(parseBodyDependencies('o/r', 'Depends on #3 (unlike #4 which is separate)')).toEqual([{ repo: 'o/r', number: 3 }]);
    expect(parseBodyDependencies('o/r', 'Depends on ../..#5')).toEqual([]);
  });
  it('reads Start dates, flags impossible ones', () => {
    expect(parseStartDate('Start: 2030-01-02')).toEqual({ date: new Date('2030-01-02T00:00:00Z') });
    expect(parseStartDate('**Start:** 2030-6-1 (after freeze)')).toEqual({ date: new Date('2030-06-01T00:00:00Z') });
    expect(parseStartDate('Start: 2030-02-31')).toHaveProperty('invalid');
    expect(parseStartDate('Start: soon')).toBeUndefined();
    expect(parseStartDate('nothing')).toBeUndefined();
  });
  it('ignores prose Start lines and directives in code fences or quotes', () => {
    expect(parseStartDate('Start: 3 workers')).toBeUndefined();
    expect(parseStartDate('Start: 10:30')).toBeUndefined();
    expect(parseStartDate('```\nStart: 2030-02-31\n```\nStart: 2030-01-02')).toEqual({ date: new Date('2030-01-02T00:00:00Z') });
    expect(parseBodyDependencies('o/r', '```md\nDepends on #3\n```\n> Depends on #4\nDepends on #5')).toEqual([{ repo: 'o/r', number: 5 }]);
  });
  it('parses pathological bodies quickly', () => {
    const t0 = Date.now();
    parseBodyDependencies('o/r', `Depends on${'*'.repeat(60_000)}`);
    parseStartDate(`Start: 1${' '.repeat(60_000)}x`);
    parseStartDate('\n'.repeat(60_000));
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('checkDependencies', () => {
  it('is ready without dependencies', async () => {
    expect((await checkDependencies('o/r', task(1), fakeGh({}))).status).toBe('ready');
  });
  it('waits on an open body dependency, ready once closed as completed', async () => {
    const t = task(1, 'Depends on #2');
    expect(await checkDependencies('o/r', t, fakeGh({ 'o/r#2': { state: 'open' } }))).toMatchObject({ status: 'waiting', blockers: [{ repo: 'o/r', number: 2 }] });
    expect((await checkDependencies('o/r', task(1, 'Depends on #2'), fakeGh({ 'o/r#2': { state: 'closed', state_reason: 'completed' } }))).status).toBe('ready');
    expect((await checkDependencies('o/r', task(1, 'Depends on #2'), fakeGh({ 'o/r#2': { state: 'closed', state_reason: 'not_planned' } }))).status).toBe('invalid');
    expect(await checkDependencies('o/r', task(1, 'Depends on #2'), fakeGh({ 'o/r#2': { state: 'closed', state_reason: 'duplicate' } }))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('duplicate') });
    expect((await checkDependencies('o/r', task(1, 'Depends on #2'), fakeGh({ 'o/r#2': { state: 'closed', state_reason: null } }))).status).toBe('ready');
  });
  it('treats a merged PR as met and a closed unmerged PR as unmet', async () => {
    expect((await checkDependencies('o/r', task(1, 'Depends on #2'), fakeGh({ 'o/r#2': { state: 'closed', pull_request: { merged_at: '2030-01-01' } } }))).status).toBe('ready');
    expect((await checkDependencies('o/r', task(1, 'Depends on #2'), fakeGh({ 'o/r#2': { state: 'closed', state_reason: 'completed', pull_request: { merged_at: null } } }))).status).toBe('invalid');
  });
  it('honours native blocked-by relations', async () => {
    expect((await checkDependencies('o/r', task(1), fakeGh({ 'o/r#2': { state: 'open' } }, { 1: [2] }))).status).toBe('waiting');
  });
  it('looks cross-repo refs up in their own repo', async () => {
    const gh = fakeGh({ 'a/b#2': { state: 'closed', state_reason: 'completed' }, 'o/r#2': { state: 'open' } });
    expect((await checkDependencies('o/r', task(1, 'Depends on a/b#2'), gh)).status).toBe('ready');
  });
  it('blocks until a future start date', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(await checkDependencies('o/r', task(1, 'Start: 2030-06-01'), fakeGh({}), now)).toMatchObject({ status: 'waiting' });
    expect((await checkDependencies('o/r', task(1, 'Start: 2029-06-01'), fakeGh({}), now)).status).toBe('ready');
  });
  it('flags cycles and missing references as invalid', async () => {
    const cyc = fakeGh({ 'o/r#2': { state: 'open' } }, { 2: [1] });
    expect(await checkDependencies('o/r', task(1, 'Depends on #2'), cyc)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('cycle') });
    expect(await checkDependencies('o/r', task(1, 'Depends on #9'), fakeGh({}))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('does not exist') });
  });
  it('flags a deleted dependency (HTTP 410) as invalid', async () => {
    const gh: GhRunner = async (args) => {
      if ((args[1] ?? '').endsWith('/dependencies/blocked_by')) return '[]';
      throw new Error('gh: This issue was deleted (HTTP 410)');
    };
    expect(await checkDependencies('o/r', task(1, 'Depends on #2'), gh)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('deleted') });
  });
  it('ignores Depends on lines in a dependency body (untrusted text cannot fake a cycle or point lookups elsewhere)', async () => {
    const gh = fakeGh({ 'o/r#2': { state: 'open', body: 'Depends on #1\nDepends on evil/repo#1' } });
    expect(await checkDependencies('o/r', task(1, 'Depends on #2'), gh)).toMatchObject({ status: 'waiting' });
    const paths = (gh as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[])[1]);
    expect(paths.some((p) => p?.includes('evil/repo'))).toBe(false);
  });
  it('reports a failed lookup as error, not ready, without retrying a 4xx', async () => {
    const gh = vi.fn(async () => { throw new Error('HTTP 403 SAML'); });
    expect((await checkDependencies('o/r', task(1, 'Depends on #2'), gh)).status).toBe('error');
    expect(gh).toHaveBeenCalledTimes(1);
  });
});

describe('applyDependencyGate', () => {
  it('parks a blocked issue with one comment, and does not repeat it', async () => {
    const gh = fakeGh({ 'o/r#2': { state: 'open' } });
    const log = vi.fn();
    expect(await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', gh, log })).toEqual([]);
    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[]).join(' '));
    expect(calls.filter((c) => c.startsWith('issue comment'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('--add-label taskcell:waiting') && c.includes('--remove-label ready for agent'))).toBe(true);
    const again = fakeGh({ 'o/r#2': { state: 'open' } });
    await applyDependencyGate([task(1, 'Depends on #2', ['ready for agent', 'taskcell:waiting'])], { repo: 'o/r', trigger: 'ready for agent', gh: again, log });
    expect((again as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[0] as string[])[1] === 'comment')).toBe(false);
  });
  it('passes through issues with no dependencies', async () => {
    const t = task(1);
    expect(await applyDependencyGate([t], { repo: 'o/r', trigger: 'x', gh: fakeGh({}) })).toEqual([{ ...t, dependsOn: [] }]);
  });
  it('sends a cycle to needs info', async () => {
    const gh = fakeGh({ 'o/r#2': { state: 'open' } }, { 2: [1] });
    await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', needsInfoLabel: 'needs info', gh, log: vi.fn() });
    expect((gh as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[0] as string[]).includes('needs info'))).toBe(true);
  });
  it('removes a stale waiting label from a ready issue', async () => {
    const base = fakeGh({});
    const gh: GhRunner = vi.fn(async (args: string[]) => (args.at(-1) === 'labels' ? JSON.stringify({ labels: [{ name: 'taskcell:waiting' }] }) : base(args)));
    const out = await applyDependencyGate([task(1, '', ['ready for agent', 'taskcell:waiting'])], { repo: 'o/r', trigger: 'ready for agent', gh });
    expect(out).toHaveLength(1);
    expect((gh as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[0] as string[]).join(' ').includes('--remove-label taskcell:waiting'))).toBe(true);
  });
  it('does not repeat a comment identical to the newest trusted one (label edit failed last poll)', async () => {
    const first = fakeGh({ 'o/r#2': { state: 'open' } });
    await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', gh: first, log: vi.fn() });
    const posted = (first as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === 'comment')!;
    const body = posted[posted.indexOf('--body') + 1]!;
    const again = fakeGh({ 'o/r#2': { state: 'open' } }, {}, [{ author: { login: 'github-actions[bot]' }, authorAssociation: 'NONE', body }]);
    await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', gh: again, log: vi.fn() });
    const calls = (again as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[]).join(' '));
    expect(calls.some((c) => c.startsWith('issue comment'))).toBe(false);
    expect(calls.some((c) => c.includes('--add-label taskcell:waiting'))).toBe(true);
  });
  it('sends a lookup that fails again right after a resume to needs info instead of looping', async () => {
    const marker = '<!-- taskcell:waiting trigger="ready for agent" kind="error" -->';
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === 'api') throw new Error('HTTP 403 SAML');
      if (args[1] === 'view') return JSON.stringify({ comments: [{ author: { login: 'github-actions[bot]' }, authorAssociation: 'NONE', body: `x ${marker}` }] });
      return '';
    }) as unknown as GhRunner;
    await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', needsInfoLabel: 'needs info', gh, log: vi.fn() });
    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[]).join(' '));
    expect(calls.some((c) => c.includes('--add-label needs info'))).toBe(true);
    expect(calls.some((c) => c.includes('taskcell:waiting'))).toBe(false);
  });
  it('leaves an issue with no declared dependencies triggered when only the blocked-by probe fails', async () => {
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === 'api') throw new Error('HTTP 403');
      return '';
    }) as unknown as GhRunner;
    expect(await applyDependencyGate([task(1, 'no deps here')], { repo: 'o/r', trigger: 'ready for agent', gh, log: vi.fn() })).toEqual([]);
    expect((gh as ReturnType<typeof vi.fn>).mock.calls.every((c) => (c[0] as string[])[0] === 'api')).toBe(true);
  });
  it('comments once on a lookup error and promises only the resume mechanism', async () => {
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === 'api') throw new Error('HTTP 403 SAML');
      if (args[1] === 'view') return '{"comments":[]}';
      return '';
    }) as unknown as GhRunner;
    await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', gh, log: vi.fn() });
    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[]).join(' '));
    expect(calls.filter((c) => c.startsWith('issue comment'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('--add-label taskcell:waiting'))).toBe(true);
  });
  it('does not park the issue when the comment fails (trigger stays)', async () => {
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'comment') throw new Error('boom');
      if (args[0] === 'issue' && args[1] === 'view') return '{"comments":[]}';
      if (args[0] === 'api') return JSON.stringify({ state: 'open' });
      return '';
    }) as unknown as GhRunner;
    await applyDependencyGate([task(1, 'Depends on #2')], { repo: 'o/r', trigger: 'ready for agent', gh, log: vi.fn() });
    expect((gh as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[0] as string[])[1] === 'edit')).toBe(false);
  });
  it('resolves a native cross-repo blocker in its own repo, and errors when it names none', async () => {
    const gh = vi.fn(async (args: string[]) => {
      const p = args[1] ?? '';
      if (p.endsWith('/issues/1/dependencies/blocked_by')) return JSON.stringify([{ number: 5, repository_url: 'https://api.github.com/repos/a/b' }]);
      if (p === 'repos/a/b/issues/5') return JSON.stringify({ state: 'closed', state_reason: 'completed' });
      if (p.endsWith('/dependencies/blocked_by')) return '[]';
      throw new Error('unexpected ' + p);
    }) as unknown as GhRunner;
    expect((await checkDependencies('o/r', task(1), gh)).status).toBe('ready');
    const bare = (async () => JSON.stringify([{ number: 5 }])) as GhRunner;
    expect((await checkDependencies('o/r', task(1), bare)).status).toBe('error');
  });
  it('treats an unreadable cross-repo 404 as a lookup error, not a missing reference', async () => {
    const v = await checkDependencies('o/r', task(1, 'Depends on a/b#2'), fakeGh({}));
    expect(v.status).toBe('error');
  });
  it('retries a transient failure', async () => {
    let n = 0;
    const gh = (async () => { if (n++ < 2) throw new Error('HTTP 502'); return '[]'; }) as GhRunner;
    expect((await checkDependencies('o/r', task(1), gh)).status).toBe('ready');
  });
});
