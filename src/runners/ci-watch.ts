import { failureReason } from '../core/errors.js';
import { hasInFlightLabel, hasLabel, NEEDS_REVISION_LABEL, resolveAdds } from '../core/labels.js';
import { GITHUB_RATE_LIMITED_LABEL } from '../github-labels.js';
import { commentOnce } from '../approver/publish.js';
import { classifyAuthor, isBotLogin } from '../tasks/comment-trust.js';
import { isFactoryBranch } from '../worktree/manager.js';
import { readSettledPr } from '../approver/approve.js';
import { ciFailedMarker, conflictMarker, hasCiFailedMarker, hasConflictMarker } from './pr-feedback.js';
import { requiredChecks } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';

/** Labels meaning the PR is parked (in-flight labels are checked separately): a CI-failure comment would pile on. */
const SKIP_LABELS = [NEEDS_REVISION_LABEL, GITHUB_RATE_LIMITED_LABEL];
/** CI-failure comments per PR; the next failing head is left to a human. */
const MAX_CI_COMMENTS = 2;
/** Base-conflict comments per PR; the next conflicting head is left to a human. */
const MAX_CONFLICT_COMMENTS = 2;
const MAX_LOG_LINES = 80;
const MAX_LOG_CHARS = 8000;
const LIST_LIMIT = '100';

interface GhPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  labels?: { name?: string }[];
}

export interface CiWatchContext {
  repoSlug: string;
  dryRun: boolean;
  gh: GhRunner;
  log: (line: string) => void;
  /** Records a per-PR line (`ciFailed`, `conflicted`) or a failure (`failed`). */
  report: { ciFailed: string[]; conflicted: string[]; failed: string[] };
  /** Test seam: the wait between re-reads of an `UNKNOWN` mergeStateStatus. */
  sleep?: (ms: number) => Promise<void>;
}

/** Log text is agent-influenced: neutralise HTML comments and fence breaks, then keep the tail. */
export function ciLogTail(log: string): string {
  const escaped = log.replaceAll('<!--', '<\\!--').replaceAll('```', '``​`');
  const tail = escaped.split('\n').slice(-MAX_LOG_LINES).join('\n');
  const sliced = tail.slice(-MAX_LOG_CHARS);
  // A cut mid-line leaves a partial first line (possibly a bare fence opener): drop it.
  return sliced.length < tail.length && tail[tail.length - sliced.length - 1] !== '\n' ? sliced.slice(sliced.indexOf('\n') + 1) : sliced;
}

const runIdOf = (link: string | undefined): string | undefined => /\/actions\/runs\/(\d+)(?:\/|$)/.exec(link ?? '')?.[1];

async function failedLog(repoSlug: string, id: string, gh: GhRunner): Promise<string | undefined> {
  try {
    const out = await gh(['run', 'view', id, '--repo', repoSlug, '--log-failed']);
    return out.trim() === '' ? undefined : ciLogTail(out);
  } catch {
    return undefined;
  }
}

async function commentBody(repoSlug: string, sha: string, failed: { name: string; link?: string }[], gh: GhRunner): Promise<string> {
  const parts = [`## CI failed on ${sha.slice(0, 7)}`, '', 'Required checks failed on the current head:', ''];
  for (const check of failed) parts.push(check.link ? `- ${check.name}: ${check.link}` : `- ${check.name}`);
  const logs: string[] = [];
  const seen = new Set<string>();
  for (const check of failed) {
    const id = runIdOf(check.link);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const tail = await failedLog(repoSlug, id, gh);
    if (tail !== undefined) logs.push(`Failed log of ${check.name}:\n\n\`\`\`\n${tail}\n\`\`\``);
  }
  return [...parts, ...(logs.length > 0 ? ['', ...logs] : []), '', ciFailedMarker(sha)].join('\n');
}

/** Trusted comments already on the PR whose body satisfies `has` (a marker check). */
async function countComments(repoSlug: string, number: number, gh: GhRunner, has: (body: string) => boolean): Promise<number> {
  type C = { body?: string; author?: { login?: string } | null; authorAssociation?: string; viewerDidAuthor?: boolean };
  const view = JSON.parse(await gh(['pr', 'view', String(number), '--repo', repoSlug, '--json', 'comments'])) as { comments?: C[] };
  return (view.comments ?? []).filter((c) => has(c.body ?? '') && (c.viewerDidAuthor === true || classifyAuthor(c.author?.login ?? '', c.authorAssociation ?? '') !== 'untrusted')).length;
}

