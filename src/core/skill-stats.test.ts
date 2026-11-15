import { describe, expect, it } from 'vitest';
import { parseMetrics } from './stats.js';
import { aggregateSkills, formatSkillStats, parseSince, withinWindow } from './skill-stats.js';
import { MAX_SKILLS_USED } from './skills-used.js';

const line = (o: object): string => JSON.stringify({ evt: 'run_complete', costUsd: 1, ...o });
const NOW = Date.parse('2026-11-14T00:00:00Z');
const A = '2026-11-10T00:00:00Z';
const B = '2026-11-11T00:00:00Z';
const text = [
  line({ taskId: 'a', ts: A, stage: 'implementer', skillsUsed: ['simplify'], attempts: 3 }),
  line({ taskId: 'a', ts: A, stage: 'reviewer', skillsUsed: [], verdict: 'pass', costUsd: 3 }),
  line({ taskId: 'b', ts: B, stage: 'implementer', skillsUsed: [] }),
  line({ taskId: 'b', ts: B, stage: 'reviewer', skillsUsed: [], verdict: 'changes' }),
  line({ taskId: 'old', ts: '2026-01-01T00:00:00Z', stage: 'implementer' }), // record from before skillsUsed
].join('\n');

describe('skill stats', () => {
  it('loads old records without skillsUsed', () => {
    const records = parseMetrics(text);
    expect(records).toHaveLength(5);
    expect(records[4]).not.toHaveProperty('skillsUsed');
  });

  it('computes with/without per skill, leaving pre-field runs out', () => {
    const [row] = aggregateSkills(parseMetrics(text));
    expect(row?.skill).toBe('simplify');
    expect(row?.with).toMatchObject({ runs: 1, reviewed: 1, passRate: 1, avgRepairRounds: 2, avgCostUsd: 4 });
    expect(row?.without).toMatchObject({ runs: 1, reviewed: 1, passRate: 0, avgRepairRounds: 0, avgCostUsd: 2 });
    expect(formatSkillStats([row!])).toContain('Observational, not causal');
  });

  it('keeps re-runs of one task apart', () => {
    const rerun = [
      line({ taskId: 'gh-1', ts: A, skillsUsed: ['s'] }),
      line({ taskId: 'gh-1', ts: A, verdict: 'changes', skillsUsed: [] }),
      line({ taskId: 'gh-1', ts: B, skillsUsed: [] }),
      line({ taskId: 'gh-1', ts: B, verdict: 'pass', skillsUsed: [] }),
    ].join('\n');
    const [row] = aggregateSkills(parseMetrics(rerun));
    expect(row?.with).toMatchObject({ runs: 1, passRate: 0 });
    expect(row?.without).toMatchObject({ runs: 1, passRate: 1 });
  });

  it('keeps records without timestamps as separate runs', () => {
    const records = parseMetrics([
      line({ taskId: 'same', skillsUsed: ['s'], verdict: 'changes' }),
      line({ taskId: 'same', skillsUsed: [], verdict: 'pass' }),
    ].join('\n'));
    expect(aggregateSkills(records)[0]).toMatchObject({ with: { runs: 1 }, without: { runs: 1 } });
  });

  it('validates and caps skill ids read from metrics and before formatting', () => {
    const ids = Array.from({ length: MAX_SKILLS_USED + 10 }, (_, i) => `skill-${String(i).padStart(2, '0')}`);
    const [record] = parseMetrics(line({ taskId: 'safe', skillsUsed: [...ids, '\u001b[31m', 'x'.repeat(100)] }));
    expect(record?.skillsUsed).toHaveLength(MAX_SKILLS_USED);
    const row = aggregateSkills([record!])[0]!;
    expect(formatSkillStats([{ ...row, skill: '\u001b[31m' }])).toBe('No skill usage recorded yet.');
  });

  it('a run passes only when every verdict passes', () => {
    const both = [line({ taskId: 'x', ts: A, skillsUsed: ['s'], verdict: 'changes' }), line({ taskId: 'x', ts: A, skillsUsed: [], verdict: 'pass' })].join('\n');
    expect(aggregateSkills(parseMetrics(both))[0]?.with.passRate).toBe(0);
  });

  it('parses --since windows', () => {
    expect(parseSince('30d')).toBe(30 * 86_400_000);
    expect(parseSince('x')).toBeUndefined();
    expect(parseSince('0d')).toBeUndefined();
    expect(withinWindow(parseMetrics(text), parseSince('30d'), NOW)).toHaveLength(4);
  });
});
