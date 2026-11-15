import { alignTable } from './table.js';
import { sanitizeSkillIds } from './skills-used.js';
import type { MetricRecord } from './stats.js';

/** One run (the stage records sharing a taskId and run timestamp) folded to what `stats --skills` compares. */
interface RunSummary {
  skills: Set<string>;
  costUsd: number;
  repairRounds: number;
  /** Every reviewer/conformance verdict of the run; the run passes only when all are 'pass'. */
  verdicts: string[];
}

export interface SkillGroup {
  runs: number;
  /** Runs with a review verdict, the pass-rate denominator. */
  reviewed: number;
  passRate?: number;
  avgRepairRounds: number;
  avgCostUsd: number;
}

export interface SkillRow {
  skill: string;
  with: SkillGroup;
  without: SkillGroup;
}

/** Parse `30d` / `12h` into milliseconds; undefined when malformed or zero. */
export function parseSince(value: string): number | undefined {
  const m = /^(\d+)([dh])$/.exec(value);
  const ms = m === null ? 0 : Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
  return ms > 0 ? ms : undefined;
}

/** Records at or after `now - windowMs`; records without a parseable ts are dropped when a window is set. */
export function withinWindow(records: readonly MetricRecord[], windowMs: number | undefined, now: number = Date.now()): readonly MetricRecord[] {
  return windowMs === undefined ? records : records.filter((r) => r.ts !== undefined && Date.parse(r.ts) >= now - windowMs);
}

/**
 * Group stage records into runs by `taskId|ts`; a record without `ts` is its own run (as lessons-stats
 * does). A run with any record lacking `skillsUsed` (recorded before the field, or a stage's transcript
 * was withheld) has unknown skills, so it is left out, not counted as "without".
 */
function summarize(records: readonly MetricRecord[]): RunSummary[] {
  const runs = new Map<string, RunSummary & { known: boolean }>();
  records.forEach((r, i) => {
    const key = r.ts === undefined ? `#${i}` : `${r.taskId}|${r.ts}`;
    const run = runs.get(key) ?? { skills: new Set<string>(), costUsd: 0, repairRounds: 0, verdicts: [], known: true };
    for (const s of sanitizeSkillIds(r.skillsUsed ?? [])) run.skills.add(s);
    if (r.skillsUsed === undefined) run.known = false;
    run.costUsd += r.costUsd;
    // Gate repairs and resumes fold into one stage record as extra attempts.
    run.repairRounds += Math.max(0, (r.attempts ?? 1) - 1);
    if (r.verdict !== undefined) run.verdicts.push(r.verdict);
    runs.set(key, run);
  });
  return [...runs.values()].filter((r) => r.known);
}

function group(runs: readonly RunSummary[]): SkillGroup {
  const reviewed = runs.filter((r) => r.verdicts.length > 0);
  const n = runs.length;
  return {
    runs: n,
    reviewed: reviewed.length,
    ...(reviewed.length > 0 ? { passRate: reviewed.filter((r) => r.verdicts.every((v) => v === 'pass')).length / reviewed.length } : {}),
    avgRepairRounds: n === 0 ? 0 : runs.reduce((a, r) => a + r.repairRounds, 0) / n,
    avgCostUsd: n === 0 ? 0 : runs.reduce((a, r) => a + r.costUsd, 0) / n,
  };
}

/** Per skill: runs that used it vs runs that did not. Observational only. */
export function aggregateSkills(records: readonly MetricRecord[]): SkillRow[] {
  const runs = summarize(records);
  const skills = [...new Set(runs.flatMap((r) => [...r.skills]))].sort();
  return skills.map((skill) => ({
    skill,
    with: group(runs.filter((r) => r.skills.has(skill))),
    without: group(runs.filter((r) => !r.skills.has(skill))),
  }));
}

const pct = (g: SkillGroup): string => (g.passRate === undefined ? '-' : `${(g.passRate * 100).toFixed(0)}%`);

export function formatSkillStats(rows: readonly SkillRow[]): string {
  // One id at a time: the cap bounds a record's list, not the number of table rows.
  const safeRows = rows.filter((row) => sanitizeSkillIds([row.skill]).length === 1);
  if (safeRows.length === 0) return 'No skill usage recorded yet.';
  const header = ['skill', 'runs', 'pass', 'repairs', 'cost', '|', 'runs w/o', 'pass w/o', 'repairs w/o', 'cost w/o'];
  const body = safeRows.map((r) => [
    r.skill,
    String(r.with.runs),
    pct(r.with),
    r.with.avgRepairRounds.toFixed(2),
    r.with.avgCostUsd.toFixed(4),
    '|',
    String(r.without.runs),
    pct(r.without),
    r.without.avgRepairRounds.toFixed(2),
    r.without.avgCostUsd.toFixed(4),
  ]);
  return `${alignTable([header, ...body])}\n\nObservational, not causal: pass = every review verdict of the run is PASS (incomplete counts as not passing), repairs = extra agent attempts per run, cost = USD per run. Runs differ in task difficulty, so a gap is a hint, not proof the skill helped.`;
}
