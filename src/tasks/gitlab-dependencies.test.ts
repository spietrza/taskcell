import { describe, expect, it, vi } from 'vitest';
import { applyGitlabDependencyGate, checkGitlabDependencies, parseGitlabBodyDependencies } from './gitlab-dependencies.js';
import type { GlabRunner } from './gitlab.js';
import type { Task } from './fetcher.js';

const task = (number: number, description = '', labels: string[] = ['ready for agent']): Task => ({
  id: `g/p#${number}`, title: 't', description, labels, children: [], comments: [], ref: String(number),
});

/** issues: "project#iid" -> API JSON; blocked: iid -> blocker iids (same project). */
function fakeGlab(issues: Record<string, object>, blocked: Record<string, number[]> = {}): GlabRunner {
  return vi.fn(async (args: string[]) => {
    const path = args[1] ?? '';
    const links = /projects\/(.+)\/issues\/(\d+)\/links$/.exec(path);
    if (args[0] === 'api' && links) {
      const project = decodeURIComponent(links[1]!);
      return JSON.stringify((blocked[links[2]!] ?? []).map((iid) => ({ iid, link_type: 'is_blocked_by', references: { full: `${project}#${iid}` } })));
    }
    const m = /projects\/(.+)\/issues\/(\d+)$/.exec(path);
    if (args[0] === 'api' && m) {
      const issue = issues[`${decodeURIComponent(m[1]!)}#${m[2]}`];
      if (issue === undefined) throw new Error('glab: 404 Not Found');
      return JSON.stringify(issue);
    }
    return '';
  });
}

const open = { state: 'opened' };
const closed = { state: 'closed' };

describe('parsing', () => {
  it('reads Depends on lines', () => {
    expect(parseGitlabBodyDependencies('g/p', 'Depends on #3\nDepends on: a/b/c#4, #5 and x/y#6')).toEqual([
      { repo: 'g/p', number: 3 }, { repo: 'a/b/c', number: 4 }, { repo: 'g/p', number: 5 }, { repo: 'x/y', number: 6 },
    ]);
    expect(parseGitlabBodyDependencies('g/p', 'Depends on #3 (unlike #4)\nDepends on ../..#5')).toEqual([{ repo: 'g/p', number: 3 }]);
  });
});

describe('checkGitlabDependencies', () => {
  it('is ready without dependencies', async () => {
    expect(await checkGitlabDependencies('g/p', task(1), fakeGlab({ 'g/p#1': open }))).toEqual({ status: 'ready', dependsOn: [] });
  });
  it('waits on an open body dependency and is ready once closed', async () => {
    const body = 'Depends on #2';
    expect(await checkGitlabDependencies('g/p', task(1, body), fakeGlab({ 'g/p#1': open, 'g/p#2': open }))).toMatchObject({ status: 'waiting', reason: 'waiting for g/p#2' });
    expect(await checkGitlabDependencies('g/p', task(1, body), fakeGlab({ 'g/p#1': open, 'g/p#2': closed }))).toMatchObject({ status: 'ready' });
  });
  it('uses is-blocked-by links', async () => {
    const issues = { 'g/p#1': open, 'g/p#2': open };
    expect(await checkGitlabDependencies('g/p', task(1), fakeGlab(issues, { '1': [2] }))).toMatchObject({ status: 'waiting' });
  });
  it('waits for a future start date, from the API or the body', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(await checkGitlabDependencies('g/p', task(1), fakeGlab({ 'g/p#1': { ...open, start_date: '2030-02-01' } }), now)).toMatchObject({ status: 'waiting' });
    expect(await checkGitlabDependencies('g/p', task(1, 'Start: 2030-02-01'), fakeGlab({ 'g/p#1': open }), now)).toMatchObject({ status: 'waiting' });
    expect(await checkGitlabDependencies('g/p', task(1, 'Start: 2029-02-01'), fakeGlab({ 'g/p#1': open }), now)).toMatchObject({ status: 'ready' });
    expect(await checkGitlabDependencies('g/p', task(1, 'Start: 2030-02-31'), fakeGlab({ 'g/p#1': open }), now)).toMatchObject({ status: 'invalid' });
  });
  it('flags cycles and missing references', async () => {
    const issues = { 'g/p#1': open, 'g/p#2': open };
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #2'), fakeGlab(issues, { '2': [1] }))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('cycle') });
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on #9'), fakeGlab(issues))).toMatchObject({ status: 'invalid', reason: expect.stringContaining('does not exist') });
  });
  it('reports an unreadable cross-project reference as an error', async () => {
    expect(await checkGitlabDependencies('g/p', task(1, 'Depends on o/x#9'), fakeGlab({ 'g/p#1': open }))).toMatchObject({ status: 'error' });
  });
});

describe('applyGitlabDependencyGate', () => {
  const log = (): void => undefined;
  const calls = (glab: GlabRunner): string[][] => (glab as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string[]);

  it('passes ready tasks through with dependsOn', async () => {
    const glab = fakeGlab({ 'g/p#1': open, 'g/p#2': closed });
    const out = await applyGitlabDependencyGate([task(1, 'Depends on #2')], { project: 'g/p', trigger: 'ready for agent', glab, log });
    expect(out.map((t) => t.dependsOn)).toEqual([[{ repo: 'g/p', number: 2 }]]);
  });
  it('holds a waiting task with a label and one comment, keeping the trigger', async () => {
    const glab = fakeGlab({ 'g/p#1': open, 'g/p#2': open });
    const gate = (t: Task): Promise<Task[]> => applyGitlabDependencyGate([t], { project: 'g/p', trigger: 'ready for agent', glab, log });
    expect(await gate(task(1, 'Depends on #2'))).toEqual([]);
    const writes = calls(glab).filter((a) => a[0] === 'issue');
    expect(writes[0]).toContain('note');
    expect(writes[1]).toEqual(expect.arrayContaining(['--label', 'taskcell::waiting']));
    expect(writes[1]).not.toContain('--unlabel');
    const before = writes.length;
    await gate(task(1, 'Depends on #2', ['ready for agent', 'taskcell::waiting']));
    expect(calls(glab).filter((a) => a[0] === 'issue')).toHaveLength(before);
  });
  it('drops a stale waiting label from a ready task', async () => {
    const glab = fakeGlab({ 'g/p#1': open });
    const out = await applyGitlabDependencyGate([task(1, '', ['ready for agent', 'taskcell::waiting'])], { project: 'g/p', trigger: 'ready for agent', glab, log });
    expect(out).toHaveLength(1);
    expect(calls(glab).some((a) => a.includes('--unlabel'))).toBe(true);
  });
  it('sends a cycle to needs info', async () => {
    const glab = fakeGlab({ 'g/p#1': open, 'g/p#2': open }, { '2': [1] });
    const out = await applyGitlabDependencyGate([task(1, 'Depends on #2')], { project: 'g/p', trigger: 'ready for agent', needsInfoLabel: 'needs info', glab, log });
    expect(out).toEqual([]);
    const edit = calls(glab).find((a) => a.includes('--unlabel'))!;
    expect(edit).toEqual(expect.arrayContaining(['--unlabel', 'ready for agent', '--label', 'needs info']));
    expect(calls(glab).some((a) => a.join(' ').includes('cycle'))).toBe(true);
  });
});
