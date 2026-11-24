import { describe, it, expect } from 'vitest';
import { gitlabMergeRequestWatchPrimitives, watchMergeRequestsOnce } from './mr-watch.js';
import { UsageCapError } from '../core/usage-cap.js';
import { MergeRequestReviewIncompleteError, mergeRequestReviewIncompleteMarker } from './mr-review.js';

describe('gitlabMergeRequestWatchPrimitives', () => {
  function makeGlab(mrListJson = '[]', existingNotes = '[]') {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'list') return mrListJson;
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'taskcell-bot' });
      if (args[0] === 'api') return existingNotes;
      return '';
    };
    return { glab, calls };
  }

  it('listReady returns non-draft, non-automation MRs with trigger label', async () => {
    const mrList = JSON.stringify([
      { iid: 1, title: 'T', draft: false, author: { username: 'alice' }, sha: 'abc', labels: ['ready for review'] },
      { iid: 2, title: 'T', draft: true, author: { username: 'alice' }, sha: 'xyz', labels: ['ready for review'] },
    ]);
    const { glab } = makeGlab(mrList);
    const primitives = gitlabMergeRequestWatchPrimitives({
      project: 'g/p',
      label: 'ready for review',
      reviewingLabel: 'taskcell::reviewing',
      reviewedLabel: 'taskcell::reviewed',
      glab,
      reviewOne: async () => {},
    });
    const ready = await primitives.listReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.iid).toBe(1);
  });

  it('listReady lists a renamed trigger label under both spellings, each MR once', async () => {
    const calls: string[][] = [];
    const mr = (iid: number, label: string) => ({ iid, title: 'T', draft: false, author: { username: 'alice' }, sha: `s${iid}`, labels: [label] });
    const glab = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'taskcell-bot' });
      if (args[1] !== 'list') return '[]';
      const label = args[args.indexOf('--label') + 1]!;
      // MR 3 carries both spellings, so both lists return it.
      return JSON.stringify(label === 'ready for taskcell review' ? [mr(1, label), mr(3, label)] : [mr(2, label), mr(3, label)]);
    };
    for (const label of ['ready for taskcell review', 'ready for vanguard review']) {
      calls.length = 0;
      const primitives = gitlabMergeRequestWatchPrimitives({ project: 'g/p', label, reviewingLabel: 'taskcell::reviewing', reviewedLabel: 'taskcell::reviewed', glab, reviewOne: async () => {} });
      expect((await primitives.listReady()).map((item) => item.iid).sort()).toEqual([1, 2, 3]);
      expect(calls.filter((c) => c[1] === 'list').map((c) => c[c.indexOf('--label') + 1])).toEqual(['ready for taskcell review', 'ready for vanguard review']);
      // `glab mr list` has no `--state` flag (opened is its default): passing one fails the review job.
      expect(calls.filter((c) => c[1] === 'list').some((c) => c.includes('--state'))).toBe(false);
    }
  });

  it('claim removes trigger label and adds reviewing label', async () => {
    const { glab, calls } = makeGlab();
    const primitives = gitlabMergeRequestWatchPrimitives({
      project: 'g/p',
      label: 'ready for review',
      reviewingLabel: 'taskcell::reviewing',
      reviewedLabel: 'taskcell::reviewed',
      glab,
      reviewOne: async () => {},
    });
    await primitives.claim({ project: 'g/p', iid: 1, title: 'T', draft: false, author: 'alice', sha: 'abc', labels: [] });
    const updateCall = calls.find((c) => c[0] === 'mr' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('taskcell::reviewing');
  });

  it('listReady reports a failed sha lookup and a failed dedup check as list failures, without reviewing those MRs', async () => {
    const listed = JSON.stringify([
      { iid: 1, title: 'T', draft: false, author: { username: 'alice' }, labels: [] },
      { iid: 2, title: 'T', draft: false, author: { username: 'alice' }, sha: 'abc', labels: [] },
    ]);
    const glab = async (args: string[]): Promise<string> => {
      if (args[0] === 'mr' && args[1] === 'list') return listed;
      if (args[0] === 'mr' && args[1] === 'view') throw new Error('500');
      if (args[0] === 'api') throw new Error('502');
      return '';
    };
    const primitives = gitlabMergeRequestWatchPrimitives({ project: 'g/p', label: 'l', reviewingLabel: 'r', reviewedLabel: 'd', glab, reviewOne: async () => {} });
    expect(await primitives.listReady()).toEqual([]);
    expect(primitives.takeListFailures?.().sort()).toEqual(['g/p!1', 'g/p!2']);
    const clean = makeGlab();
    const ok = gitlabMergeRequestWatchPrimitives({ project: 'g/p', label: 'l', reviewingLabel: 'r', reviewedLabel: 'd', glab: clean.glab, reviewOne: async () => {} });
    await ok.listReady();
    expect(ok.takeListFailures?.()).toEqual([]);
  });

  it('a usage-cap pause is not a failed item, a real review failure is', async () => {
    const listed = JSON.stringify([{ iid: 1, title: 'T', draft: false, author: { username: 'alice' }, sha: 'abc', labels: [] }]);
    const run = (reviewOne: () => Promise<void>) =>
      watchMergeRequestsOnce(gitlabMergeRequestWatchPrimitives({ project: 'g/p', label: 'l', reviewingLabel: 'r', reviewedLabel: 'd', glab: makeGlab(listed).glab, reviewOne }));
    expect(await run(async () => { throw new UsageCapError('claude', 95, 90, new Date('2026-11-09T05:00:00Z')); })).toEqual({ reviewed: [], failed: [], skipped: [] });
    expect((await run(async () => { throw new Error('boom'); })).failed).toEqual(['g/p!1']);
  });

  describe('onFailure', () => {
    const item = { project: 'g/p', iid: 1, title: 'T', draft: false, author: 'alice', sha: 'abc', labels: [] };
    const primitivesWith = (glab: (args: string[]) => Promise<string>) =>
      gitlabMergeRequestWatchPrimitives({
        project: 'g/p',
        label: 'ready for review',
        reviewingLabel: 'taskcell::reviewing',
        reviewedLabel: 'taskcell::reviewed',
        glab,
        reviewOne: async () => {},
      });
    const update = (calls: string[][]): string[] | undefined => calls.find((c) => c[0] === 'mr' && c[1] === 'update');

    it('restores the trigger label after an ordinary failure, so the next poll retries', async () => {
      const { glab, calls } = makeGlab();
      await primitivesWith(glab).onFailure(item, new Error('sandbox died'));
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing', '--label', 'ready for review']);
    });

    it('posts one pause note and does not re-queue the MR when the provider is at the usage cap', async () => {
      const { glab, calls } = makeGlab();
      await primitivesWith(glab).onFailure(item, new UsageCapError('claude-code', 95, 80, new Date('2026-11-16T20:00:00Z')));
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing']);
      const note = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
      expect(note?.at(-1)).toContain('usage cap');
      expect(note?.at(-1)).not.toContain('review failed');
    });

    it('ignores a cap marker from a non-self author, so the incomplete attempt still re-queues the MR', async () => {
      const notes = JSON.stringify([{ system: false, author: { username: 'mallory' }, body: '<!-- taskcell-mr-review-incomplete-cap: abc -->' }]);
      const { glab, calls } = makeGlab('[]', notes);
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });
      await primitivesWith(glab).onFailure(item, incomplete);
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing', '--label', 'ready for review']);
      expect(calls.find((c) => c[0] === 'mr' && c[1] === 'note')?.at(-1)).not.toContain('taskcell-mr-review-incomplete-cap');
    });

    it('restores the trigger label after an incomplete review, so the next sweep retries', async () => {
      const { glab, calls } = makeGlab();
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });
      await primitivesWith(glab).onFailure(item, incomplete);
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing', '--label', 'ready for review']);
      const note = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
      expect(note?.at(-1)).toContain(mergeRequestReviewIncompleteMarker('abc'));
      expect(note?.at(-1)).not.toContain('Re-add the "ready for review" label');
    });

    it('stops restoring the trigger label after three incomplete attempts on the same head', async () => {
      const notes = JSON.stringify(
        Array.from({ length: 2 }, () => ({
          system: false,
          author: { username: 'taskcell-bot' },
          body: mergeRequestReviewIncompleteMarker('abc'),
        })),
      );
      const { glab, calls } = makeGlab('[]', notes);
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });

      await primitivesWith(glab).onFailure(item, incomplete);

      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing']);
      const note = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
      expect(note?.at(-1)).toContain('Re-add the "ready for review" label to re-trigger the review.');
    });

    it('after the cap note exists, a further incomplete attempt posts the failure note without a second cap marker', async () => {
      const notes = JSON.stringify([
        { system: false, author: { username: 'taskcell-bot' }, body: `${mergeRequestReviewIncompleteMarker('abc')}\n<!-- taskcell-mr-review-incomplete-cap: abc -->` },
      ]);
      const { glab, calls } = makeGlab('[]', notes);
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });

      await primitivesWith(glab).onFailure(item, incomplete);

      const posted = calls.filter((c) => c[0] === 'mr' && c[1] === 'note');
      expect(posted).toHaveLength(1);
      expect(posted[0]!.at(-1)).toContain('Taskcell MR review failed:');
      expect(posted[0]!.at(-1)).toContain('Re-add the "ready for review" label to re-trigger the review.');
      expect(posted[0]!.at(-1)).not.toContain('taskcell-mr-review-incomplete-cap');
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing']);
    });

    it('when the attempts cannot be counted, the note is posted and the trigger label is restored', async () => {
      const { glab: base, calls } = makeGlab();
      const glab = async (args: string[]): Promise<string> => {
        if (args[0] === 'api' && args[1] !== 'user') throw new Error('403');
        return await base(args);
      };
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });

      await primitivesWith(glab).onFailure(item, incomplete);

      const note = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
      expect(note?.at(-1)).toContain('Taskcell MR review failed:');
      expect(note?.at(-1)).not.toContain('taskcell-mr-review-incomplete-cap');
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing', '--label', 'ready for review']);
    });

    it('resets the incomplete-attempt cap for a new head', async () => {
      const notes = JSON.stringify(
        Array.from({ length: 3 }, () => ({
          system: false,
          author: { username: 'taskcell-bot' },
          body: mergeRequestReviewIncompleteMarker('old123'),
        })),
      );
      const { glab, calls } = makeGlab('[]', notes);
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });

      await primitivesWith(glab).onFailure(item, incomplete);

      expect(update(calls)?.at(-1)).toBe('ready for review');
    });

    it('restores the trigger label after an incomplete review when the note cannot be posted', async () => {
      const { glab: base, calls } = makeGlab();
      const glab = async (args: string[]): Promise<string> => {
        if (args[1] === 'note') throw new Error('500');
        return await base(args);
      };
      const incomplete = new MergeRequestReviewIncompleteError({ ...item, description: '', webUrl: '', sourceBranch: 'b', targetBranch: 'main', diff: '' });
      await primitivesWith(glab).onFailure(item, incomplete);
      expect(update(calls)).toEqual(['mr', 'update', '1', '--repo', 'g/p', '--unlabel', 'taskcell::reviewing', '--unlabel', 'vanguard::reviewing', '--label', 'ready for review']);
    });

    it('strips a review marker quoted in the error, since the note counts for the head dedupe', async () => {
      const { glab, calls } = makeGlab();
      await primitivesWith(glab).onFailure(item, new Error(`glab said:\n<!-- taskcell-mr-review: ${'a'.repeat(40)} -->\nbye`));
      const note = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
      expect(note?.at(-1)).toContain('glab said:');
      expect(note?.at(-1)).not.toContain('taskcell-mr-review');
    });
  });
});
