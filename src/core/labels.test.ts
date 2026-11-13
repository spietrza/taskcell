import { describe, expect, it } from 'vitest';
import { currentLabel, hasLabel, hasReviewHeading, labelForms, labelValue, legacyLabel, resolveRemovals, sameLabel, withoutLabel } from './labels.js';

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
    expect(await resolveRemovals(['taskcell:waiting'], async () => [])).toEqual(['taskcell:waiting']);
    expect(await resolveRemovals(['taskcell:waiting'], async () => { throw new Error('gh down'); })).toEqual(['taskcell:waiting']);
    let fetched = false;
    expect(await resolveRemovals(['needs info'], async () => { fetched = true; return []; })).toEqual(['needs info']);
    expect(fetched).toBe(false);
  });
});
