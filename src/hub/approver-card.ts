// The approver's scorecard and mode switch for the hub's project settings and task cards. Reads the
// metrics branch's decisions.jsonl and GitHub PR state (what `taskcell stats --approver` prints) and
// `.taskcell/approver.json` on the base branch; never a model call. The mode is never written in place:
// `openApproverModePr` opens a pull request a human merges, like Enable factory does.
import { DECISIONS_FILE } from '../approver/ledger.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectApproverScorecard } from '../approver/outcome.js';
import { dedicatedReviewers } from '../approver/facts.js';
import { loadPolicy } from '../approver/policy.js';
import { AUTO_MERGE_STREAK_THRESHOLD, parseDecisions } from '../approver/scorecard.js';
import { assertSafeBaseBranch, DEFAULT_BASE_BRANCH, readRepoBaseBranch } from '../core/base-branch.js';
import { readBranchFile } from '../core/metrics-branch.js';
import { parseJsonlLines } from '../core/stats.js';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME } from '../core/state-path.js';
import { keyedLock } from '../core/keyed-lock.js';
import { hostGitArgs } from '../worktree/host-git.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { githubSlug } from './command-kit.js';
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
  /** Why act mode is refused for this repo's policy ('' when the policy allows it). */
  actHold: string;
}

/** What the approver card and `set_approver_mode` say when the policy has no dedicated reviewer login. */
export const NO_REVIEWER_LOGIN_HINT =
  'Add the login of the GitHub App that posts the PR review (not github-actions, and not the App the factory itself runs as) to "reviewAuthors" in .taskcell/approver.json on the base branch (the bare login, without "app/" or "[bot]"), and make the PR-review workflow post with that App\'s token.';

/**
 * The base branch the approver's policy lives on, resolved like Enable factory's default branch: the repo's
 * configured `baseBranch`, else the branch `origin/HEAD` points at (what `gh repo view` calls the default
 * branch; local, no network), else `main`.
 */
export async function approverBaseBranch(repoPath: string, exec: FactoryExec = defaultExec): Promise<string> {
  const configured = await readRepoBaseBranch(repoPath);
  if (configured !== undefined) return configured;
  try {
    const ref = (await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })).stdout.trim();
    const name = ref.startsWith('origin/') ? ref.slice('origin/'.length) : '';
    if (name !== '') {
      assertSafeBaseBranch(name);
      return name;
    }
  } catch {
    // no origin/HEAD, or a name that is not a safe branch: fall through
  }
  return DEFAULT_BASE_BRANCH;
}

/** Whether a decision's recorded `repo` is the project's own slug (GitHub slugs are case-insensitive). */
const isOwnRepo = (repo: unknown, slug: string | undefined): boolean =>
  slug !== undefined && typeof repo === 'string' && repo.toLowerCase() === slug.toLowerCase();

/** The approver's mode as `.taskcell/approver.json` on the base branch says: no valid file or `enabled: false` is off. */
export async function readApproverMode(repoPath: string): Promise<ApproverModeInfo> {
  const base = await approverBaseBranch(repoPath);
  const loaded = await loadPolicy(repoPath, base);
  if (loaded === undefined) return { mode: 'off', policyFound: false, base, actHold: '' };
  const { enabled, act } = loaded.policy;
  return { mode: !enabled ? 'off' : act === true ? 'act' : 'shadow', policyFound: true, base, actHold: dedicatedReviewers(loaded.policy).length === 0 ? NO_REVIEWER_LOGIN_HINT : '' };
}

