import { failureReason, NoRetryError } from '../core/errors.js';
import { hasLabel, NEEDS_REVISION_LABEL } from '../core/labels.js';
import { linkedIssueNumber } from '../runners/linked-issue.js';
import { checkDependencies, directDependencies, refText } from '../tasks/dependencies.js';
import type { GhRunner } from '../tasks/github.js';
import { hardExclusions, escapeForComment, OPEN_PRS_FIELDS } from './act.js';
import { collectDiffFacts } from './diff-facts.js';
import { isFactoryPr } from './facts.js';
import { writeMarker } from '../core/comment-ledger.js';
import { commentOnce } from './publish.js';
import type { ApproverFacts, ApproverPolicy, PrFacts } from './types.js';

/** Open PRs listed after a merge, PRs whose issue is read to find dependents, and dependents acted on. Only direct dependents: a dependent's own dependents are handled when it merges. */
const LIST_LIMIT = 100;
export const MAX_CANDIDATES = 30;
export const MAX_DEPENDENTS = 10;

interface IssueView {
  title?: string;
  body?: string | null;
}

/** `gh` limited to issues of `repo` and the policy's `dependencyRepos`: a slug from an issue body or a relation never points a read anywhere else. */
export function scopedGh(gh: GhRunner, repo: string, policy: Pick<ApproverPolicy, 'dependencyRepos'>): GhRunner {
  const allowed = [repo, ...(policy.dependencyRepos ?? [])].map((r) => r.toLowerCase());
  return async (args) => {
    const slug = /^repos\/([^/]+\/[^/]+)\//.exec(args[1] ?? '')?.[1];
    if (args[0] !== 'api' || slug === undefined || !allowed.includes(slug.toLowerCase())) throw new NoRetryError(`${slug ?? 'this call'} is outside the repos the approver reads dependencies from`);
    return gh(args);
  };
}

const readIssue = async (repo: string, number: number, gh: GhRunner): Promise<IssueView> => JSON.parse(await gh(['api', `repos/${repo}/issues/${number}`])) as IssueView;

/** `code` is the stable part of the reasons (they can carry free-form lookup text): it keys the comment, so it is posted once per head. */
export interface DependencyHold {
  reasons: string[];
  code?: string;
}

/**
 * Why a PR must not merge yet: its task still has unmerged dependencies (`Depends on` lines or native
 * blocked-by relations). No reasons when it has none (a repo without the relations API reads as none).
 * Fails closed like the watch gate: dependencies that cannot be looked up hold the PR.
 */
export async function dependencyHolds(repo: string, pr: { headRefName: string }, gh: GhRunner, policy: Pick<ApproverPolicy, 'dependencyRepos'> = {}): Promise<DependencyHold> {
  const number = linkedIssueNumber({ repoSlug: repo, body: '', headRefName: pr.headRefName });
  if (number === undefined) return { reasons: [] };
  const scoped = scopedGh(gh, repo, policy);
  try {
    const issue = await readIssue(repo, number, scoped);
    const task = { id: `${repo}#${number}`, title: issue.title ?? '', description: issue.body ?? '', labels: [], children: [], comments: [], ref: String(number) };
    const verdict = await checkDependencies(repo, task, scoped, undefined, policy.dependencyRepos);
    if (verdict.status === 'waiting' && verdict.blockers.length > 0) {
      return { reasons: [`its task #${number} depends on ${verdict.blockers.map(refText).join(', ')}, which ${verdict.blockers.length === 1 ? 'is' : 'are'} not merged yet (merge those first)`], code: 'dependency-unmerged' };
    }
    if (verdict.status === 'invalid') return { reasons: [`its task #${number} has an unmet dependency: ${verdict.reason}`], code: 'dependency-invalid' };
    if (verdict.status === 'error') return { reasons: [`the dependencies of its task #${number} could not be checked: ${verdict.reason}`], code: 'dependency-check-failed' };
    return { reasons: [] };
  } catch (error) {
    return { reasons: [`its task #${number} could not be read to check its dependencies: ${failureReason(error)}`], code: 'dependency-read-failed' };
  }
}

