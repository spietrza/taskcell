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
      const labels = item?.held === false ? [] : [{ name: 'vanguard:rate-limited' }];
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
      ['issue', 'edit', '1', '--repo', 'o/r', '--remove-label', 'vanguard:rate-limited'],
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
});
