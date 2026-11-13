import { describe, expect, it } from 'vitest';
import { currentLabel, hasLabel, hasReviewHeading, labelForms, labelValue, legacyLabel, resolveAdds, resolveRemovals, sameLabel, withoutLabel } from './labels.js';

describe('label spellings (taskcell written, vanguard still read)', () => {
  it('maps between the current and legacy spelling, GitHub and GitLab scoped', () => {
    expect(legacyLabel('taskcell:running')).toBe('vanguard:running');
    expect(legacyLabel('taskcell::reviewed')).toBe('vanguard::reviewed');
    expect(legacyLabel('ready for taskcell review')).toBe('ready for vanguard review');
    expect(currentLabel('vanguard:model=opus')).toBe('taskcell:model=opus');
    expect(currentLabel('ready for vanguard review')).toBe('ready for taskcell review');
    expect(currentLabel('ready for agent')).toBe('ready for agent');
    expect(labelForms('vanguard:waiting')).toEqual(['taskcell:waiting', 'vanguard:waiting']);
    expect(labelForms('needs info')).toEqual(['needs info']);
  });

  it('matches a label in either spelling', () => {
    expect(sameLabel('vanguard:running', 'taskcell:running')).toBe(true);
    expect(sameLabel('taskcell:running', 'taskcell:waiting')).toBe(false);
    expect(hasLabel(['bug', 'vanguard:waiting'], 'taskcell:waiting')).toBe(true);
    expect(hasLabel(['bug', 'taskcell:waiting'], 'taskcell:waiting')).toBe(true);
    expect(hasLabel(['bug'], 'taskcell:waiting')).toBe(false);
    expect(withoutLabel(['bug', 'vanguard:waiting', 'taskcell:waiting'], 'taskcell:waiting')).toEqual(['bug']);
  });

  it('reads a prefixed label value in either spelling', () => {
    expect(labelValue('vanguard:base=uat', 'taskcell:base=')).toBe('uat');
    expect(labelValue('taskcell:base=uat', 'taskcell:base=')).toBe('uat');
    expect(labelValue('taskcell:model=opus', 'taskcell:base=')).toBeUndefined();
  });

  it('recognises the review heading in either spelling', () => {
    expect(hasReviewHeading('## Taskcell Review\n\nok')).toBe(true);
    expect(hasReviewHeading('## Vanguard Review\n\nok')).toBe(true);
    expect(hasReviewHeading('## Review')).toBe(false);
  });

  it('removes a label under the spelling the item carries, never a twin it does not', async () => {
    expect(await resolveRemovals(['taskcell:waiting', 'needs info'], async () => ['vanguard:waiting'])).toEqual(['vanguard:waiting', 'needs info']);
    expect(await resolveRemovals(['taskcell:waiting'], async () => ['taskcell:waiting', 'vanguard:waiting'])).toEqual(['taskcell:waiting', 'vanguard:waiting']);
    expect(await resolveRemovals(['taskcell:waiting'], async () => [])).toEqual([]); // an item with no labels lacks it too: no-op
    expect(await resolveRemovals(['taskcell:waiting'], async () => ['Vanguard:Waiting'])).toEqual(['Vanguard:Waiting']); // label names are case-insensitive
    expect(await resolveRemovals(['taskcell:waiting', 'needs info'], async () => ['needs info'])).toEqual(['needs info']); // the item lacks either spelling: no-op
    expect(await resolveRemovals(['taskcell:waiting'], async () => { throw new Error('gh down'); })).toEqual(['taskcell:waiting']);
    const skipped: string[] = [];
    expect(await resolveRemovals(['taskcell:running', 'needs info'], async () => ['x'], (l) => skipped.push(l))).toEqual(['needs info']);
    expect(skipped).toEqual(['taskcell:running']);
    // only in-flight labels are reported: a hold the item rarely carries is dropped silently
    expect(await resolveRemovals(['taskcell:rate-limited', 'vanguard:revising', 'taskcell:reviewing'], async () => [], (l) => skipped.push(l))).toEqual([]);
    expect(skipped).toEqual(['taskcell:running', 'vanguard:revising', 'taskcell:reviewing']);
    let fetched = false;
    expect(await resolveRemovals(['needs info'], async () => { fetched = true; return []; })).toEqual(['needs info']);
    expect(fetched).toBe(false);
  });

  describe('resolveAdds', () => {
    const repo = (names: string[] | Error): { gh: (args: string[]) => Promise<string>; calls: string[][] } => {
      const calls: string[][] = [];
      return {
        calls,
        gh: async (args) => {
          calls.push(args);
          if (args[1] !== 'list') return '';
          if (names instanceof Error) throw names;
          return JSON.stringify(names.map((name) => ({ name })));
        },
      };
    };
    const creates = (calls: string[][]): string[][] => calls.filter((c) => c[1] === 'create');

    it('adds the legacy spelling on a repo that has only the old labels', async () => {
      const { gh, calls } = repo(['vanguard:running', 'needs info']);
      expect(await resolveAdds(['taskcell:running', 'needs info'], 'o/r', gh)).toEqual(['vanguard:running', 'needs info']);
      expect(creates(calls)).toEqual([]);
    });

    it('adds the current spelling when the repo has it, also next to the legacy one or when asked by the old name', async () => {
      expect(await resolveAdds(['taskcell:running'], 'o/r', repo(['taskcell:running']).gh)).toEqual(['taskcell:running']);
      expect(await resolveAdds(['vanguard:running'], 'o/r', repo(['taskcell:running', 'vanguard:running']).gh)).toEqual(['taskcell:running']);
    });

    it('creates the current label first when the repo has neither spelling', async () => {
      const { gh, calls } = repo([]);
      expect(await resolveAdds(['taskcell:waiting'], 'o/r', gh)).toEqual(['taskcell:waiting']);
      expect(creates(calls)).toEqual([['label', 'create', 'taskcell:waiting', '--repo', 'o/r']]);
    });

    it('keeps the review trigger on the name the workflows fire on', async () => {
      expect(await resolveAdds(['ready for taskcell review'], 'o/r', repo(['ready for taskcell review', 'ready for vanguard review']).gh)).toEqual(['ready for vanguard review']);
      expect(await resolveAdds(['ready for vanguard review'], 'o/r', repo(['ready for taskcell review']).gh)).toEqual(['ready for taskcell review']);
      const { gh, calls } = repo([]);
      expect(await resolveAdds(['ready for taskcell review'], 'o/r', gh)).toEqual(['ready for vanguard review']);
      expect(creates(calls)).toEqual([['label', 'create', 'ready for vanguard review', '--repo', 'o/r']]);
    });

    it('compares case-insensitively and returns the repo spelling, creating no twin', async () => {
      const { gh, calls } = repo(['Vanguard:Secret-Blocked']);
      expect(await resolveAdds(['taskcell:secret-blocked'], 'o/r', gh)).toEqual(['Vanguard:Secret-Blocked']);
      expect(creates(calls)).toEqual([]);
    });

    it('force-creates only the labels the caller asked to ensure when the repo labels cannot be listed', async () => {
      const { gh, calls } = repo(new Error('gh down'));
      expect(await resolveAdds(['taskcell:waiting', 'taskcell:running', 'needs info'], 'o/r', gh, ['taskcell:waiting'])).toEqual(['taskcell:waiting', 'taskcell:running', 'needs info']);
      expect(creates(calls)).toEqual([['label', 'create', 'taskcell:waiting', '--repo', 'o/r', '--force']]);
    });

    it('creates nothing when the repo labels cannot be listed and the caller ensures no label', async () => {
      const { gh, calls } = repo(new Error('gh down'));
      expect(await resolveAdds(['taskcell:running', 'ready for taskcell review'], 'o/r', gh)).toEqual(['taskcell:running', 'ready for taskcell review']);
      expect(creates(calls)).toEqual([]);
    });

    it('does not force-create an ensured label when the list succeeds', async () => {
      const { gh, calls } = repo(['vanguard:waiting']);
      expect(await resolveAdds(['taskcell:waiting'], 'o/r', gh, ['taskcell:waiting'])).toEqual(['vanguard:waiting']);
      expect(creates(calls)).toEqual([]);
    });

    it('lists the repo labels only for a label with a legacy twin, and falls back to the names as given', async () => {
      const plain = repo([]);
      expect(await resolveAdds(['needs info'], 'o/r', plain.gh)).toEqual(['needs info']);
      expect(plain.calls).toEqual([]);
      expect(await resolveAdds(['taskcell:waiting'], 'o/r', repo(new Error('gh down')).gh)).toEqual(['taskcell:waiting']);
    });
  });
});