const REVISING_LABEL = 'taskcell:revising';
/** A revise round is running: `revising` (either spelling), which the run sets only after its image build. */
const inFlight = (labels: readonly string[]): boolean => hasLabel(labels.map((l) => l.toLowerCase()), REVISING_LABEL);

/** How long after `needs revision` is applied a revise round counts as pending (queued, or building its image before `revising`). */
export const PENDING_ROUND_MS = 60 * 60 * 1000;
const PENDING = 'a revise round is in flight or pending';

/**
 * A revise round is running, or may be about to: `revising`, or `needs revision` whose latest `labeled` event on the
 * PR's timeline is under PENDING_ROUND_MS old (or cannot be found). A timeline read failure throws: the caller writes nothing.
 */
async function roundPending(gh: GhRunner, repo: string, pr: number, labels: readonly string[]): Promise<boolean> {
  if (inFlight(labels)) return true;
  if (!hasLabel(labels, NEEDS_REVISION_LABEL)) return false;
  const pages = JSON.parse(await gh(['api', `repos/${repo}/issues/${pr}/timeline`, '--paginate', '--slurp'])) as { event?: string; label?: { name?: string }; created_at?: string }[][];
  const applied = pages
    .flat()
    .filter((e) => e.event === 'labeled' && hasLabel([e.label?.name ?? ''], NEEDS_REVISION_LABEL))
    .map((e) => Date.parse(e.created_at ?? ''))
    .filter((t) => Number.isFinite(t));
  return applied.length === 0 || Date.now() - Math.max(...applied) < PENDING_ROUND_MS;
}

interface OpenPr {
  number: number;
  headRefName: string;
  isCrossRepository?: boolean;
  author?: { login?: string } | null;
}

export interface RebasedDependent {
  pr: number;
  headSha: string;
  action: 'updated' | 'revise' | 'failed' | 'skipped';
  reason: string;
}

export interface RebaseDependentsInput {
  repo: string;
  repoPath: string;
  /** The PR that just merged. */
  merged: { headRefName: string; baseRefName: string };
  policy: ApproverPolicy;
  /** Act mode's allow-listed runner. */
  gh: GhRunner;
  /** A PR read that retries `UNKNOWN` (GitHub recomputes mergeability right after the base moves). */
  readPr: (number: number) => Promise<PrFacts>;
}

/**
 * After a PR merged in act mode, bring the open PRs of tasks that depend on its task up to date, so no
 * human has to: one that is behind the base gets the base merged in, one that conflicts gets one comment
 * per head and the revise label. Only PRs act mode would act on are touched: same-repo factory PRs by a
 * factory author that pass `hardExclusions` (all but the merge state); any other is reported as skipped
 * and nothing is written to it. Best effort per PR; a failure is reported, never thrown.
 */