const empty = (period: ApproverPeriod, info: ApproverModeInfo, hint: string): ApproverScorecard => ({
  status: 'no-data',
  period,
  hint,
  mode: info.mode,
  policyFound: info.policyFound,
  actOffered: ACT_BLOCKING_ISSUES.length === 0 && info.actHold === '',
  actHold: info.actHold,
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

/** The card for a switch-off request, which never reads the scorecard: turning the approver off must not depend on it. */
export const unreadScorecard = (period: ApproverPeriod): ApproverScorecard =>
  empty(period, { mode: 'off', policyFound: true, base: '', actHold: '' }, 'The scorecard was not read: the approver is being switched off.');

/** The scorecard `taskcell stats --approver` prints, restricted to decisions made in the period, summarised. */
export async function approverScorecard(repoPath: string, period: ApproverPeriod, now: number = Date.now()): Promise<ApproverScorecard> {
  // Sequential on purpose: the policy read and the metrics-branch read both fetch.
  const info = await readApproverMode(repoPath);
  const text = await readBranchFile(repoPath, { file: DECISIONS_FILE }).catch(() => '');
  // Only the project's own repository: decisions.jsonl may name others, and each would cost a `gh` call.
  const slug = await githubSlug(repoPath);
  const recorded = parseDecisions(text);
  const own = recorded.filter((d) => isOwnRepo(d.repo, slug));
  // One spelling for the slug, so case variants of it are one repository (one gh call, each PR counted once).
  const all = own.map((d) => ({ ...d, repo: own[0]!.repo }));
  if (all.length === 0 && recorded.length > 0) {
    return empty(period, info, `The metrics branch has approver decisions, but none for this project's repository (${slug ?? 'no GitHub origin remote'}).`);
  }
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
  // Keyed by PR number, so only the project's own repository: another repo's #7 must not stand in for this one's.
  const slug = await githubSlug(repoPath);
  const merged = new Set<number>();
  const latest = new Map<number, { verdict: 'APPROVE' | 'ESCALATE'; rules: string[]; ts: string }>();
  for (const line of parseJsonlLines(text)) {
    if (typeof line.prNumber !== 'number' || !isOwnRepo(line.repo, slug)) continue;
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
    `${card.period === 'all' ? 'All time' : `Last ${PERIOD_DAYS[card.period]} days`}: ${card.judged} pull requests judged, ${card.approves} APPROVE ` +
    `(${card.approvesRight} right, ${card.approvesWrong} wrong, ${card.approvesPending} pending), ${card.escalates} ESCALATE. ` +
    `Best streak so far: ${best} of ${card.threshold} correct APPROVEs in a row in one risk class; the bar is ${card.barMet ? 'met' : 'not met'}.`
  );
}

interface TopEntry {
  key: string;
  /** The whitespace before the key (back to the `{` or `,`). */
  lead: string;
  /** What sits between the key's closing quote and the value: the colon and its spacing. */
  colon: string;
  keyEnd: number;
  start: number;
  end: number;
}

/** The top-level entries of a JSON object as source spans (the text must already parse as an object). */
function topLevelEntries(raw: string): TopEntry[] {
  const entries: TopEntry[] = [];
  let depth = 0;
  let sepEnd = 0;
  let cur: Partial<TopEntry> | undefined;
  let lastEnd = 0;
  const close = (): void => {
    if (cur?.start !== undefined) entries.push({ ...(cur as TopEntry), end: lastEnd });
    cur = undefined;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (/\s/.test(c)) continue;
    if (depth === 1 && cur?.keyEnd !== undefined && cur.start === undefined && c !== ':') {
      cur.colon = raw.slice(cur.keyEnd, i);
      cur.start = i;
    }
    if (c === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      if (depth === 1 && cur === undefined) cur = { key: JSON.parse(raw.slice(i, j + 1)) as string, lead: raw.slice(sepEnd, i), keyEnd: j + 1 };
      i = j;
    } else if (c === '{' || c === '[') {
      depth += 1;
      if (depth === 1) sepEnd = i + 1;
    } else if (c === '}' || c === ']') {
      if (depth === 1) close();
      depth -= 1;
    } else if (c === ',' && depth === 1) {
      close();
      sepEnd = i + 1;
    }
    lastEnd = i + 1;
  }
  return entries;
}

/**
 * The policy's new content for a mode: only the top-level `enabled` / `act` values are rewritten in the
 * file's own text, so its formatting, key order and every other value stay byte for byte. A missing key is
 * inserted after `enabled` (else the last entry) in that entry's style.
 */
export function policyForMode(raw: string, mode: ApproverMode): string {
  const json = JSON.parse(raw) as unknown;
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('the policy is not a JSON object');
  const want = new Map([['enabled', mode !== 'off'], ['act', mode === 'act']]);
  const entries = topLevelEntries(raw);
  if (entries.length === 0) return `${JSON.stringify(Object.fromEntries(want), null, 2)}\n`;
  const edits = entries.filter((e) => want.has(e.key)).map((e) => ({ at: e.start, end: e.end, text: String(want.get(e.key)) }));
  const anchor = entries.find((e) => e.key === 'enabled') ?? entries.at(-1)!;
  const missing = [...want].filter(([k]) => !entries.some((e) => e.key === k));
  if (missing.length > 0) edits.push({ at: anchor.end, end: anchor.end, text: missing.map(([k, v]) => `,${anchor.lead}${JSON.stringify(k)}${anchor.colon}${v}`).join('') });
  return edits.sort((x, y) => y.at - x.at).reduce((out, e) => out.slice(0, e.at) + e.text + out.slice(e.end), raw);
}

/** Branch the mode PR is opened from. Fixed: a second request resets and reuses it (and its open PR). */
export const APPROVER_MODE_BRANCH = 'taskcell/approver-mode';

export interface OpenModePrInput {
  repoPath: string;
  mode: ApproverMode;
  card: ApproverScorecard;
  exec?: FactoryExec;
}

/** One mode change at a time per repository: they share a branch, a push and a PR. */
const serialise = keyedLock();

/**
 * Branch from `origin/<base>` in a temporary worktree, change `.taskcell/approver.json`, push the branch and
 * open a PR against the base — never a push to the base itself, and never a touch of the user's checkout
 * (index, working tree and HEAD stay as they are). One change at a time per repository.
 */
export function openApproverModePr(input: OpenModePrInput): Promise<ApproverModeChange> {
  return serialise(input.repoPath, () => applyModePr(input));
}

async function applyModePr(input: OpenModePrInput): Promise<ApproverModeChange> {
  const exec = input.exec ?? defaultExec;
  const { repoPath, mode } = input;
  const run = async (file: string, args: string[], cwd: string = repoPath): Promise<string> => (await exec(file, args, { cwd })).stdout.trim();
  const base = await approverBaseBranch(repoPath, exec);
  if (base === APPROVER_MODE_BRANCH) throw new BadRequestError('refusing to use the base branch as the approver-mode branch');

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

  const title = `chore: set the approver to ${mode} mode`;
  const tmp = await mkdtemp(join(tmpdir(), 'taskcell-approver-'));
  const tree = join(tmp, 'wt');
  try {
    await run('git', hostGitArgs(['worktree', 'add', '--detach', tree, `origin/${base}`]));
    try {
      await mkdir(join(tree, dir), { recursive: true });
      // `git show` output loses the final newline; the policy file keeps one.
      await writeFile(join(tree, file), next.endsWith('\n') ? next : `${next}${raw.includes('\r\n') ? '\r\n' : '\n'}`);
      await run('git', hostGitArgs(['add', file]), tree);
      // --no-verify: the temporary worktree has none of the repo's dependencies (node_modules, …), so the repo's
      // commit and push hooks cannot run there; the change is one generated policy file.
      await run('git', hostGitArgs(['commit', '--no-verify', '-m', title, '--', file]), tree);
      // --force: the fixed branch is reset to the base on every request, so an earlier request's commit is replaced.
      await run('git', hostGitArgs(['push', '--no-verify', '--force', 'origin', `HEAD:refs/heads/${APPROVER_MODE_BRANCH}`]), tree);
    } finally {
      await run('git', ['worktree', 'remove', '--force', tree]).catch(() => undefined);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await run('git', ['worktree', 'prune']).catch(() => undefined);
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
    await run('gh', ['pr', 'edit', existing, '--title', title, '--body', body]);
    return { branch: APPROVER_MODE_BRANCH, prUrl: existing, mode };
  }
  const prUrl = await run('gh', ['pr', 'create', '--title', title, '--body', body, '--base', base, '--head', APPROVER_MODE_BRANCH]);
  return { branch: APPROVER_MODE_BRANCH, prUrl, mode };
}
