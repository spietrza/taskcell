import { describe, expect, it, vi } from 'vitest';
import { linearGraphql } from './linear-cli.js';
import { applyLinearDependencyGate, checkLinearDependencies, parseLinearBodyDependencies } from './linear-dependencies.js';
import type { LinearGraphql } from './linear-cli.js';
import type { Task } from './fetcher.js';

const task = (id: string, description = ''): Task => ({ id, title: 't', description, labels: ['ready for agent'], children: [], comments: [], ref: id });

interface Fake { type?: string; blockedBy?: string[]; cycle?: string }
interface ProbeFilter { and: [{ or: { team: { key: { eq: string } }; number: { in: number[] } }[] }, unknown] }
/** issues: identifier -> state type, blockers, dates. Unknown identifiers answer "Entity not found". The probe answers like Linear would. */
function fakeSend(issues: Record<string, Fake>): ReturnType<typeof vi.fn<LinearGraphql>> {
  return vi.fn<LinearGraphql>(async (body) => {
    if (body.query.includes('issues(')) {
      const f = body.variables['f'] as ProbeFilter;
      const asked = f.and[0].or.flatMap((g) => g.number.in.map((n) => `${g.team.key.eq}-${n}`));
      const nodes = asked.filter((id) => { const i = issues[id]; return i !== undefined && ((i.blockedBy ?? []).length > 0 || i.cycle !== undefined); });
      return { data: { issues: { nodes: nodes.map((identifier) => ({ identifier })) } } };
    }
    const id = body.variables['id'] as string;
    const i = issues[id];
    if (i === undefined) return { errors: [{ message: 'Entity not found: Issue' }] };
    return {
      data: {
        issue: {
          identifier: id,
          state: { type: i.type ?? 'unstarted' },
          cycle: i.cycle !== undefined ? { startsAt: i.cycle } : null,
          inverseRelations: { nodes: (i.blockedBy ?? []).map((b) => ({ type: 'blocks', issue: { identifier: b } })) },
        },
      },
    };
  });
}

const now = new Date('2026-06-01T00:00:00Z');

describe('parsing', () => {
  it('reads Depends on lines and Linear URLs', () => {
    expect(parseLinearBodyDependencies('Depends on DEV-3\n- Depends on: ENG-4, dev-5 and https://linear.app/acme/issue/DEV-6/slug.')).toEqual([
      { repo: 'DEV', number: 3 }, { repo: 'ENG', number: 4 }, { repo: 'dev', number: 5 }, { repo: 'DEV', number: 6 },
    ]);
    expect(parseLinearBodyDependencies('Depends on DEV-3 (unlike DEV-4)\nDepends on #5')).toEqual([{ repo: 'DEV', number: 3 }]);
    expect(parseLinearBodyDependencies('```\nDepends on DEV-3\n```\n> Depends on DEV-4\nDepends on DEV-5')).toEqual([{ repo: 'DEV', number: 5 }]);
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
  it('fails closed on a non-Linear id', async () => {
    expect(await checkLinearDependencies(task('nope'), fakeSend({}), now)).toMatchObject({ status: 'error' });
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
    const issues: Record<string, object> = { 'DEV-1': { identifier: 'DEV-1', state: { type: 'unstarted' }, inverseRelations: { nodes: [] } } };
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
  const opts = { linear: async (): Promise<string> => '', now, log: (): void => undefined, reported: new Map<string, string>() };
  it('costs one identifiers-only probe and no issue lookups when nothing has a dependency', async () => {
    const send = fakeSend({ 'DEV-1': {}, 'DEV-2': {} });
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2')], { ...opts, graphql: send });
    expect(out.map((t) => t.id)).toEqual(['DEV-1', 'DEV-2']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].query).not.toMatch(/inverseRelations|cycle \{/);
  });
  it('looks up only the issues the probe or the body names', async () => {
    const send = fakeSend({ 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-3': {}, 'DEV-4': { cycle: '2026-07-01T00:00:00.000Z' } });
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2'), task('DEV-3', 'Depends on DEV-1'), task('DEV-4')], { ...opts, graphql: send });
    expect(out.map((t) => t.id)).toEqual(['DEV-1']);
    const looked = send.mock.calls.map(([b]) => b.variables['id']).filter((id) => id !== undefined);
    expect(looked.sort()).toEqual(['DEV-1', 'DEV-1', 'DEV-2', 'DEV-4']);
  });
  it('probes in bounded batches across teams', async () => {
    const send = fakeSend({});
    const tasks = Array.from({ length: 120 }, (_, n) => task(`${n % 2 === 0 ? 'DEV' : 'ENG'}-${n + 1}`));
    await applyLinearDependencyGate(tasks, { ...opts, graphql: send });
    const probes = send.mock.calls.map(([b]) => b).filter((b) => b.query.includes('issues('));
    expect(probes.map((b) => b.variables['first'])).toEqual([50, 50, 20]);
    expect((probes[0]!.variables['f'] as ProbeFilter).and[0].or.map((g) => g.team.key.eq)).toEqual(['DEV', 'ENG']);
  });
  it('falls back to per-issue lookups when the probe fails', async () => {
    const inner = fakeSend({ 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] } });
    const send: LinearGraphql = async (body) => (body.query.includes('issues(') ? { errors: [{ message: 'too complex' }] } : inner(body));
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2')], { ...opts, graphql: send });
    expect(out.map((t) => t.id)).toEqual(['DEV-1']);
  });
  it('passes ready tasks, skips waiting ones and parks invalid ones in needs info', async () => {
    const send = fakeSend({ 'DEV-1': {}, 'DEV-2': { blockedBy: ['DEV-1'] }, 'DEV-3': { blockedBy: ['DEV-3'] } });
    const linear = vi.fn(async (_args: string[]) => '');
    const moved: string[] = [];
    const out = await applyLinearDependencyGate([task('DEV-1'), task('DEV-2'), task('DEV-3')], {
      graphql: send, linear, now, log: () => undefined, reported: new Map(), moveToNeedsInfo: async (id) => { moved.push(id); },
    });
    expect(out.map((t) => t.id)).toEqual(['DEV-1']);
    expect(moved).toEqual(['DEV-3']);
    expect(linear).toHaveBeenCalledTimes(1);
    expect(linear.mock.calls[0]![0]).toEqual(expect.arrayContaining(['comment', 'add', 'DEV-3']));
  });
  it('comments once per reason even when the move fails, and only logs without a needs-info move', async () => {
    const send = fakeSend({ 'DEV-3': { blockedBy: ['DEV-3'] } });
    const linear = vi.fn(async (_args: string[]) => '');
    const reported = new Map<string, string>();
    const move = vi.fn(async () => { throw new Error('no such state'); });
    const logs: string[] = [];
    for (let i = 0; i < 2; i++) await applyLinearDependencyGate([task('DEV-3')], { graphql: send, linear, now, reported, moveToNeedsInfo: move, log: (l) => logs.push(l) });
    expect(linear).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes('could not be recorded'))).toBe(true);
    linear.mockClear();
    await applyLinearDependencyGate([task('DEV-3')], { graphql: send, linear, now, reported: new Map(), log: () => undefined });
    expect(linear).not.toHaveBeenCalled();
  });
});