export async function rebaseDependents(input: RebaseDependentsInput): Promise<RebasedDependent[]> {
  const { repo, policy, gh } = input;
  if (policy.enabled === false || policy.act !== true) return [];
  const merged = linkedIssueNumber({ repoSlug: repo, body: '', headRefName: input.merged.headRefName });
  if (merged === undefined) return [];
  const scoped = scopedGh(gh, repo, policy);
  const open = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', OPEN_PRS_FIELDS])) as OpenPr[];
  const candidates = open.flatMap((pr) => {
    const issue = linkedIssueNumber({ repoSlug: repo, body: '', headRefName: pr.headRefName });
    const factory = pr.isCrossRepository === false && (policy.factoryAuthors ?? []).includes(pr.author?.login ?? '');
    return factory && issue !== undefined && issue !== merged ? [{ pr: pr.number, issue }] : [];
  });
  const out: RebasedDependent[] = [];
  const limit = (what: string): void => void out.push({ pr: 0, headSha: '', action: 'skipped', reason: what });
  if (open.length >= LIST_LIMIT) limit(`only the first ${LIST_LIMIT} open PRs were looked at`);
  if (candidates.length > MAX_CANDIDATES) limit(`only the first ${MAX_CANDIDATES} of ${candidates.length} open factory PRs were checked for a dependency`);
  let handled = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    let headSha = '';
    try {
      const deps = await directDependencies(repo, candidate.issue, (await readIssue(repo, candidate.issue, scoped)).body ?? '', scoped, policy.dependencyRepos);
      if (!deps.some((d) => d.repo.toLowerCase() === repo.toLowerCase() && d.number === merged)) continue;
      if (++handled > MAX_DEPENDENTS) {
        limit(`more than ${MAX_DEPENDENTS} dependents; the rest were left as they are`);
        break;
      }
      const pr = await input.readPr(candidate.pr);
      headSha = pr.headSha;
      const done = (action: RebasedDependent['action'], reason: string): void => void out.push({ pr: candidate.pr, headSha, action, reason });
      const { reviews, ...prWithoutReviews } = pr;
      const diff = await collectDiffFacts({ repoPath: input.repoPath, prNumber: candidate.pr, baseRefName: pr.baseRefName, apiHeadSha: pr.headSha, reviewedSha: null, policy, requireRemoteBase: true });
      const facts: ApproverFacts = { pr: prWithoutReviews, isFactoryPr: isFactoryPr(pr, repo, policy), checks: [], review: { verdict: null, sha: null, author: null }, diff, ledger: {}, thisPrLines: diff.lines };
      const excluded = [
        ...(pr.state !== 'OPEN' ? [`the PR is ${pr.state}`] : []),
        ...(pr.baseRefName !== input.merged.baseRefName ? ['another base branch'] : []),
        ...(inFlight(pr.labels ?? []) ? ['a revise round is in flight'] : []),
        ...(facts.isFactoryPr ? [] : ['not a same-repo factory branch']),
        ...(diff.gitFactsFailed || diff.headMoved ? ['its diff could not be read'] : []),
        ...hardExclusions(facts, policy, reviews, { mergeState: false }),
      ];
      if (excluded.length > 0) {
        done('skipped', excluded.join('; '));
        continue;
      }
      // The labels were read before the diff fetch: read them again right before a write, so a round that started (or was queued) meanwhile is left alone.
      const revise = async (): Promise<void> => {
        // Once per head: the marker dedupes the comment, and a label already applied for this head is left alone.
        const fresh = (await input.readPr(candidate.pr)).labels ?? [];
        if (await roundPending(gh, repo, candidate.pr, fresh)) {
          done('skipped', PENDING);
          return;
        }
        const marker = writeMarker('approver-act', `${pr.headSha}:revise:dependent-conflict`);
        const why = `this PR conflicts with the base after its dependency #${merged} merged`;
        const posted = await commentOnce(gh, repo, candidate.pr, marker, `## Taskcell Approver (act mode)\n\nSending this PR to a revise round: ${escapeForComment(why)}.\n\n${marker}`, policy.approverLogins);
        const labelled = hasLabel(fresh, NEEDS_REVISION_LABEL);
        if (posted || !labelled) {
          // Re-applied, not left: only a new `labeled` event can start a revise round for this head.
          if (labelled) await gh(['pr', 'edit', String(candidate.pr), '--repo', repo, '--remove-label', NEEDS_REVISION_LABEL]);
          await gh(['pr', 'edit', String(candidate.pr), '--repo', repo, '--add-label', NEEDS_REVISION_LABEL]);
        }
        done('revise', `merge conflict with the base after dependency #${merged} merged`);
      };
      if (diff.mergeTreeHeadClean === false || pr.mergeStateStatus === 'DIRTY') {
        await revise();
      } else if (pr.mergeStateStatus === 'BEHIND' || (diff.mergeBase !== '' && diff.baseSha !== '' && diff.mergeBase !== diff.baseSha)) {
        // Without strict branch protection a stale PR reads CLEAN, so the merge-base is compared with the base tip too.
        if (await roundPending(gh, repo, candidate.pr, (await input.readPr(candidate.pr)).labels ?? [])) {
          done('skipped', PENDING);
          continue;
        }
        try {
          await gh(['pr', 'update-branch', String(candidate.pr), '--repo', repo]);
          done('updated', `dependency #${merged} merged; merged the base into the head`);
        } catch (error) {
          if ((await input.readPr(candidate.pr)).mergeStateStatus === 'DIRTY') await revise();
          else done('failed', `the branch update failed: ${failureReason(error)}`);
        }
      }
    } catch (error) {
      out.push({ pr: candidate.pr, headSha, action: 'failed', reason: failureReason(error) });
    }
  }
  return out;
}
