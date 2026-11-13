// The approver's scorecard and mode switch for the hub's project settings and task cards. Reads the
// metrics branch's decisions.jsonl and GitHub PR state (what `taskcell stats --approver` prints) and
// `.taskcell/approver.json` on the base branch; never a model call. The mode is never written in place:
// `openApproverModePr` opens a pull request a human merges, like Enable factory does.
import { DECISIONS_FILE } from '../approver/ledger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectApproverScorecard } from '../approver/outcome.js';
import { loadPolicy } from '../approver/policy.js';
import { AUTO_MERGE_STREAK_THRESHOLD, parseDecisions } from '../approver/scorecard.js';
import { DEFAULT_BASE_BRANCH, readRepoBaseBranch } from '../core/base-branch.js';
import { readBranchFile } from '../core/metrics-branch.js';
import { parseJsonlLines } from '../core/stats.js';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME } from '../core/state-path.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { defaultExec, type FactoryExec } from './enable-factory.js';
import type { ApproverMode, ApproverModeChange, ApproverPeriod, ApproverPrDecision, ApproverScorecard } from '../wire.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<Exclude<ApproverPeriod, 'all'>, number> = { '30d': 30, '90d': 90 };
const TOP_REASONS = 5;

/**
 * Open issues the act switch waits on (#939): while this list is non-empty the hub does not offer `act`
 * and refuses to open a PR that turns it on. Empty it when the issue is closed.
 */
export const ACT_BLOCKING_ISSUES: readonly number[] = [939];

export const NO_DECISIONS_HINT = 'Run `taskcell approve` from your CI workflow (it records every verdict on the taskcell-metrics branch) and its scorecard will show up here.';

export interface ApproverModeInfo {
  mode: ApproverMode;
  policyFound: boolean;
  base: string;
}

/** The approver's mode as `.taskcell/approver.json` on the base branch says: no valid file or `enabled: false` is off. */
export async function readApproverMode(repoPath: string): Promise<ApproverModeInfo> {
  const base = (await readRepoBaseBranch(repoPath)) ?? DEFAULT_BASE_BRANCH;
  const loaded = await loadPolicy(repoPath, base);
  if (loaded === undefined) return { mode: 'off', policyFound: false, base };
  const { enabled, act } = loaded.policy;
  return { mode: !enabled ? 'off' : act === true ? 'act' : 'shadow', policyFound: true, base };
}

const empty = (period: ApproverPeriod, info: ApproverModeInfo, hint: string): ApproverScorecard => ({
  status: 'no-data',
  period,
  hint,
  mode: info.mode,
  policyFound: info.policyFound,
  actOffered: ACT_BLOCKING_ISSUES.length === 0,
  threshold: AUTO_MERGE_STREAK_THRESHOLD,
  judged: 0,
  approves: 0,
  escalates: 0,
  approvesRight: 0,
  approvesWrong: 0,
  approvesPending: 0,
  barMet: false,
  byRiskClass: [],
  topReasons: [],
});

