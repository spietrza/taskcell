import { describe, expect, it, vi } from 'vitest';
import { applyDependencyGate } from './dependencies.js';
import { createOverlapChecker, isSharedPath, overlapHoldMs, overlapMarker } from './overlap.js';
import { resumeRateLimited } from '../runners/resume-rate-limited.js';
import { githubIssueWatchPrimitives } from '../runners/watch.js';
import type { GhRunner } from './github.js';
import type { Task } from './fetcher.js';

const manifest = (...paths: string[]): string => `<spec_manifest>${JSON.stringify({ files: paths.map((path) => ({ path })) })}</spec_manifest>`;
const trusted = { author: { login: 'alice' }, authorAssociation: 'OWNER' };
const specComments = (...paths: string[]): Task['comments'] => [{ author: 'alice', body: manifest(...paths), authorAssociation: 'OWNER' } as Task['comments'][number]];
const issue = (number: number, ...paths: string[]): Task => ({
  id: `o/r#${number}`, title: 't', description: '', labels: ['ready for agent'], children: [], ref: String(number), author: 'alice',
  comments: paths.length > 0 ? specComments(...paths) : [],
});
const NOW = new Date('2026-11-13T12:00:00Z');
const HOUR = 3_600_000;
const until = (hours: number): Date => new Date(NOW.getTime() + hours * HOUR);
const pr = (number: number, files: string[], extra: object = {}): object => ({ number, headRefName: 'chore/vanguard-gh-o-r-99-abc', isCrossRepository: false, files: files.map((path) => ({ path })), ...extra });

interface Setup {
  gh: GhRunner;
  calls: string[][];
  check: ReturnType<typeof createOverlapChecker>;
}
function setup(prs: object[], opts: { running?: Task[]; existing?: object[]; failList?: boolean } = {}): Setup {
  const calls: string[][] = [];
  const gh: GhRunner = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: opts.existing ?? [] });
    return '';
  });
  const check = createOverlapChecker({
    repo: 'o/r', claimedLabel: 'taskcell:running', gh,
    fetch: async (id) => (opts.running ?? []).find((t) => t.id === id)!,
    list: async () => {
      if (opts.failList === true) throw new Error('boom');
      return (opts.running ?? []).map((t) => ({ ...t, comments: [], author: undefined }) as unknown as Task);
    },
  });
  return { gh, calls, check };
}
const gate = (tasks: Task[], s: Setup, holdMs = 6 * HOUR): Promise<Task[]> =>
  applyDependencyGate(tasks, { repo: 'o/r', trigger: 'ready for agent', gh: s.gh, now: NOW, log: () => {}, overlap: { check: s.check, holdMs } });
const comments = (s: Setup): string[] => s.calls.filter((c) => c[0] === 'issue' && c[1] === 'comment').map((c) => c.join(' '));

describe('isSharedPath', () => {
  it('counts the real generated files and aggregates, not their hand-written sources', () => {
    for (const f of ['apps/desktop/src/wire.ts', 'apps/desktop/src/hub-wire.ts', 'src/hub/commands/index.ts', 'pnpm-lock.yaml', 'CHANGELOG.md', 'x/foo.generated.ts']) expect(isSharedPath(f)).toBe(true);
    for (const f of ['src/wire.ts', 'src/hub-wire.ts', 'src/a.ts', 'src/hub/commands/start.ts']) expect(isSharedPath(f)).toBe(false);
  });
});

