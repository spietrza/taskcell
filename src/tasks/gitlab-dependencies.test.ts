import { describe, expect, it, vi } from 'vitest';
import { applyGitlabDependencyGate, checkGitlabDependencies, parseGitlabBodyDependencies } from './gitlab-dependencies.js';
import type { GlabRunner } from './gitlab.js';
import type { Task } from './fetcher.js';

const task = (number: number, description = '', labels: string[] = ['ready for agent'], extra: Partial<Task> = {}): Task => ({
  id: `g/p#${number}`, title: 't', description, labels, children: [], comments: [], ref: String(number), ...extra,
});

/** issues: "project#iid" -> API JSON; blocked: iid -> blocker iids (same project); notes: the issue's notes by the bot, newest first. */
function fakeGlab(issues: Record<string, object>, blocked: Record<string, number[]> = {}, notes: string[] = []): GlabRunner {
  return vi.fn(async (args: string[]) => {
    const path = args[1] ?? '';
    if (args[0] === 'api' && path === 'user') return '{"username":"bot"}';
    if (args[0] === 'api' && /\/notes\?/.test(path)) return JSON.stringify(notes.map((body) => ({ body, system: false, author: { username: 'bot' } })));
    const links = /projects\/(.+)\/issues\/(\d+)\/links$/.exec(path);
    if (args[0] === 'api' && links) {
      const project = decodeURIComponent(links[1]!);
      return JSON.stringify((blocked[links[2]!] ?? []).map((iid) => ({ iid, link_type: 'is_blocked_by', references: { full: `${project}#${iid}` } })));
    }
    const m = /projects\/(.+)\/issues\/(\d+)$/.exec(path);
    if (args[0] === 'api' && m) {
      const issue = issues[`${decodeURIComponent(m[1]!)}#${m[2]}`];
      if (issue === undefined) throw new Error('glab: 404 Not Found (HTTP 404)');
      return JSON.stringify(issue);
    }
    return '';
  });
}

const open = { state: 'opened' };
const closed = { state: 'closed' };
const calls = (glab: GlabRunner): string[][] => (glab as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string[]);
const notesPosted = (glab: GlabRunner): string[] => calls(glab).filter((a) => a[1] === 'note').map((a) => a.at(-1)!);
const labelEdits = (glab: GlabRunner): string[] => calls(glab).filter((a) => a[1] === 'update').map((a) => a.join(' '));