/** The scorecard `taskcell stats --approver` prints, restricted to decisions made in the period, summarised. */
export async function approverScorecard(repoPath: string, period: ApproverPeriod, now: number = Date.now()): Promise<ApproverScorecard> {
  const [info, text] = await Promise.all([
    readApproverMode(repoPath),
    readBranchFile(repoPath, { file: DECISIONS_FILE }).catch(() => ''),
  ]);
  const all = parseDecisions(text);
  if (all.length === 0) return empty(period, info, `No approver decisions on the metrics branch yet. ${NO_DECISIONS_HINT}`);
  const since = period === 'all' ? undefined : now - PERIOD_DAYS[period] * DAY_MS;
  const decisions = since === undefined ? all : all.filter((d) => Date.parse(d.timestamp) >= since);
  if (decisions.length === 0) return empty(period, info, `No approver decisions in the last ${PERIOD_DAYS[period as '30d' | '90d']} days.`);

  const report = await collectApproverScorecard(decisions);
  const judged = report.rows.filter((r) => r.verdict !== null);
  const approves = judged.filter((r) => r.verdict === 'APPROVE');
  const escalates = judged.filter((r) => r.verdict === 'ESCALATE');
  const reasons = new Map<string, number>();
  for (const row of escalates) for (const rule of row.rulesFired) reasons.set(rule, (reasons.get(rule) ?? 0) + 1);
  return {
    ...empty(period, info, ''),
    status: 'ok',
    judged: judged.length,
    approves: approves.length,
    escalates: escalates.length,
    approvesRight: approves.filter((r) => r.humanOutcome === 'merged-as-is').length,
    approvesWrong: approves.filter((r) => r.humanOutcome !== null && r.humanOutcome !== 'merged-as-is').length,
    approvesPending: approves.filter((r) => r.humanOutcome === null).length,
    barMet: report.byRiskClass.some((c) => c.streak >= report.autoMergeStreakThreshold),
    threshold: report.autoMergeStreakThreshold,
    byRiskClass: report.byRiskClass.map(({ riskClass, approveTotal, approveCorrect, streak }) => ({ riskClass, approveTotal, approveCorrect, streak })),
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_REASONS)
      .map(([reason, count]) => ({ reason, count })),
  };
}

/** The approver's standing decision per PR (the latest record; a recorded merge wins): for task cards and their detail. No gh call. */
export async function approverPrDecisions(repoPath: string): Promise<ApproverPrDecision[]> {
  const text = await readBranchFile(repoPath, { file: DECISIONS_FILE }).catch(() => '');
  const merged = new Set<number>();
  const latest = new Map<number, { verdict: 'APPROVE' | 'ESCALATE'; rules: string[]; ts: string }>();
  for (const line of parseJsonlLines(text)) {
    if (typeof line.prNumber !== 'number') continue;
    if (line.action === 'merge') merged.add(line.prNumber);
    if (line.verdict !== 'APPROVE' && line.verdict !== 'ESCALATE') continue;
    if (typeof line.timestamp !== 'string') continue;
    const prior = latest.get(line.prNumber);
    if (prior !== undefined && prior.ts.localeCompare(line.timestamp) > 0) continue;
    const rules = Array.isArray(line.rulesFired) ? line.rulesFired.filter((r): r is string => typeof r === 'string') : [];
    latest.set(line.prNumber, { verdict: line.verdict, rules, ts: line.timestamp });
  }
  const out: ApproverPrDecision[] = [];
  for (const prNumber of new Set([...latest.keys(), ...merged])) {
    const d = latest.get(prNumber);
    const outcome = merged.has(prNumber) ? 'merged' : d?.verdict === 'APPROVE' ? 'would-merge' : 'left';
    out.push({ prNumber, outcome, reasons: outcome === 'left' ? (d?.rules ?? []) : [] });
  }
  return out.sort((a, b) => a.prNumber - b.prNumber);
}

/** Plain-words scorecard line for a PR body: the numbers the user saw when they decided. */
export function scorecardSentence(card: ApproverScorecard): string {
  if (card.status === 'no-data') return `No approver data (${card.hint ?? 'none recorded'}).`;
  const best = card.byRiskClass.reduce((m, c) => Math.max(m, c.streak), 0);
  return (
    `Last ${card.period === 'all' ? 'all-time' : card.period}: ${card.judged} pull requests judged, ${card.approves} APPROVE ` +
    `(${card.approvesRight} right, ${card.approvesWrong} wrong, ${card.approvesPending} pending), ${card.escalates} ESCALATE. ` +
    `Best streak ${best} of ${card.threshold} correct APPROVEs in a row in one risk class; the bar is ${card.barMet ? 'met' : 'not met'}.`
  );
}