/** A DIRTY PR: one comment per conflicting head (it also covers red CI, which is looked at on the next head), then `needs revision`. */
async function reviseConflict(ctx: CiWatchContext, pr: GhPr, base: string): Promise<void> {
  const { repoSlug, dryRun, gh, log, report } = ctx;
  const id = `${repoSlug}#${pr.number}`;
  const say = (line: string): void => log(`resume-rate-limited ${id}: ci-watch ${line}`);
  if ((await countComments(repoSlug, pr.number, gh, hasConflictMarker)) >= MAX_CONFLICT_COMMENTS) {
    say(`skip -> already ${MAX_CONFLICT_COMMENTS} conflict comments, left to a human`);
    return;
  }
  const short = pr.headRefOid.slice(0, 7);
  const line = `${id}: conflicts with ${base} on ${short}`;
  if (dryRun) {
    log(`resume-rate-limited ${id}: would comment "${line}" and add ${NEEDS_REVISION_LABEL} (dry-run)`);
    report.conflicted.push(`${line} (dry-run)`);
    return;
  }
  const body = [`## Conflicts with ${base} on ${short}`, '', `This branch conflicts with \`${base}\`. Merge the base into it and resolve the conflicts.`, '', conflictMarker(pr.headRefOid)].join('\n');
  if (!(await commentOnce(gh, repoSlug, pr.number, conflictMarker(pr.headRefOid), body))) {
    say('skip -> already commented on this head');
    return;
  }
  const [label = NEEDS_REVISION_LABEL] = await resolveAdds([NEEDS_REVISION_LABEL], repoSlug, gh);
  await gh(['pr', 'edit', String(pr.number), '--repo', repoSlug, '--add-label', label]);
  log(`resume-rate-limited ${id}: ci-watch commented and added ${label}`);
  report.conflicted.push(line);
}

/**
 * Ask for a revision on open same-repo factory PRs that conflict with their base or whose required checks finished with a failure:
 * one comment per failing/conflicting head, then `needs revision`. A conflict goes first (the revise round is merge-only); CI is looked at again on the next head. Needs a user token (the reviser ignores bots).
 */
export async function watchCiFailures(ctx: CiWatchContext): Promise<void> {
  const { repoSlug, dryRun, gh, log, report, sleep } = ctx;
  const login = await gh(['api', 'user', '--jq', '.login']).then((out) => out.trim(), () => undefined);
  if (login === undefined || login === '' || isBotLogin(login)) {
    log('resume-rate-limited ci-watch: skipped -> ci-watch needs a user token whose comments the reviser trusts');
    return;
  }
  const prs = (JSON.parse(await gh(['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', LIST_LIMIT, '--json', 'number,headRefName,headRefOid,isDraft,isCrossRepository,labels'])) as GhPr[]).filter(
    (pr) => isFactoryBranch(pr.headRefName) && pr.isCrossRepository === false,
  );
  for (const pr of prs) {
    const id = `${repoSlug}#${pr.number}`;
    const say = (line: string): void => log(`resume-rate-limited ${id}: ci-watch ${line}`);
    const labels = (pr.labels ?? []).flatMap((l) => (l.name === undefined ? [] : [l.name]));
    const lower = labels.map((n) => n.toLowerCase());
    if (pr.isDraft || hasInFlightLabel(labels) || SKIP_LABELS.some((l) => hasLabel(lower, l))) continue;
    try {
      const facts = await readSettledPr(gh, repoSlug, pr.number, sleep).catch((e: unknown) => {
        say(`skip -> PR unreadable: ${failureReason(e)}`);
        return undefined;
      });
      if (facts === undefined) continue;
      if (facts.mergeStateStatus === 'UNKNOWN') {
        say('skip -> mergeStateStatus still UNKNOWN');
        continue;
      }
      if (facts.mergeStateStatus === 'DIRTY') {
        await reviseConflict(ctx, pr, facts.baseRefName !== '' ? facts.baseRefName : 'the base');
        continue;
      }
      const checks = await requiredChecks(repoSlug, String(pr.number), gh).catch((e: unknown) => {
        say(`skip -> checks unreadable: ${failureReason(e)}`);
        return undefined;
      });
      if (checks === undefined) continue;
      if (checks.length === 0 || checks.some((c) => c.bucket === 'pending') || !checks.some((c) => c.bucket === 'fail')) {
        say('skip -> no finished failing required checks');
        continue;
      }
      if ((await countComments(repoSlug, pr.number, gh, hasCiFailedMarker)) >= MAX_CI_COMMENTS) {
        say(`skip -> already ${MAX_CI_COMMENTS} CI-failure comments`);
        continue;
      }
      const line = `${id}: CI failed on ${pr.headRefOid.slice(0, 7)}`;
      if (dryRun) {
        log(`resume-rate-limited ${id}: would comment "${line}" and add ${NEEDS_REVISION_LABEL} (dry-run)`);
        report.ciFailed.push(`${line} (dry-run)`);
        continue;
      }
      const body = await commentBody(repoSlug, pr.headRefOid, checks.filter((c) => c.bucket === 'fail'), gh);
      if (!(await commentOnce(gh, repoSlug, pr.number, ciFailedMarker(pr.headRefOid), body))) {
        say('skip -> already commented on this head');
        continue;
      }
      const [label = NEEDS_REVISION_LABEL] = await resolveAdds([NEEDS_REVISION_LABEL], repoSlug, gh);
      await gh(['pr', 'edit', String(pr.number), '--repo', repoSlug, '--add-label', label]);
      log(`resume-rate-limited ${id}: ci-watch commented and added ${label}`);
      report.ciFailed.push(line);
    } catch (error) {
      log(`resume-rate-limited ${id}: ci-watch failed -> ${failureReason(error)}`);
      report.failed.push(id);
    }
  }
}