describe('parsing', () => {
  it('reads Depends on lines', () => {
    expect(parseGitlabBodyDependencies('g/p', 'Depends on #3\nDepends on: a/b/c#4, #5 and x/y#6')).toEqual([
      { repo: 'g/p', number: 3 }, { repo: 'a/b/c', number: 4 }, { repo: 'g/p', number: 5 }, { repo: 'x/y', number: 6 },
    ]);
    expect(parseGitlabBodyDependencies('g/p', 'Depends on #3 (unlike #4)\nDepends on ../..#5')).toEqual([{ repo: 'g/p', number: 3 }]);
  });
  it('reads issue URLs of this instance and keeps reading after a merge request', () => {
    expect(parseGitlabBodyDependencies('g/p', 'Depends on https://gl.example/a/b/c/-/issues/12, https://gl.example/x/y/issues/7.', 'gl.example')).toEqual([
      { repo: 'a/b/c', number: 12 }, { repo: 'x/y', number: 7 },
    ]);
    expect(parseGitlabBodyDependencies('g/p', 'Depends on https://other.example/a/b/-/issues/12', 'gl.example')).toEqual([]);
    expect(parseGitlabBodyDependencies('g/p', 'Depends on !12, #3 and https://gl.example/a/b/-/merge_requests/4 #5')).toEqual([{ repo: 'g/p', number: 3 }, { repo: 'g/p', number: 5 }]);
  });
  it('ignores directives in code fences or quotes', () => {
    expect(parseGitlabBodyDependencies('g/p', '```md\nDepends on #3\n```\n> Depends on #4\nDepends on #5')).toEqual([{ repo: 'g/p', number: 5 }]);
  });
  it('parses pathological bodies quickly', () => {
    const t0 = Date.now();
    parseGitlabBodyDependencies('g/p', `Depends on${'*'.repeat(60_000)}`);
    parseGitlabBodyDependencies('g/p', `Depends on ${'a/'.repeat(30_000)}`);
    parseGitlabBodyDependencies('g/p', `Depends on https://h/${'a/'.repeat(30_000)}-/issues/x`);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('checkGitlabDependencies', () => {
  it('is ready without dependencies, with one read', async () => {
    const glab = fakeGlab({});
    expect(await checkGitlabDependencies('g/p', task(1), glab)).toEqual({ status: 'ready', dependsOn: [] });
    expect(calls(glab).map((a) => a[1])).toEqual(['projects/g%2Fp/issues/1/links']);
  });
  it('waits on an open body dependency and is ready once closed', async () => {
    const body = 'Depends on #2';
    expect(await checkGitlabDependencies('g/p', task(1, body), fakeGlab({ 'g/p#2': open }))).toMatchObject({ status: 'waiting', reason: 'waiting for g/p#2' });
    expect(await checkGitlabDependencies('g/p', task(1, body), fakeGlab({ 'g/p#2': closed }))).toMatchObject({ status: 'ready' });
  });
  it('treats a dependency that was moved or closed as a duplicate as unmet', async () => {
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #2'), fakeGlab({ 'g/p#2': { ...closed, moved_to_id: 7 } }))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('moved') });
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #2'), fakeGlab({ 'g/p#2': { ...closed, duplicated_to_id: 7 } }))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('duplicate') });
  });
  it('uses is-blocked-by links', async () => {
    expect(await checkGitlabDependencies('g/p', task(1), fakeGlab({ 'g/p#2': open }, { '1': [2] }))).toMatchObject({ status: 'waiting' });
  });
  it('looks cross-project refs and same-instance URLs up in their own project', async () => {
    const glab = fakeGlab({ 'a/b#2': closed, 'g/p#2': open });
    expect((await checkGitlabDependencies('g/p', task(1, 'Depends on a/b#2'), glab)).status).toBe('ready');
    const byUrl = task(1, 'Depends on https://gl.example/a/b/-/issues/2', undefined, { url: 'https://gl.example/g/p/-/issues/1' });
    expect((await checkGitlabDependencies('g/p', byUrl, glab)).status).toBe('ready');
    expect(await checkGitlabDependencies('g/p', { ...byUrl, url: 'https://self.example/g/p/-/issues/1' }, glab)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('another GitLab instance') });
  });
  it('refuses a merge request as a dependency', async () => {
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on !12, #3'), fakeGlab({ 'g/p#3': closed }))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('merge requests cannot be dependencies (!12)') });
  });
  it('waits for a future start date, from the issue or the body, and validates both', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const native = (startDate: string): Task => task(1, '', undefined, { startDate });
    expect(await checkGitlabDependencies('g/p', native('2030-02-01'), fakeGlab({}), now)).toMatchObject({ status: 'waiting' });
    expect(await checkGitlabDependencies('g/p', native('2030-13-45'), fakeGlab({}), now)).toMatchObject({ status: 'invalid' });
    expect(await checkGitlabDependencies('g/p', task(1, 'Start: 2030-02-01'), fakeGlab({}), now)).toMatchObject({ status: 'waiting' });
    expect(await checkGitlabDependencies('g/p', task(1, 'Start: 2029-02-01'), fakeGlab({}), now)).toMatchObject({ status: 'ready' });
    expect(await checkGitlabDependencies('g/p', task(1, 'Start: 2030-02-31'), fakeGlab({}), now)).toMatchObject({ status: 'invalid' });
  });
  it('flags cycles and missing references, same-project or not, as invalid', async () => {
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #2'), fakeGlab({ 'g/p#2': open }, { '2': [1] }))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('cycle') });
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #9'), fakeGlab({}))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('does not exist') });
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on o/x#9'), fakeGlab({}))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('not readable with this token') });
  });
  it('flags a chain of more than 50 issues', async () => {
    const issues = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`g/p#${i + 2}`, open]));
    const chain = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [String(i + 1), [i + 2]]));
    expect(await checkGitlabDependencies('g/p', task(1), fakeGlab(issues, chain))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('too large') });
  });
  it('ignores Depends on lines in a dependency body', async () => {
    const glab = fakeGlab({ 'g/p#2': { ...open, description: 'Depends on #1\nDepends on evil/repo#1' } });
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #2'), glab)).toMatchObject({ status: 'waiting' });
    expect(calls(glab).some((a) => a[1]?.includes('evil'))).toBe(false);
  });
  it('reads the HTTP status from stderr, not from the command line', async () => {
    const failing = (stderr: string): GlabRunner => async (args) => {
      throw Object.assign(new Error(`Command failed: glab ${args.join(' ')}`), { stderr });
    };
    // Issue #404 of a project named app-404: a 403 on its links is an error, not "no links".
    expect((await checkGitlabDependencies('g/app-404', { ...task(404), id: 'g/app-404#404' }, failing('glab: 403 Forbidden (HTTP 403)'))).status).toBe('error');
    expect((await checkGitlabDependencies('g/p', task(1), failing('glab: 404 Not Found (HTTP 404)'))).status).toBe('ready');
  });
  it('reports a failed lookup as error without retrying a 4xx, and a link that names no project', async () => {
    const glab = vi.fn(async () => { throw new Error('glab: 403 Forbidden (HTTP 403)'); });
    expect((await checkGitlabDependencies('g/p', task(1, 'Depends on #2'), glab)).status).toBe('error');
    expect(glab).toHaveBeenCalledTimes(1);
    const bare = (async () => JSON.stringify([{ iid: 5, link_type: 'is_blocked_by' }])) as GlabRunner;
    expect((await checkGitlabDependencies('g/p', task(1), bare)).status).toBe('error');
  });
  it('retries a transient failure', async () => {
    let n = 0;
    const glab = (async () => { if (n++ < 2) throw new Error('glab: (HTTP 502)'); return '[]'; }) as GlabRunner;
    expect((await checkGitlabDependencies('g/p', task(1), glab)).status).toBe('ready');
  });
});

