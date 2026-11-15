import { describe, expect, it, vi } from 'vitest';
import { linearGraphql } from './linear-cli.js';
import { applyLinearDependencyGate, checkLinearDependencies, parseLinearBodyDependencies } from './linear-dependencies.js';
import type { LinearGraphql } from './linear-cli.js';
import type { Task } from './fetcher.js';

const task = (id: string, description = ''): Task => ({ id, title: 't', description, labels: ['ready for agent'], children: [], comments: [], ref: id });

interface Fake { type?: string; blockedBy?: string[]; cycle?: string; related?: number }
interface ProbeFilter { or: { team: { key: { eqIgnoreCase: string } }; number: { in: number[] } }[] }
type Send = ReturnType<typeof vi.fn<LinearGraphql>>;

const relationNodes = (i: Fake): object[] => [
  ...Array.from({ length: i.related ?? 0 }, () => ({ type: 'related', issue: { identifier: 'DEV-900' } })),
  ...(i.blockedBy ?? []).map((b) => ({ type: 'blocks', issue: { identifier: b } })),
];
const issueNode = (identifier: string, i: Fake): object => ({
  identifier,
  state: { type: i.type ?? 'unstarted' },
  cycle: i.cycle !== undefined ? { startsAt: i.cycle } : null,
  inverseRelations: { pageInfo: { hasNextPage: false }, nodes: relationNodes(i) },
});

/**
 * A stubbed Linear sender. issues: identifier -> state type, blockers, cycle; unknown identifiers answer
 * "Entity not found". The probe returns each asked issue with its relations and cycle; `comments` is the
 * newest comment per issue (filled by `commentRunner`).
 */
function fakeSend(issues: Record<string, Fake>, comments = new Map<string, string>()): Send {
  return vi.fn<LinearGraphql>(async (body) => {
    const id = body.variables['id'] as string;
    if (body.query.includes('comments(')) return { data: { issue: { comments: { nodes: comments.has(id) ? [{ body: comments.get(id) }] : [] } } } };
    if (body.query.includes('issues(')) {
      const asked = (body.variables['f'] as ProbeFilter).or.flatMap((g) => g.number.in.map((n) => `${g.team.key.eqIgnoreCase}-${n}`));
      return { data: { issues: { nodes: asked.filter((key) => issues[key] !== undefined).map((key) => issueNode(key, issues[key]!)) } } };
    }
    const i = issues[id];
    return i === undefined ? { errors: [{ message: 'Entity not found: Issue' }] } : { data: { issue: issueNode(id, i) } };
  });
}

/** A `linear` CLI stub that stores each posted comment as the issue's newest one. */
const commentRunner = (comments: Map<string, string>): ReturnType<typeof vi.fn<(args: string[]) => Promise<string>>> =>
  vi.fn(async (args: string[]) => {
    if (args[1] === 'comment') comments.set(args[3]!, args[5]!);
    return '';
  });

const lookedUp = (send: Send): string[] => send.mock.calls.map(([b]) => b).filter((b) => b.query.includes('issue(id')  && !b.query.includes('comments(')).map((b) => b.variables['id'] as string).sort();
const probes = (send: Send): { query: string; variables: Record<string, unknown> }[] => send.mock.calls.map(([b]) => b).filter((b) => b.query.includes('issues('));

const now = new Date('2026-06-01T00:00:00Z');

