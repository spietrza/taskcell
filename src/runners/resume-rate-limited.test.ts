import { describe, it, expect } from 'vitest';
import { resumeRateLimited } from './resume-rate-limited.js';
import { rateLimitedMarker } from '../core/rate-limit-marker.js';
import type { GhRunner } from '../tasks/github.js';

const NOW = new Date('2026-11-09T03:00:00Z');
const PAST = new Date('2026-11-09T02:00:00Z');
const FUTURE = new Date('2026-11-09T05:00:00Z');

interface Item { kind: 'issue' | 'pr'; number: number; held?: boolean; comments: { body: string; login: string; association: string }[] }

/** A fake `gh` over a fixed set of parked items; records every edit. */
function fakeGh(items: Item[]): { gh: GhRunner; edits: string[][] } {
  const edits: string[][] = [];
  const gh: GhRunner = async (args) => {
    const [kind, verb] = args;
    if (verb === 'list') return JSON.stringify(items.filter((i) => i.kind === kind).map((i) => ({ number: i.number })));
    if (verb === 'view') {
      const item = items.find((i) => i.kind === kind && String(i.number) === args[2]);
      const comments = (item?.comments ?? []).map((c, n) => ({
        body: c.body, author: { login: c.login }, authorAssociation: c.association, createdAt: `2026-11-09T0${n}:00:00Z`,
      }));
      const labels = item?.held === false ? [] : [{ name: 'taskcell:rate-limited' }];
      return JSON.stringify({ comments, reviews: [], labels });
    }
    if (verb === 'edit') { edits.push(args); return ''; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, edits };
}

const owner = (body: string): { body: string; login: string; association: string } => ({ body, login: 'spietrza', association: 'OWNER' });

describe('resumeRateLimited', () => {
  it('re-applies the trigger and drops the hold only once the reset has passed', async () => {
    const { gh, edits } = fakeGh([
      { kind: 'issue', number: 1, comments: [owner(rateLimitedMarker(PAST, 'ready for agent'))] },
      { kind: 'pr', number: 2, comments: [owner(rateLimitedMarker(FUTURE, 'needs revision'))] },
    ]);
    const report = await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, log: () => {} });

    expect(report.resumed).toEqual(['o/r#1']);
    expect(report.waiting).toEqual(['o/r#2']);
    expect(edits).toEqual([
      ['issue', 'edit', '1', '--repo', 'o/r', '--remove-label', 'taskcell:rate-limited'],
      ['issue', 'edit', '1', '--repo', 'o/r', '--remove-label', 'ready for agent'],
      ['issue', 'edit', '1', '--repo', 'o/r', '--add-label', 'ready for agent'],
    ]);
  });

  it('--dry-run reports and edits nothing', async () => {
    const { gh, edits } = fakeGh([{ kind: 'issue', number: 1, comments: [owner(rateLimitedMarker(PAST, 'ready for agent'))] }]);
    const report = await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, dryRun: true, log: () => {} });
    expect(report.resumed).toEqual(['o/r#1']);
    expect(edits).toEqual([]);
  });

  it('ignores a marker from an untrusted author and one naming an unknown label', async () => {
    const { gh, edits } = fakeGh([
      { kind: 'issue', number: 1, comments: [{ body: rateLimitedMarker(PAST, 'ready for agent'), login: 'stranger', association: 'NONE' }] },
      { kind: 'issue', number: 2, comments: [owner(rateLimitedMarker(PAST, 'deploy'))] },
    ]);
    const report = await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, log: () => {} });
    expect(report.skipped).toEqual(['o/r#1', 'o/r#2']);
    expect(edits).toEqual([]);
  });

  it('--trigger-labels lets a repo with its own label names resume', async () => {
    const { gh } = fakeGh([{ kind: 'pr', number: 3, comments: [owner(rateLimitedMarker(PAST, 'factory: review'))] }]);
    const report = await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, triggerLabels: ['factory: review'], log: () => {} });
    expect(report.resumed).toEqual(['o/r#3']);
  });

  it('skips an item whose hold a claim already released (stale label-filtered list)', async () => {
    const { gh, edits } = fakeGh([{ kind: 'issue', number: 4, held: false, comments: [owner(rateLimitedMarker(PAST, 'ready for agent'))] }]);
    const report = await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, log: () => {} });
    expect(report.skipped).toEqual(['o/r#4']);
    expect(edits).toEqual([]);
  });

  it('creates no label when the repo labels cannot be listed: the trigger is re-applied as the marker names it', async () => {
    const { gh: base, edits } = fakeGh([{ kind: 'issue', number: 6, comments: [owner(rateLimitedMarker(PAST, 'ready for taskcell review'))] }]);
    const others: string[][] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] !== 'label') return base(args);
      others.push(args);
      if (args[1] === 'list') throw new Error('gh: 403');
      return '';
    };
    const report = await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, log: () => {} });
    expect(report.resumed).toEqual(['o/r#6']);
    expect(others.filter((c) => c[1] === 'create')).toEqual([]);
    expect(edits.at(-1)).toEqual(['issue', 'edit', '6', '--repo', 'o/r', '--add-label', 'ready for taskcell review']);
  });

  it('releases the hold under the spelling the item carries, and sends no empty edit when it is already gone', async () => {
    // The hold is re-read just before the release: `after` is what that second view returns.
    const run = async (after: string[]): Promise<{ report: Awaited<ReturnType<typeof resumeRateLimited>>; edits: string[][] }> => {
      const { gh: base, edits } = fakeGh([{ kind: 'issue', number: 5, comments: [owner(rateLimitedMarker(PAST, 'ready for agent'))] }]);
      let views = 0;
      const gh: GhRunner = async (args) => (args[1] === 'view' && ++views > 1 ? JSON.stringify({ labels: after.map((name) => ({ name })) }) : base(args));
      return { report: await resumeRateLimited({ repoSlug: 'o/r', now: NOW, gh, log: () => {} }), edits };
    };
    const retriggers = [['issue', 'edit', '5', '--repo', 'o/r', '--remove-label', 'ready for agent'], ['issue', 'edit', '5', '--repo', 'o/r', '--add-label', 'ready for agent']];

    expect((await run(['vanguard:rate-limited'])).edits).toEqual([['issue', 'edit', '5', '--repo', 'o/r', '--remove-label', 'vanguard:rate-limited'], ...retriggers]);
    for (const after of [['ready for agent'], []]) {
      const { report, edits } = await run(after);
      expect(report.resumed).toEqual(['o/r#5']);
      expect(report.failed).toEqual([]);
      expect(edits).toEqual(retriggers);
    }
  });
});
