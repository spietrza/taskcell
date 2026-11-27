import { describe, expect, it } from 'vitest';
import {
  aggregateScores, classifyMatch, datasetHash, findingsOfReply, formatBenchReport, locateFinding, matchFindings,
  parseAacrDataset, runReviewerBench, samePath, samplePrs, scorePr, JUDGE_WINDOW, LINE_TOLERANCE,
} from './reviewer-bench.js';
import type { BenchIssue, BenchPr } from './reviewer-bench.js';
import type { Finding } from '../wire.js';

const issue = (file: string, start: number, end = start): BenchIssue => ({ file, startLine: start, endLine: end, text: 'x' });
const finding = (evidence: string, severity: Finding['severity'] = 'medium'): Finding => ({ severity, kind: 'correctness', title: 't', evidence });
const pr = (id: string, issues: BenchIssue[]): BenchPr => ({ id, repo: 'o/r', title: '', body: '', diff: 'd', issues });

describe('locateFinding / samePath', () => {
  it('reads file:line and file:a-b from evidence, falling back to the title', () => {
    expect(locateFinding(finding('see src/a.ts:42 here'))).toMatchObject({ file: 'src/a.ts', line: 42 });
    expect(locateFinding({ ...finding('no loc'), title: 'lib/b.py:7-9 bad' })).toMatchObject({ file: 'lib/b.py', line: 7 });
    expect(locateFinding(finding('no location')).file).toBeUndefined();
  });
  it('matches on a path-boundary suffix only', () => {
    expect(samePath('a/src/x.ts', 'src/x.ts')).toBe(true);
    expect(samePath('a/xsrc/x.ts', 'src/x.ts')).toBe(false);
    expect(samePath('b/src/x.ts', 'src/x.ts')).toBe(true);
  });
});

describe('classifyMatch', () => {
  const i = issue('src/a.ts', 10, 20);
  const at = (line: number) => ({ ...finding(''), file: 'src/a.ts', line });
  it('is a match inside the range and within the tolerance', () => {
    expect(classifyMatch(at(15), i)).toBe('match');
    expect(classifyMatch(at(20 + LINE_TOLERANCE), i)).toBe('match');
    expect(classifyMatch(at(10 - LINE_TOLERANCE), i)).toBe('match');
  });
  it('is a close call just past the tolerance, or with no line', () => {
    expect(classifyMatch(at(20 + LINE_TOLERANCE + 1), i)).toBe('close');
    expect(classifyMatch({ ...finding(''), file: 'src/a.ts' }, i)).toBe('close');
  });
  it('is none beyond the judge window, in another file, or with no file', () => {
    expect(classifyMatch(at(20 + JUDGE_WINDOW + 1), i)).toBe('none');
    expect(classifyMatch({ ...at(15), file: 'src/b.ts' }, i)).toBe('none');
    expect(classifyMatch(finding(''), i)).toBe('none');
  });
});

describe('matchFindings', () => {
  it('matches one-to-one: two findings on one issue count once', async () => {
    const pairs = await matchFindings([finding('src/a.ts:10'), finding('src/a.ts:11')], [issue('src/a.ts', 10)]);
    expect(pairs).toEqual([{ finding: 0, issue: 0 }]);
  });
  it('asks the judge only for close calls, and honours a no', async () => {
    const asked: string[] = [];
    const judge = async (f: { evidence: string }): Promise<boolean> => (asked.push(f.evidence), f.evidence.includes('yes'));
    const pairs = await matchFindings(
      [finding('src/a.ts:100 no'), finding('src/a.ts:100 yes'), finding('src/a.ts:10 exact')],
      [issue('src/a.ts', 10), issue('src/a.ts', 120)],
      judge,
    );
    expect(pairs).toEqual([{ finding: 2, issue: 0 }, { finding: 1, issue: 1 }]);
    expect(asked).toEqual(['src/a.ts:100 no', 'src/a.ts:100 yes']);
  });
  it('without a judge a close call is not a match', async () => {
    expect(await matchFindings([finding('src/a.ts:100')], [issue('src/a.ts', 120)])).toEqual([]);
  });
});

