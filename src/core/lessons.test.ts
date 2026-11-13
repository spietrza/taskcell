import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  appendLessonRecords,
  capLessons,
  countLessonRuns,
  finalizeLessons,
  lessonId,
  loadLessonsForTask,
  parseLessons,
  readLessons,
  renderLessons,
  selectLessons,
} from './lessons.js';
import type { Lesson } from './lessons.js';
import { changedFilesOf } from '../runners/re-review.js';
import { loadRetrospectiveMemory } from './retrospective-memory.js';

const lesson = (rule: string, paths: string[] = [], ts = '2026-11-12T10:00:00.000Z'): Lesson => ({
  kind: 'lesson',
  id: lessonId(rule),
  rule,
  why: 'why',
  evidence: 'https://github.com/o/r/pull/1',
  paths,
  repo: 'o/r',
  prNumber: 1,
  timestamp: ts,
});

describe('finalizeLessons', () => {
  const ctx = { repo: 'o/r', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', evidenceUrls: new Set(['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/7#issuecomment-1']), now: new Date('2026-11-12T00:00:00Z') };

  it('caps at 3, dedupes by rule, keeps known evidence and falls back to the PR url otherwise', () => {
    const out = finalizeLessons(
      [
        { rule: 'Add .taskcell to .dockerignore', why: 'leak', evidence: 'https://github.com/o/r/pull/7#issuecomment-1' },
        { rule: 'add  .taskcell to .dockerignore', why: 'dup', evidence: '' },
        { rule: 'B', why: '', evidence: 'https://evil.example/x' },
        { rule: 'C', why: '', evidence: '' },
        { rule: 'D', why: '', evidence: '' },
      ],
      ctx,
    );
    expect(out.map((l) => l.rule)).toEqual(['Add .taskcell to .dockerignore', 'B']);
    expect(out[0]!.evidence).toBe('https://github.com/o/r/pull/7#issuecomment-1');
    expect(out[1]!.evidence).toBe('https://github.com/o/r/pull/7');
  });

  it('redacts secrets and drops unsafe globs', () => {
    const [l] = finalizeLessons(
      [{ rule: 'Never log token=abcdef0123456789abcdef', why: 'Bearer abcdefghijklmnop leaked', evidence: '', paths: ['src/core/**', '../etc/*', '/abs'] }],
      ctx,
    );
    expect(l!.rule).not.toContain('abcdef0123456789');
    expect(l!.why).not.toContain('abcdefghijklmnop');
    expect(l!.paths).toEqual(['src/core/**']);
  });
});

describe('parseLessons / selectLessons / renderLessons', () => {
  it('drops a dismissed lesson', () => {
    const a = lesson('A');
    const b = lesson('B');
    const text = [a, b, { kind: 'dismiss', id: a.id, timestamp: 'x' }, 'not json'].map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
    expect(parseLessons(text).map((l) => l.rule)).toEqual(['B']);
  });

  it('keeps repo-wide lessons and path-scoped ones whose glob matches a path the task mentions', () => {
    const all = [lesson('repo-wide'), lesson('core', ['src/core/**']), lesson('docs', ['docs/*.md'])];
    expect(selectLessons(all, 'Fix the cache in src/core/state-path.ts').map((l) => l.rule)).toEqual(['core', 'repo-wide']);
    expect(selectLessons(all, 'Touch src/core and docs/cli.md').map((l) => l.rule)).toEqual(['core', 'docs', 'repo-wide']);
  });

  it('renders within the byte cap, whole lines only', () => {
    const md = renderLessons([lesson('x'.repeat(100)), lesson('y'.repeat(100))], 200);
    expect(md).toContain('# Lessons from past PRs');
    expect(md).toContain('x'.repeat(100));
    expect(md).not.toContain('y'.repeat(100));
    expect(renderLessons([])).toBe('');
  });
});

describe('selection by files and cap ordering', () => {
  const wire = lesson('wire', ['src/wire.ts']);

  it('selects a lesson by a planned file even when the task text names no path', () => {
    expect(selectLessons([wire], 'Rename the label')).toEqual([]);
    expect(selectLessons([wire], 'Rename the label', ['src/wire.ts']).map((l) => l.rule)).toEqual(['wire']);
  });

  it('selects by the files of a diff', () => {
    const all = [lesson('desk', ['apps/desktop/**']), wire];
    expect(selectLessons(all, '', changedFilesOf('diff --git a/apps/desktop/src/x.ts b/apps/desktop/src/x.ts\n')).map((l) => l.rule)).toEqual(['desk']);
  });

  it('ranks by glob specificity, then violations, then newest', () => {
    const broad = lesson('broad', ['src/**'], '2026-11-12T12:00:00.000Z');
    const exact = lesson('exact', ['src/wire.ts'], '2026-11-12T08:00:00.000Z');
    const often = { ...lesson('often', ['src/*.ts'], '2026-11-12T09:00:00.000Z'), violations: 3 };
    const rarely = lesson('rarely', ['src/*.ts'], '2026-11-12T11:00:00.000Z');
    const ranked = selectLessons([broad, rarely, often, exact], '', ['src/wire.ts']).map((l) => l.rule);
    expect(ranked).toEqual(['exact', 'often', 'rarely', 'broad']);
    // the cap keeps the head of the ranking, not the newest
    expect(capLessons(selectLessons([broad, exact], '', ['src/wire.ts']), 100).map((l) => l.rule)).toEqual(['exact']);
  });

  it('cuts repo-wide lessons first under the cap', () => {
    const ranked = selectLessons([lesson('repo-wide'), wire], '', ['src/wire.ts']).map((l) => l.rule);
    expect(ranked).toEqual(['wire', 'repo-wide']);
  });

  it('counts the runs that received each lesson', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-lesson-runs-'));
    try {
      const task = join(dir, '.taskcell', 'runs', 't1');
      await mkdir(task, { recursive: true });
      const rec = (ts: string, ids: string[]) => JSON.stringify({ timestamp: ts, lessonIds: ids });
      await writeFile(join(task, 'a-implementer.json'), rec('a', ['x', 'y']));
      await writeFile(join(task, 'a-reviewer.json'), rec('a', ['x']));
      await writeFile(join(task, 'b-implementer.json'), rec('b', ['x']));
      await writeFile(join(task, 'c.json'), '{}');
      expect(Object.fromEntries(await countLessonRuns(dir))).toEqual({ x: 2, y: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('metrics-branch round trip', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vg-lessons-'));
    const origin = join(root, 'origin.git');
    await execa('git', ['init', '--quiet', '--bare', origin]);
    const seed = join(root, 'seed');
    await execa('git', ['init', '--quiet', '-b', 'main', seed]);
    await execa('git', ['-C', seed, 'config', 'user.email', 't@t']);
    await execa('git', ['-C', seed, 'config', 'user.name', 't']);
    await writeFile(join(seed, 'README.md'), 'x\n');
    await execa('git', ['-C', seed, 'add', '.']);
    await execa('git', ['-C', seed, 'commit', '--quiet', '-m', 'seed']);
    await execa('git', ['-C', seed, 'push', '--quiet', origin, 'main']);
    repo = join(root, 'repo');
    await execa('git', ['clone', '--quiet', origin, repo]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores lessons once per rule, injects the relevant ones into the next run, and honours a dismissal', async () => {
    const core = lesson('Re-resolve a cached state dir', ['src/core/**']);
    const docs = lesson('Update docs/cli.md with every new flag', ['docs/**']);
    expect((await appendLessonRecords(repo, [core, docs])).pushed).toBe(2);
    expect((await appendLessonRecords(repo, [core])).pushed).toBe(0);
    expect(await readLessons(repo)).toHaveLength(2);

    const memory = await loadRetrospectiveMemory(repo, { taskText: 'Bug in src/core/state-path.ts' });
    expect(memory).toContain('Re-resolve a cached state dir');
    expect(memory).not.toContain('Update docs/cli.md');
    // Without task text the loader stays local-only (no fetch).
    expect(await loadRetrospectiveMemory(repo)).not.toContain('Lessons from past PRs');

    await appendLessonRecords(repo, [{ kind: 'dismiss', id: core.id, timestamp: '2026-11-12T11:00:00.000Z' }]);
    expect(await loadLessonsForTask(repo, 'Bug in src/core/state-path.ts')).toEqual({ text: '', ids: [] });
  });

  it('injects a lesson by planned file and reports the injected ids', async () => {
    const wire = lesson('Regenerate the mirrored wire copy', ['src/wire.ts']);
    await appendLessonRecords(repo, [wire]);
    let ids: string[] = [];
    const memory = await loadRetrospectiveMemory(repo, { taskText: 'Rename the label', files: ['src/wire.ts'], onLessons: (got) => (ids = got) });
    expect(memory).toContain('Regenerate the mirrored wire copy');
    expect(ids).toEqual([wire.id]);
    expect((await loadLessonsForTask(repo, 'Rename the label')).ids).toEqual([]);
  });

  it('yields no lessons (never throws) when there is no remote branch or no repo', async () => {
    expect(await loadLessonsForTask(repo, 'src/core/x.ts')).toEqual({ text: '', ids: [] });
    expect(await loadLessonsForTask(join(root, 'missing'), 'src/core/x.ts')).toEqual({ text: '', ids: [] });
  });
});