/** The policy's new content for a mode: `enabled` / `act` flipped, every other key kept as written. */
export function policyForMode(raw: string, mode: ApproverMode): string {
  const json = JSON.parse(raw) as Record<string, unknown>;
  json.enabled = mode !== 'off';
  json.act = mode === 'act';
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** Branch the mode PR is opened from. Fixed: a second request resets and reuses it (and its open PR). */
export const APPROVER_MODE_BRANCH = 'vanguard/approver-mode';

export interface OpenModePrInput {
  repoPath: string;
  mode: ApproverMode;
  card: ApproverScorecard;
  exec?: FactoryExec;
}

/**
 * Branch from `origin/<base>`, change `.taskcell/approver.json`, push the branch and open a PR against
 * the base — never a push to the base itself. The user's checkout is restored afterwards.
 */
export async function openApproverModePr(input: OpenModePrInput): Promise<ApproverModeChange> {
  const exec = input.exec ?? defaultExec;
  const { repoPath, mode } = input;
  const run = async (file: string, args: string[]): Promise<string> => (await exec(file, args, { cwd: repoPath })).stdout.trim();
  const base = (await readRepoBaseBranch(repoPath)) ?? DEFAULT_BASE_BRANCH;
  if (base === APPROVER_MODE_BRANCH) throw new BadRequestError('refusing to use the base branch as the approver-mode branch');

  if ((await run('git', ['status', '--porcelain', '--untracked-files=no'])) !== '') {
    throw new BadRequestError('the working tree has uncommitted changes; commit or stash them before changing the approver mode');
  }
  await run('git', ['fetch', 'origin', base]);
  const dir = (await exec('git', ['cat-file', '-e', `origin/${base}:${STATE_DIR_NAME}/approver.json`], { cwd: repoPath }).then(() => true, () => false))
    ? STATE_DIR_NAME
    : LEGACY_STATE_DIR_NAME;
  const file = `${dir}/approver.json`;
  let raw: string;
  try {
    raw = await run('git', ['show', `origin/${base}:${file}`]);
  } catch {
    throw new BadRequestError(`${STATE_DIR_NAME}/approver.json is not on ${base}; add the approver policy first`);
  }
  let next: string;
  try {
    next = policyForMode(raw, mode);
  } catch {
    throw new BadRequestError(`${file} on ${base} is not valid JSON; fix it by hand first`);
  }
  if (next.trim() === raw.trim()) throw new BadRequestError(`the approver is already in ${mode} mode on ${base}`);

  const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const original = head === 'HEAD' ? await run('git', ['rev-parse', 'HEAD']) : head;
  await run('git', ['checkout', '-B', APPROVER_MODE_BRANCH, `origin/${base}`]);
  try {
    await mkdir(join(repoPath, dir), { recursive: true });
    await writeFile(join(repoPath, file), next);
    await run('git', ['add', file]);
    await run('git', ['commit', '-m', `chore: set the approver to ${mode} mode`, '--', file]);
    await run('git', ['push', '--force', '-u', 'origin', APPROVER_MODE_BRANCH]);
  } finally {
    await run('git', ['checkout', '-f', original]);
  }

  const existing = await run('gh', ['pr', 'list', '--head', APPROVER_MODE_BRANCH, '--base', base, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""']);
  const body = [
    `Sets the approver to **${mode}** mode in \`${file}\` (\`enabled\`/\`act\`). Merge it to apply; nothing changes until then.`,
    '',
    '### Scorecard when this was opened',
    scorecardSentence(input.card),
    ...(mode === 'act' && !input.card.barMet ? ['', '**The bar is not met** — the requester confirmed turning act mode on anyway.'] : []),
  ].join('\n');
  if (existing !== '') {
    await run('gh', ['pr', 'edit', existing, '--body', body]);
    return { branch: APPROVER_MODE_BRANCH, prUrl: existing, mode };
  }
  const prUrl = await run('gh', ['pr', 'create', '--title', `chore: set the approver to ${mode} mode`, '--body', body, '--base', base, '--head', APPROVER_MODE_BRANCH]);
  return { branch: APPROVER_MODE_BRANCH, prUrl, mode };
}