describe('applyGitlabDependencyGate', () => {
  const log = (): void => undefined;
  const opts = { project: 'g/p', trigger: 'ready for agent', needsInfoLabel: 'needs info', log };
  const forbidden = (notes: string[] = []): GlabRunner => {
    const base = fakeGlab({}, {}, notes);
    return vi.fn(async (args: string[]) => {
      if (args[0] === 'api' && /\/issues\/\d+(\/links)?$/.test(args[1] ?? '')) throw new Error('glab: 403 Forbidden (HTTP 403)');
      return base(args);
    });
  };

  it('passes ready tasks through with dependsOn', async () => {
    const out = await applyGitlabDependencyGate([task(1, 'Depends on #2')], { ...opts, glab: fakeGlab({ 'g/p#2': closed }) });
    expect(out.map((t) => t.dependsOn)).toEqual([[{ repo: 'g/p', number: 2 }]]);
  });
  it('holds a waiting task with the label created first, one note and the trigger kept', async () => {
    const glab = fakeGlab({ 'g/p#2': open });
    expect(await applyGitlabDependencyGate([task(1, 'Depends on #2')], { ...opts, glab })).toEqual([]);
    const writes = calls(glab).filter((a) => a[0] !== 'api').map((a) => `${a[0]} ${a[1]}`);
    expect(writes).toEqual(['label create', 'issue note', 'issue update']);
    expect(labelEdits(glab)[0]).toContain('--label taskcell::waiting');
    expect(labelEdits(glab)[0]).not.toContain('--unlabel');
    const again = fakeGlab({ 'g/p#2': open });
    await applyGitlabDependencyGate([task(1, 'Depends on #2', ['ready for agent', 'vanguard::waiting'])], { ...opts, glab: again });
    expect(calls(again).every((a) => a[0] === 'api')).toBe(true);
  });
  it('does not repeat a note identical to the newest one by the bot (label edit failed last poll)', async () => {
    const first = fakeGlab({ 'g/p#2': open });
    await applyGitlabDependencyGate([task(1, 'Depends on #2')], { ...opts, glab: first });
    const again = fakeGlab({ 'g/p#2': open }, {}, notesPosted(first));
    await applyGitlabDependencyGate([task(1, 'Depends on #2')], { ...opts, glab: again });
    expect(notesPosted(again)).toEqual([]);
    expect(labelEdits(again)).toHaveLength(1);
  });
  it('does not touch labels when the note fails', async () => {
    const base = fakeGlab({ 'g/p#2': open });
    const glab: GlabRunner = vi.fn(async (args: string[]) => {
      if (args[1] === 'note') throw new Error('boom');
      return base(args);
    });
    const lines: string[] = [];
    await applyGitlabDependencyGate([task(1, 'Depends on #2')], { ...opts, glab, log: (line) => lines.push(line) });
    expect(labelEdits(glab)).toEqual([]);
    expect(lines.at(-1)).toContain('could not be recorded');
  });
  it('holds an issue with a trigger in the taskcell:: scope by the note alone', async () => {
    const glab = fakeGlab({ 'g/p#2': open });
    await applyGitlabDependencyGate([task(1, 'Depends on #2', ['taskcell::go'])], { ...opts, trigger: 'taskcell::go', glab });
    expect(notesPosted(glab)).toHaveLength(1);
    expect(calls(glab).some((a) => a.includes('taskcell::waiting'))).toBe(false);
  });
  it('drops a stale waiting label from a ready task', async () => {
    const glab = fakeGlab({});
    const out = await applyGitlabDependencyGate([task(1, '', ['ready for agent', 'taskcell::waiting'])], { ...opts, glab });
    expect(out).toHaveLength(1);
    expect(labelEdits(glab)[0]).toContain('--unlabel taskcell::waiting');
  });
  it('sends a cycle, a cross-project 404 and a merge request to needs info with the reason', async () => {
    for (const [body, reason, glab] of [
      ['Depends on #2', 'cycle', fakeGlab({ 'g/p#2': open }, { '2': [1] })],
      ['Depends on o/x#9', 'not readable', fakeGlab({})],
      ['Depends on !12', 'merge requests', fakeGlab({})],
    ] as const) {
      expect(await applyGitlabDependencyGate([task(1, body)], { ...opts, glab })).toEqual([]);
      expect(labelEdits(glab)[0]).toContain('--label needs info --unlabel ready for agent');
      expect(notesPosted(glab)[0]).toContain(reason);
    }
  });
  it('comments once on a lookup error, keeps the trigger, and never sends a repeat to needs info', async () => {
    const first = forbidden();
    expect(await applyGitlabDependencyGate([task(1, 'Depends on #2')], { ...opts, glab: first })).toEqual([]);
    expect(notesPosted(first)).toHaveLength(1);
    expect(notesPosted(first)[0]).toContain("could not check this issue's dependencies");
    expect(labelEdits(first)).toEqual([expect.stringContaining('--label taskcell::waiting')]);
    expect(labelEdits(first)[0]).not.toContain('--unlabel');
    const again = forbidden(notesPosted(first));
    await applyGitlabDependencyGate([task(1, 'Depends on #2', ['ready for agent', 'taskcell::waiting'])], { ...opts, glab: again });
    expect(notesPosted(again)).toHaveLength(0);
    expect(labelEdits(again).join(' ')).not.toContain('needs info');
  });
  it('leaves an issue that declares nothing triggered and untouched when its links cannot be read', async () => {
    const glab = forbidden();
    expect(await applyGitlabDependencyGate([task(1, 'no deps here')], { ...opts, glab })).toEqual([]);
    expect(calls(glab).every((a) => a[0] === 'api' && a[1]!.endsWith('/links'))).toBe(true);
  });
  it('quotes untrusted Start text so it cannot mention anyone', async () => {
    const glab = fakeGlab({});
    await applyGitlabDependencyGate([task(1, 'Start: 2030-@all')], { ...opts, glab });
    expect(notesPosted(glab)[0]).toContain('`"Start: 2030-all" is not a valid YYYY-MM-DD date`');
    expect(notesPosted(glab)[0]).not.toContain('@');
  });
});