describe('overlap hold', () => {
  it('holds an issue overlapping an open factory PR, with one comment', async () => {
    const s = setup([pr(9, ['src/a.ts', 'src/z.ts']), pr(10, ['src/a.ts'], { headRefName: 'human/x' })]);
    expect(await gate([issue(1, 'src/a.ts')], s)).toEqual([]);
    expect(comments(s)).toHaveLength(1);
    expect(comments(s)[0]).toContain('PR #9 (`src/a.ts`)');
    expect(comments(s)[0]).not.toContain('#10');
    expect(s.calls.some((c) => c[0] === 'issue' && c[1] === 'edit' && c.includes('taskcell:waiting'))).toBe(true);
  });

  it('holds on an in-flight run, but never on itself', async () => {
    const s = setup([], { running: [issue(5, 'src/a.ts')] });
    expect(await gate([issue(1, 'src/a.ts')], s)).toEqual([]);
    expect(comments(s)[0]).toContain('run #5');
    const self = setup([], { running: [issue(1, 'src/a.ts')] });
    expect(await gate([issue(1, 'src/a.ts')], self)).toHaveLength(1);
  });

  it('is not held by its own earlier PR, a fork PR, or a non-factory PR', async () => {
    const own = setup([pr(9, ['src/a.ts'], { headRefName: 'chore/vanguard-gh-o-r-1-xyz' })]);
    expect(await gate([issue(1, 'src/a.ts')], own)).toHaveLength(1);
    const fork = setup([pr(9, ['src/a.ts'], { isCrossRepository: true })]);
    expect(await gate([issue(1, 'src/a.ts')], fork)).toHaveLength(1);
    const other = setup([pr(9, ['src/a.ts'], { headRefName: 'chore/vanguard-gh-o-r-12-xyz' })]);
    expect(await gate([issue(1, 'src/a.ts')], other)).toEqual([]);
  });

  it('ignores generated and aggregate overlap', async () => {
    const shared = ['pnpm-lock.yaml', 'CHANGELOG.md', 'apps/desktop/src/hub-wire.ts', 'src/hub/commands/index.ts'];
    expect(await gate([issue(1, ...shared)], setup([pr(9, shared)]))).toHaveLength(1);
  });

  it('does not hold an issue without a manifest', async () => {
    expect(await gate([issue(1)], setup([pr(9, ['src/a.ts'])]))).toHaveLength(1);
  });

  it('lets non-overlapping issues start and holds later overlapping ones in the same batch', async () => {
    const s = setup([pr(9, ['src/a.ts'])]);
    const out = await gate([issue(1, 'src/a.ts'), issue(2, 'src/b.ts'), issue(3, 'src/b.ts'), issue(4)], s);
    expect(out.map((t) => t.id)).toEqual(['o/r#2', 'o/r#4']);
  });

  it('starts anyway once the deadline has passed, and holds before it', async () => {
    const marker = (h: number): object => ({ body: overlapMarker(until(h), [{ kind: 'pr', number: 9, files: [] }]), ...trusted });
    expect(await gate([issue(1, 'src/a.ts')], setup([pr(9, ['src/a.ts'])], { existing: [marker(-1)] }))).toHaveLength(1);
    const young = setup([pr(9, ['src/a.ts'])], { existing: [marker(2)] });
    expect(await gate([issue(1, 'src/a.ts')], young)).toEqual([]);
    expect(comments(young)).toHaveLength(0); // newest comment already carries the marker
  });

  it('does nothing when the hold is off (0) and fails open when the check throws', async () => {
    const s = setup([pr(9, ['src/a.ts'])]);
    expect(await gate([issue(1, 'src/a.ts')], s, 0)).toHaveLength(1);
    expect(s.calls.filter((c) => c[0] === 'pr')).toHaveLength(0);
    expect(await gate([issue(1, 'src/a.ts')], setup([], { running: [issue(5, 'src/a.ts')], failList: true }))).toHaveLength(1);
  });

  it('stays held when the label edit fails', async () => {
    const s = setup([pr(9, ['src/a.ts'])]);
    const base = s.gh;
    const gh: GhRunner = async (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') throw new Error('nope');
      return base(args);
    };
    const out = await applyDependencyGate([issue(1, 'src/a.ts')], { repo: 'o/r', trigger: 'ready for agent', gh, now: NOW, log: () => {}, overlap: { check: s.check, holdMs: 6 * HOUR } });
    expect(out).toEqual([]);
  });
});

