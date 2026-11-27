import { describe, expect, it } from 'vitest';
import { changedFiles, fileLink, generateGuidedReview, renderGuidedReview, validateChapters } from './guided-review.js';

const diff = (...paths: string[]): string => paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
const ch = (files: string[], overview = 'Does a thing.') => ({ title: 'T', overview, files });

describe('validateChapters', () => {
  const files = ['src/a.ts', 'src/b.ts'];
  it('accepts every file exactly once', () => {
    expect(validateChapters([ch(['src/a.ts']), ch(['src/b.ts'])], files)).toEqual([]);
  });
  it('flags a missing file', () => {
    expect(validateChapters([ch(['src/a.ts'])], files)).toEqual(['missing file: src/b.ts']);
  });
  it('flags an invented file', () => {
    expect(validateChapters([ch(['src/a.ts', 'src/b.ts', 'src/x.ts'])], files)).toEqual(['invented file: src/x.ts']);
  });
  it('flags a duplicate file', () => {
    expect(validateChapters([ch(['src/a.ts', 'src/b.ts']), ch(['src/a.ts'])], files)).toEqual(['duplicate file: src/a.ts']);
  });
  it('flags an overview naming a path outside the diff', () => {
    expect(validateChapters([ch(files, 'Edits `src/zzz.ts`.')], files)).toHaveLength(1);
  });
});

describe('generateGuidedReview', () => {
  const d = diff('src/a.ts', 'pnpm-lock.yaml');
  const reply = (files: string[]): string => `<chapters>${JSON.stringify({ chapters: [ch(files)] })}</chapters>`;
  it('groups generated files in their own chapter', async () => {
    const out = await generateGuidedReview(async () => reply(['src/a.ts']), d);
    expect(out?.map((c) => c.files)).toEqual([['src/a.ts'], ['pnpm-lock.yaml']]);
  });
  it('drops the section on an invalid reply or a failure', async () => {
    expect(await generateGuidedReview(async () => reply(['src/a.ts', 'nope.ts']), d)).toBeUndefined();
    expect(await generateGuidedReview(async () => reply(['pnpm-lock.yaml']), d)).toBeUndefined();
    expect(await generateGuidedReview(async () => { throw new Error('x'); }, d)).toBeUndefined();
    expect(await generateGuidedReview(async () => 'garbage', d)).toBeUndefined();
  });
});

describe('renderGuidedReview', () => {
  it('links each file into Files changed', () => {
    const out = renderGuidedReview([ch(['src/a.ts'])], 'https://github.com/o/r/pull/5', 'gh');
    expect(out).toContain('## Guided review');
    expect(out).toContain(fileLink('https://github.com/o/r/pull/5', 'src/a.ts', 'gh'));
    expect(out).toContain('/pull/5/files#diff-');
    expect(changedFiles(diff('x.ts'))).toEqual(['x.ts']);
  });
});