describe('scoring', () => {
  it('splits blocking from non-blocking and aggregates precision/recall/F1', async () => {
    const p = pr('p1', [issue('a.ts', 10), issue('b.ts', 5), issue('c.ts', 1), issue('d.ts', 1)]);
    const s = await scorePr(p, {
      findings: [finding('a.ts:10', 'high'), finding('b.ts:5', 'low'), finding('z.ts:1', 'critical'), finding('y.ts:1', 'low')],
      completed: true, tokens: 100, costUsd: 0.5, durationMs: 1000,
    });
    expect(s).toMatchObject({ findings: 4, matchedFindings: 2, issues: 4, blocking: 2, blockingMatched: 1 });
    const m = aggregateScores('m', [s]);
    expect(m).toMatchObject({ precision: 0.5, recall: 0.5, f1: 0.5, nonBlocking: 2, nonBlockingMatched: 1, costUsd: 0.5 });
  });
  it('is all zeros, not NaN, with no findings and omits an unpriced cost', () => {
    const m = aggregateScores('m', [{ prId: 'p', findings: 0, issues: 3, matchedFindings: 0, matchedIssues: 0, blocking: 0, blockingMatched: 0, completed: false, tokens: 0, durationMs: 0 }]);
    expect(m).toMatchObject({ precision: 0, recall: 0, f1: 0, incomplete: 1 });
    expect(m.costUsd).toBeUndefined();
  });
  it('reads findings from a reply block', () => {
    const reply = '<findings>[{"severity":"high","kind":"security","title":"t","evidence":"a.ts:1"}]</findings>';
    expect(findingsOfReply(reply)).toHaveLength(1);
    expect(findingsOfReply('no block')).toEqual([]);
  });
});

describe('dataset', () => {
  const rec = (id: string) => ({ id, repo: 'o/r', title: 'T', diff: 'diff', comments: [{ path: 'a.ts', line: 3, text: 'bug' }] });
  it('parses JSONL and JSON arrays, dropping records without a diff or issues', () => {
    const good = rec('1');
    const text = [JSON.stringify(good), JSON.stringify({ ...rec('2'), diff: undefined }), JSON.stringify({ ...rec('3'), comments: [] })].join('\n');
    expect(parseAacrDataset(text).map((p) => p.id)).toEqual(['1']);
    expect(parseAacrDataset(JSON.stringify([good]))[0]?.issues[0]).toMatchObject({ file: 'a.ts', startLine: 3, endLine: 3 });
  });
  it('hashes content and samples deterministically', () => {
    expect(datasetHash('a')).toBe(datasetHash('a'));
    expect(datasetHash('a')).not.toBe(datasetHash('b'));
    const prs = Array.from({ length: 10 }, (_, i) => pr(`p${i}`, []));
    expect(samplePrs(prs, 3).map((p) => p.id)).toEqual(samplePrs([...prs].reverse(), 3).map((p) => p.id));
    expect(samplePrs(prs, 3)).toHaveLength(3);
  });
});

describe('runReviewerBench / formatBenchReport', () => {
  it('runs each model over each PR and prints dataset hash and per-model metrics', async () => {
    const prs = [pr('p1', [issue('a.ts', 1)])];
    const models = await runReviewerBench({
      prs,
      models: ['codex/gpt-6-sol', 'claude/opus'],
      review: async (model) => ({ findings: model.startsWith('codex') ? [finding('a.ts:1')] : [], completed: true, tokens: 10, durationMs: 2000 }),
    });
    expect(models.map((m) => m.recall)).toEqual([1, 0]);
    const out = formatBenchReport({ dataset: 'd', version: 'data/v2', datasetHash: 'sha256:abc', sampleSize: 1, models });
    expect(out).toContain('sha256:abc');
    expect(out).toContain('data/v2');
    expect(out).toContain('precision 100.0%');
    expect(out).toContain('claude/opus');
  });
});