describe('overlapHoldMs', () => {
  it('defaults to 6 h when unset or empty, 0 turns it off', () => {
    expect(overlapHoldMs({})).toBe(6 * HOUR);
    expect(overlapHoldMs({ VANGUARD_OVERLAP_HOLD_HOURS: '' })).toBe(6 * HOUR);
    expect(overlapHoldMs({ VANGUARD_OVERLAP_HOLD_HOURS: '12' })).toBe(12 * HOUR);
    expect(overlapHoldMs({ VANGUARD_OVERLAP_HOLD_HOURS: '0' })).toBe(0);
  });
});

describe('resume of an overlap hold', () => {
  const resume = async (ref: { kind: 'pr' | 'run'; number: number }, api: object, deadline: Date, invalid = false): Promise<{ resumed: string[]; waiting: string[] }> => {
    const gh: GhRunner = vi.fn(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 1 }]);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          title: 't', body: invalid ? 'Start: 2026-13-45' : '', labels: [{ name: 'taskcell:waiting' }],
          comments: [{ body: `${overlapMarker(deadline, [{ ...ref, files: [] }])}\n<!-- taskcell:waiting trigger="ready for agent" -->`, author: { login: 'github-actions' }, authorAssociation: 'NONE' }],
        });
      }
      if (args[0] === 'api' && args[1] === `repos/o/r/issues/${ref.number}`) return JSON.stringify(api);
      if (args[0] === 'api' || (args[0] === 'pr' && args[1] === 'list')) return '[]';
      return '';
    });
    return resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, log: () => {} });
  };
  it('keeps waiting while the PR is open, releases once closed or past the deadline', async () => {
    const pr9 = { kind: 'pr', number: 9 } as const;
    expect((await resume(pr9, { state: 'open' }, until(2))).waiting).toContain('o/r#1');
    expect((await resume(pr9, { state: 'closed' }, until(2))).resumed).toContain('o/r#1');
    expect((await resume(pr9, { state: 'open' }, until(-1))).resumed).toContain('o/r#1');
  });
  it('releases a run that is no longer running even though its issue is open', async () => {
    const run = { kind: 'run', number: 9 } as const;
    expect((await resume(run, { state: 'open', labels: [{ name: 'taskcell:running' }] }, until(2))).waiting).toContain('o/r#1');
    expect((await resume(run, { state: 'open', labels: [{ name: 'needs info' }] }, until(2))).resumed).toContain('o/r#1');
  });
  it('does not apply a stale marker to an invalid verdict', async () => {
    const report = await resume({ kind: 'pr', number: 9 }, { state: 'open' }, until(2), true);
    expect(report.waiting).not.toContain('o/r#1');
  });
});

describe('watch wiring', () => {
  it('holds a listed issue overlapping an open factory PR', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 1, title: 't', body: '', labels: [{ name: 'ready for agent' }] }]);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ number: 1, title: 't', body: '', labels: [{ name: 'ready for agent' }], author: { login: 'alice' }, comments: [{ ...trusted, body: manifest('src/a.ts'), createdAt: '2026-01-01T00:00:00Z' }] });
      }
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([pr(9, ['src/a.ts'])]);
      if (args[0] === 'api' && args[1] === 'repos/o/r/issues/1') return JSON.stringify({ user: { login: 'alice' }, author_association: 'OWNER' });
      return '{}';
    };
    const prims = githubIssueWatchPrimitives({
      deps: { repoSlug: 'o/r', feedbackAuthors: ['alice'] } as never, label: 'ready for agent', claimedLabel: 'taskcell:running', reviewLabel: 'taskcell:needs-human-review', gh,
    });
    await prims.listReady();
    expect(calls.some((c) => c[0] === 'pr' && c[1] === 'list')).toBe(true);
  });
});
