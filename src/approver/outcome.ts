/**
 * Fetches the scorecard's I/O inputs from GitHub: every factory PR's state (one `pr list` call per
 * repo, no per-PR round trip) and revert commits on the default branch (one commit scan per repo).
 * Pure aggregation lives in `scorecard.ts`; nothing here decides a verdict or an outcome itself beyond
 * shaping gh's JSON into the plain types that module reads.
 */
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { isFactoryBranch } from '../worktree/manager.js';
import { buildScorecard } from './scorecard.js';
import type { ApproverScorecardReport, BuildScorecardOptions, FactoryPrRef, RevertRecord, ShadowDecision } from './scorecard.js';

interface GhPrListItem {
  number: number;
  headRefName?: string;
  state?: string;
  mergedAt?: string | null;
  headRefOid?: string;
  mergeCommit?: { oid?: string } | null;
}

/** Every same-repo `chore/taskcell-*` (or pre-rename `chore/vanguard-*`) PR, any state, from one bulk list call. */
export async function fetchFactoryPrs(repoSlug: string, gh: GhRunner = defaultGhRunner): Promise<FactoryPrRef[]> {
  const out = await gh([
    'pr', 'list', '--repo', repoSlug, '--state', 'all', '--limit', '300',
    '--json', 'number,headRefName,state,mergedAt,headRefOid,mergeCommit',
  ]);
  const items = JSON.parse(out) as GhPrListItem[];
  return items
    .filter((pr) => isFactoryBranch(pr.headRefName))
    .map((pr) => ({
      repo: repoSlug,
      prNumber: pr.number,
      state: pr.state ?? '',
      mergedAt: pr.mergedAt ?? null,
      finalHeadSha: pr.headRefOid ?? null,
      mergeCommitSha: pr.mergeCommit?.oid ?? null,
    }));
}

interface GhCommitItem {
  commit: {
    message: string;
    committer?: { date?: string } | null;
    author?: { date?: string } | null;
  };
}

const REVERT_RE = /^Revert "/;
const REVERTED_SHA_RE = /This reverts commit ([0-9a-f]{7,40})/;

/** Revert commits on the repo's default branch since `since` (ISO date) — one scan covers every PR's window. */
export async function fetchReverts(repoSlug: string, since: string, gh: GhRunner = defaultGhRunner): Promise<RevertRecord[]> {
  const pages = JSON.parse(
    await gh(['api', '--paginate', '--slurp', `repos/${repoSlug}/commits?since=${since}&per_page=100`]),
  ) as GhCommitItem[][];
  const reverts: RevertRecord[] = [];
  for (const commit of pages.flat()) {
    const message = commit.commit.message;
    if (!REVERT_RE.test(message)) continue;
    const match = REVERTED_SHA_RE.exec(message);
    const targetSha = match?.[1];
    if (targetSha === undefined) continue;
    const revertedAt = commit.commit.committer?.date ?? commit.commit.author?.date;
    if (revertedAt === undefined) continue;
    reverts.push({ repo: repoSlug, targetSha, revertedAt });
  }
  return reverts;
}

function earliestMergedAt(prs: ReadonlyArray<FactoryPrRef>): string | undefined {
  const merged = prs.map((pr) => pr.mergedAt).filter((ts): ts is string => ts !== null);
  return merged.length === 0 ? undefined : merged.reduce((min, ts) => (ts < min ? ts : min));
}

/**
 * Fetch everything the scorecard needs for every repo named in `decisions` — one factory-PR list and
 * one revert scan per repo, both bounded by what already happened — and build the report. No gh call
 * at all for a repo with no merged factory PR yet.
 */
export async function collectApproverScorecard(
  decisions: ReadonlyArray<ShadowDecision>,
  options: BuildScorecardOptions & { gh?: GhRunner } = {},
): Promise<ApproverScorecardReport> {
  const gh = options.gh ?? defaultGhRunner;
  const repos = [...new Set(decisions.map((d) => d.repo))];
  const perRepo = await Promise.all(repos.map(async (repo) => {
    const prs = await fetchFactoryPrs(repo, gh);
    const since = earliestMergedAt(prs);
    const reverts = since !== undefined ? await fetchReverts(repo, since, gh) : [];
    return { prs, reverts };
  }));
  const factoryPrs: FactoryPrRef[] = perRepo.flatMap((r) => r.prs);
  const reverts: RevertRecord[] = perRepo.flatMap((r) => r.reverts);
  return buildScorecard(decisions, factoryPrs, reverts, options);
}