describe('parsing', () => {
  it('reads Depends on lines and Linear URLs', () => {
    expect(parseLinearBodyDependencies('Depends on DEV-3\n- Depends on: ENG-4, dev-5 and https://linear.app/acme/issue/DEV-6/slug.')).toEqual([
      { repo: 'DEV', number: 3 }, { repo: 'ENG', number: 4 }, { repo: 'dev', number: 5 }, { repo: 'DEV', number: 6 },
    ]);
    expect(parseLinearBodyDependencies('Depends on DEV-3 (unlike DEV-4)\nDepends on #5')).toEqual([{ repo: 'DEV', number: 3 }]);
    expect(parseLinearBodyDependencies('```\nDepends on DEV-3\n```\n> Depends on DEV-4\nDepends on DEV-5')).toEqual([{ repo: 'DEV', number: 5 }]);
  });
  it('reads a very long line in linear time (no backtracking over trailing punctuation)', () => {
    const line = `Depends on DEV-1 https://linear.app/a/issue/A-1/${';'.repeat(200_000)}/x`;
    const started = Date.now();
    expect(parseLinearBodyDependencies(line)).toEqual([{ repo: 'DEV', number: 1 }]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('checkLinearDependencies', () => {
  it('is ready without dependencies', async () => {
    expect(await checkLinearDependencies(task('DEV-1'), fakeSend({ 'DEV-1': {} }), now)).toEqual({ status: 'ready', dependsOn: [] });
  });
  it('waits for an open native blocker and is ready once it completes', async () => {
    const waiting = await checkLinearDependencies(task('DEV-1'), fakeSend({ 'DEV-1': { blockedBy: ['DEV-2'] }, 'DEV-2': {} }), now);
    expect(waiting).toMatchObject({ status: 'waiting', blockers: [{ repo: 'DEV', number: 2 }] });
    const done = await checkLinearDependencies(task('DEV-1'), fakeSend({ 'DEV-1': { blockedBy: ['DEV-2'] }, 'DEV-2': { type: 'completed' } }), now);
    expect(done).toEqual({ status: 'ready', dependsOn: [{ repo: 'DEV', number: 2 }] });
  });
  it('adds Depends on lines to native relations', async () => {
    const issues = { 'DEV-1': { blockedBy: ['DEV-2'] }, 'DEV-2': { type: 'completed' }, 'DEV-5': {} };
    const v = await checkLinearDependencies(task('DEV-1', 'Depends on DEV-5'), fakeSend(issues), now);
    expect(v).toMatchObject({ status: 'waiting', blockers: [{ repo: 'DEV', number: 5 }] });
  });
  it('uses known relations without looking the issue up', async () => {
    const send = fakeSend({ 'DEV-2': { type: 'completed' } });
    const v = await checkLinearDependencies(task('DEV-1'), send, now, { nativeBlockers: [{ repo: 'DEV', number: 2 }] });
    expect(v).toMatchObject({ status: 'ready' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('never starts an id it cannot parse: a human has to look', async () => {
    const send = fakeSend({});
    expect(await checkLinearDependencies(task('nope'), send, now)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('nope is not a Linear identifier') });
    expect(send).not.toHaveBeenCalled();
  });
  it('reads a team key that starts with a digit or is written in lower case, and looks it up upper-cased', async () => {
    const send = fakeSend({ '2FA-1': {}, 'DEV-5': {} });
    expect(await checkLinearDependencies(task('2FA-1', 'Depends on dev-5'), send, now)).toMatchObject({ status: 'waiting', reason: 'waiting for DEV-5' });
    expect(lookedUp(send)).toEqual(['2FA-1', 'DEV-5']);
  });
  it('reads every page of the relations: a blocker past the first page still blocks', async () => {
    const send = vi.fn<LinearGraphql>(async (body) => {
      const { id, after } = body.variables as { id: string; after?: string };
      if (id !== 'DEV-1') return { data: { issue: issueNode(id, {}) } };
      const page = after === undefined
        ? { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ type: 'related', issue: { identifier: 'DEV-7' } }] }
        : { pageInfo: { hasNextPage: false }, nodes: [{ type: 'blocks', issue: { identifier: 'DEV-2' } }] };
      return { data: { issue: { identifier: id, state: { type: 'unstarted' }, inverseRelations: page } } };
    });
    expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'waiting', reason: 'waiting for DEV-2' });
    expect(send.mock.calls.map(([b]) => b.variables['after'])).toEqual([undefined, 'c1', undefined]);
  });
  it('stops when the relation cursor does not advance', async () => {
    const send: LinearGraphql = async () => ({ data: { issue: { identifier: 'DEV-1', inverseRelations: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } });
    expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'error', reason: expect.stringContaining('did not advance') });
  });
  it.each([
    ['a null relation', [null]],
    ['a relation without a type', [{ issue: { identifier: 'DEV-2' } }]],
    ['a blocker without an issue', [{ type: 'blocks', issue: null }]],
    ['a blocker with an unparseable identifier', [{ type: 'blocks', issue: { identifier: 'not an id' } }]],
  ])('waits with a reason on %s instead of dropping it', async (_name, nodes) => {
    const send: LinearGraphql = async () => ({ data: { issue: { identifier: 'DEV-1', state: { type: 'unstarted' }, inverseRelations: { pageInfo: { hasNextPage: false }, nodes } } } });
    expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'waiting', blockers: [], reason: expect.stringContaining('could not be read') });
  });
  it('waits when a blocker\'s own relations cannot be read', async () => {
    const send: LinearGraphql = async (body) => ({ data: { issue: body.variables['id'] === 'DEV-1' ? issueNode('DEV-1', { blockedBy: ['DEV-2'] }) : { identifier: 'DEV-2', state: { type: 'unstarted' }, inverseRelations: null } } });
    expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'waiting', reason: expect.stringContaining('the dependencies of DEV-2 could not be read') });
  });
  it('does not read "not found" free text as a missing issue (a proxy\'s 404)', async () => {
    const thrown: LinearGraphql = async (body) => {
      if (body.variables['id'] === 'DEV-9') throw new Error('Linear API request failed: 404 Not Found — <html>The page does not exist</html>');
      return { data: { issue: issueNode('DEV-1', {}) } };
    };
    expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-9'), thrown, now)).toMatchObject({ status: 'error' });
    const other: LinearGraphql = async () => ({ errors: [{ message: 'Entity not found: Team' }] });
    expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-9'), other, now, { nativeBlockers: [] })).toMatchObject({ status: 'error' });
    vi.stubEnv('LINEAR_API_KEY', 'k');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>404 Not Found: entity not found: issue</html>', { status: 404, statusText: 'Not Found' })));
    try {
      expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-9'), await linearGraphql(), now, { nativeBlockers: [] })).toMatchObject({ status: 'error' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it('stops a chain larger than the node cap', async () => {
    const issues: Record<string, Fake> = {};
    for (let n = 1; n <= 60; n++) issues[`DEV-${n}`] = { blockedBy: [`DEV-${n + 1}`] };
    issues['DEV-61'] = {};
    expect(await checkLinearDependencies(task('DEV-1'), fakeSend(issues), now)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('too large') });
  });
  it('treats other GraphQL errors as a failed lookup', async () => {
    const send: LinearGraphql = async () => ({ errors: [{ message: 'rate limited' }] });
    expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'error' });
  });
  it('maps a non-2xx "Entity not found" to a missing reference through the real sender', async () => {
    vi.stubEnv('LINEAR_API_KEY', 'k');
    const issues: Record<string, object> = { 'DEV-1': { identifier: 'DEV-1', state: { type: 'unstarted' }, inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const id = (JSON.parse(init.body) as { variables: { id: string } }).variables.id;
      const issue = issues[id];
      if (issue === undefined) return new Response('{"errors":[{"message":"Entity not found: Issue"}]}', { status: 400, statusText: 'Bad Request' });
      return new Response(JSON.stringify({ data: { issue } }), { status: 200 });
    }));
    try {
      const send = await linearGraphql();
      expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-9'), send, now)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('DEV-9 does not exist') });
      expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'ready' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it('follows chains and detects cycles', async () => {
    const v = await checkLinearDependencies(task('DEV-1'), fakeSend({ 'DEV-1': { blockedBy: ['DEV-2'] }, 'DEV-2': { blockedBy: ['DEV-1'] } }), now);
    expect(v).toMatchObject({ status: 'invalid', reason: expect.stringContaining('dependency cycle: DEV-1 → DEV-2 → DEV-1') });
  });
  it('is invalid for a missing reference and a canceled blocker', async () => {
    expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-9'), fakeSend({ 'DEV-1': {} }), now)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('DEV-9 does not exist') });
    expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-2'), fakeSend({ 'DEV-1': {}, 'DEV-2': { type: 'canceled' } }), now)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('canceled') });
    expect(await checkLinearDependencies(task('DEV-1', 'Depends on DEV-2'), fakeSend({ 'DEV-1': {}, 'DEV-2': { type: 'duplicate' } }), now)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('DEV-2 was closed as a duplicate') });
  });
  it('waits for a future start date: cycle start (to the instant), then Start line', async () => {
    expect(await checkLinearDependencies(task('DEV-1'), fakeSend({ 'DEV-1': { cycle: '2026-07-02T00:00:00.000Z' } }), now)).toMatchObject({ status: 'waiting', reason: 'start date 2026-07-02' });
    expect(await checkLinearDependencies(task('DEV-1'), fakeSend({ 'DEV-1': { cycle: '2026-06-01T10:00:00.000Z' } }), new Date('2026-06-01T09:00:00Z'))).toMatchObject({ status: 'waiting' });
    expect(await checkLinearDependencies(task('DEV-1', 'Start: 2026-07-03'), fakeSend({ 'DEV-1': {} }), now)).toMatchObject({ status: 'waiting', reason: 'start date 2026-07-03' });
    expect(await checkLinearDependencies(task('DEV-1', 'Start: 2026-05-03'), fakeSend({ 'DEV-1': {} }), now)).toMatchObject({ status: 'ready' });
    expect(await checkLinearDependencies(task('DEV-1', 'Start: 2026-02-31'), fakeSend({ 'DEV-1': {} }), now)).toMatchObject({ status: 'invalid' });
  });
  it('reports a failed lookup as error', async () => {
    const send: LinearGraphql = async () => { throw new Error('boom'); };
    expect(await checkLinearDependencies(task('DEV-1'), send, now)).toMatchObject({ status: 'error' });
  });
});

describe('applyLinearDependencyGate', () => {
  const opts = (): { linear: () => Promise<string>; now: Date; log: () => void; reported: Map<string, string> } =>
    ({ linear: async () => '', now, log: () => undefined, reported: new Map() });

  it('costs one probe and no lookup when nothing has a dependency, and starts every issue', async () => {
    const send = fakeSend({ 'DEV-1': {}, 'DEV-2': { related: 3 }, 'DEV-3': { cycle: '2026-05-01T00:00:00.000Z' } });
    const tasks = [task('DEV-1'), task('DEV-2'), task('DEV-3')];
    const out = await applyLinearDependencyGate(tasks, { ...opts(), graphql: send });
    expect(out.map((t) => t.id)).toEqual(['DEV-1', 'DEV-2', 'DEV-3']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(probes(send)).toHaveLength(1);
  });
  it('does not ask Linear which issues are blocked: the filter only selects the listed issues', async () => {
    const send = fakeSend({ 'DEV-1': {} });
    await applyLinearDependencyGate([task('DEV-1')], { ...opts(), graphql: send });
    expect(JSON.stringify(probes(send)[0])).not.toMatch(/hasBlockedByRelations|hasBlockingRelations/);
    expect(probes(send)[0]!.variables['f']).toEqual({ or: [{ team: { key: { eqIgnoreCase: 'DEV' } }, number: { in: [1] } }] });
  });
  it('parks an issue whose native blocker was canceled and starts one whose native blocker is completed', async () => {
    const comments = new Map<string, string>();
    const send = fakeSend({ 'DEV-1': { type: 'canceled' }, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-3': { type: 'completed' }, 'DEV-4': { blockedBy: ['DEV-3'] } }, comments);
    const moved: string[] = [];
    const out = await applyLinearDependencyGate([task('DEV-2'), task('DEV-4')], { ...opts(), graphql: send, linear: commentRunner(comments), moveToNeedsInfo: async (id) => { moved.push(id); } });
    expect(out).toMatchObject([{ id: 'DEV-4', dependsOn: [{ repo: 'DEV', number: 3 }] }]);
    expect(moved).toEqual(['DEV-2']);
    expect(comments.get('DEV-2')).toContain('DEV-1 was canceled');
  });
  it('holds a future cycle and starts a current one without a lookup; the cycle start wins over a Start line either way', async () => {
    const send = fakeSend({ 'DEV-1': { cycle: '2026-07-01T00:00:00.000Z' }, 'DEV-2': { cycle: '2026-05-01T00:00:00.000Z' } });
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2', 'Start: 2027-01-01')], { ...opts(), graphql: send });
    expect(out.map((t) => t.id)).toEqual(['DEV-2']);
    expect(lookedUp(send)).toEqual([]);
  });
  it('looks an issue up when the probe cannot answer for it', async () => {
    const issues: Record<string, Fake> = { 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-3': { blockedBy: ['DEV-1'] }, 'DEV-4': { blockedBy: ['DEV-1'] }, 'DEV-5': {} };
    const inner = fakeSend(issues);
    const send = vi.fn<LinearGraphql>(async (body) => {
      if (!body.query.includes('issues(')) return inner(body);
      return {
        data: {
          issues: {
            nodes: [
              // DEV-2 is not returned at all; DEV-3 has more relations than the probe read; DEV-4's first relation is unreadable.
              { identifier: 'DEV-3', inverseRelations: { pageInfo: { hasNextPage: true }, nodes: [{ type: 'related', issue: { identifier: 'DEV-9' } }] } },
              { identifier: 'DEV-4', inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [null] } },
              { identifier: 'DEV-5', inverseRelations: { nodes: [] } },
              issueNode('DEV-1', {}),
            ],
          },
        },
      };
    });
    const out = await applyLinearDependencyGate(['DEV-1', 'DEV-2', 'DEV-3', 'DEV-4', 'DEV-5'].map((id) => task(id)), { ...opts(), graphql: send });
    expect(out.map((t) => t.id)).toEqual(['DEV-1', 'DEV-5']);
    // Each unanswered issue once, and their shared blocker DEV-1 once for the whole poll.
    expect(lookedUp(send)).toEqual(['DEV-1', 'DEV-2', 'DEV-3', 'DEV-4', 'DEV-5']);
  });
  it('reads a blocker once per poll however many issues wait for it, and only blockers', async () => {
    const issues: Record<string, Fake> = { 'DEV-1': {}, 'DEV-9': {} };
    for (let n = 2; n <= 8; n++) issues[`DEV-${n}`] = { blockedBy: ['DEV-1'] };
    const send = fakeSend(issues);
    const tasks = [task('DEV-1'), ...Array.from({ length: 7 }, (_, n) => task(`DEV-${n + 2}`)), task('DEV-9', 'Depends on dev-1')];
    const out = await applyLinearDependencyGate(tasks, { ...opts(), graphql: send, reported: new Map(tasks.map((t) => [t.id, 'Taskcell will not start this issue yet: `waiting for DEV-1`. It stays in its trigger state and starts by itself once that is resolved.'])) });
    expect(out.map((t) => t.id)).toEqual(['DEV-1']);
    expect(lookedUp(send)).toEqual(['DEV-1']);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('probes in bounded batches across teams, team keys upper-cased as in the lookup', async () => {
    const send = fakeSend({});
    const tasks = Array.from({ length: 120 }, (_, n) => task(`${n % 2 === 0 ? 'dev' : 'ENG'}-${n + 1}`));
    await applyLinearDependencyGate(tasks, { ...opts(), graphql: send });
    expect(probes(send).map((b) => b.variables['first'])).toEqual([50, 50, 20]);
    expect((probes(send)[0]!.variables['f'] as ProbeFilter).or.map((g) => g.team.key.eqIgnoreCase)).toEqual(['DEV', 'ENG']);
    expect(lookedUp(send).slice(0, 2)).toEqual(['DEV-1', 'DEV-101']);
  });
  it('logs a failed probe and starts none of its issues in that poll, without one lookup per issue', async () => {
    const send = vi.fn<LinearGraphql>(async () => ({ errors: [{ message: 'Query too complex' }] }));
    const linear = vi.fn(async (_args: string[]) => '');
    const logs: string[] = [];
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2', 'Depends on DEV-1')], { graphql: send, linear, now, log: (l) => logs.push(l) });
    expect(out).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(linear).not.toHaveBeenCalled();
    expect(logs[0]).toContain('Linear dependency probe failed, 2 issue(s) not started this poll -> Query too complex');
    const thrown = vi.fn<LinearGraphql>(async () => { throw new Error('socket hang up'); });
    expect(await applyLinearDependencyGate([task('DEV-1')], { ...opts(), graphql: thrown })).toEqual([]);
  });
  it('passes ready tasks, comments on waiting ones and parks invalid ones in needs info', async () => {
    const comments = new Map<string, string>();
    const send = fakeSend({ 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-3': { blockedBy: ['DEV-3'] } }, comments);
    const moved: string[] = [];
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2'), task('DEV-3')], {
      ...opts(), graphql: send, linear: commentRunner(comments), moveToNeedsInfo: async (id) => { moved.push(id); },
    });
    expect(out.map((t) => t.id)).toEqual(['DEV-1']);
    expect(moved).toEqual(['DEV-3']);
    expect(comments.get('DEV-2')).toBe('Taskcell will not start this issue yet: `waiting for DEV-1`. It stays in its trigger state and starts by itself once that is resolved.');
    expect(comments.get('DEV-3')).toContain('Taskcell cannot start this issue: `dependency cycle: DEV-3 → DEV-3`');
  });
  it('comments once on a waiting issue, an unparseable id and a failed move: across polls and across a restart', async () => {
    const comments = new Map<string, string>();
    const send = fakeSend({ 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-3': { blockedBy: ['DEV-3'] } }, comments);
    const linear = commentRunner(comments);
    const move = vi.fn(async () => { throw new Error('no such state'); });
    const logs: string[] = [];
    const tasks = [task('DEV-2'), task('DEV-3'), task('0c1f-uuid')];
    const reported = new Map<string, string>();
    for (let poll = 0; poll < 3; poll++) await applyLinearDependencyGate(tasks, { graphql: send, linear, now, reported, moveToNeedsInfo: move, log: (l) => logs.push(l) });
    // A new process has no memory: the newest comment on the issue stops the repeat.
    await applyLinearDependencyGate(tasks, { graphql: send, linear, now, reported: new Map(), moveToNeedsInfo: move, log: (l) => logs.push(l) });
    expect(linear.mock.calls.map((c) => c[0][3])).toEqual(['DEV-2', 'DEV-3', '0c1f-uuid']);
    expect(comments.get('0c1f-uuid')).toContain('0c1f-uuid is not a Linear identifier');
    expect(move).toHaveBeenCalledTimes(8);
    expect(logs.some((l) => l.includes('could not be recorded'))).toBe(true);
    // The comment read happens once per issue per process, not on every poll.
    expect(send.mock.calls.filter(([b]) => b.query.includes('comments(')).length).toBe(6);
  });
  it('comments again when the reason changes or someone else commented since, and not when the newest comment cannot be read', async () => {
    const comments = new Map<string, string>([['DEV-2', 'a human said something']]);
    const issues: Record<string, Fake> = { 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-5': {} };
    const linear = commentRunner(comments);
    const reported = new Map<string, string>();
    await applyLinearDependencyGate([task('DEV-2')], { ...opts(), graphql: fakeSend(issues, comments), linear, reported });
    issues['DEV-2'] = { blockedBy: ['DEV-5'] };
    await applyLinearDependencyGate([task('DEV-2')], { ...opts(), graphql: fakeSend(issues, comments), linear, reported });
    expect(linear.mock.calls.map((c) => c[0][5])).toEqual([expect.stringContaining('waiting for DEV-1'), expect.stringContaining('waiting for DEV-5')]);
    linear.mockClear();
    const inner = fakeSend(issues);
    const broken: LinearGraphql = async (body) => (body.query.includes('comments(') ? { errors: [{ message: 'boom' }] } : inner(body));
    const logs: string[] = [];
    await applyLinearDependencyGate([task('DEV-2')], { ...opts(), graphql: broken, linear, log: (l) => logs.push(l) });
    expect(linear).not.toHaveBeenCalled();
    expect(logs.at(-1)).toContain('could not be recorded');
  });
});
