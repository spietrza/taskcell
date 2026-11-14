import { failureReason } from '../core/errors.js';
import { REVISE_LABEL } from './act.js';
import { hasLabel } from '../core/labels.js';
import { linkedIssueNumber } from '../runners/linked-issue.js';
import { checkDependencies, directDependencies, parseBodyDependencies, refText } from '../tasks/dependencies.js';
import type { GhRunner } from '../tasks/github.js';

interface IssueView {
  title?: string;
  body?: string | null;
  labels?: { name?: string }[];
}

const readIssue = async (repo: string, number: number, gh: GhRunner): Promise<IssueView> => JSON.parse(await gh(['api', `repos/${repo}/issues/${number}`])) as IssueView;

/**
 * Why a PR must not merge yet: its task still has unmerged dependencies (`Depends on` lines or native
 * blocked-by relations). Empty when it has none, or when they cannot be looked up and the issue declares
 * none in its body (a repo without the relations API behaves as before). `gh` must be able to read
 * issues; the approver's own runner cannot, so the caller passes the raw one.
 */
export async function dependencyHolds(repo: string, pr: { headRefName: string }, gh: GhRunner): Promise<string[]> {
  const number = linkedIssueNumber({ repoSlug: repo, body: '', headRefName: pr.headRefName });
  if (number === undefined) return [];
  try {
    const issue = await readIssue(repo, number, gh);
    const task = { id: `${repo}#${number}`, title: issue.title ?? '', description: issue.body ?? '', labels: [], children: [], comments: [], ref: String(number) };
    const verdict = await checkDependencies(repo, task, gh);
    if (verdict.status === 'waiting' && verdict.blockers.length > 0) return [`its task #${number} depends on ${verdict.blockers.map(refText).join(', ')}, which ${verdict.blockers.length === 1 ? 'is' : 'are'} not merged yet (merge those first)`];
    if (verdict.status === 'invalid') return [`its task #${number} has an unmet dependency: ${verdict.reason}`];
    if (verdict.status === 'error' && parseBodyDependencies(repo, issue.body ?? '').length > 0) return [`its task #${number} declares dependencies that could not be checked: ${verdict.reason}`];
    return [];
  } catch (error) {
    return [`its task #${number} could not be read to check its dependencies: ${failureReason(error)}`];
  }
}

interface OpenPr {
  number: number;
  headRefName: string;
  mergeStateStatus?: string;
  labels?: { name?: string }[];
}

export interface RebasedDependent {
  pr: number;
  action: 'updated' | 'revise' | 'failed';
}

/**
 * After `mergedPr` merged, bring the open PRs of tasks that depend on its task up to date, so no human has
 * to: a PR that is behind gets the base merged in (`update`), one with a conflict goes through a revise
 * round (`reviseOne` labels it and says why). Best effort per PR; a failure is reported, never thrown.
 */
export async function rebaseDependents(
  repo: string,
  mergedPr: { headRefName: string },
  gh: GhRunner,
  actions: { update: (pr: number) => Promise<void>; reviseOne: (pr: number, reason: string) => Promise<void> },
): Promise<RebasedDependent[]> {
  const merged = linkedIssueNumber({ repoSlug: repo, body: '', headRefName: mergedPr.headRefName });
  if (merged === undefined) return [];
  const open = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,mergeStateStatus,labels'])) as OpenPr[];
  const out: RebasedDependent[] = [];
  for (const pr of open) {
    const number = linkedIssueNumber({ repoSlug: repo, body: '', headRefName: pr.headRefName });
    if (number === undefined || number === merged) continue;
    try {
      const deps = await directDependencies(repo, number, (await readIssue(repo, number, gh)).body ?? '', gh);
      if (!deps.some((d) => d.repo.toLowerCase() === repo.toLowerCase() && d.number === merged)) continue;
      if (hasLabel((pr.labels ?? []).flatMap((l) => l.name ?? []), REVISE_LABEL)) continue;
      if (pr.mergeStateStatus === 'DIRTY') {
        await actions.reviseOne(pr.number, `merge conflict with the base after its dependency #${merged} merged`);
        out.push({ pr: pr.number, action: 'revise' });
      } else if (pr.mergeStateStatus === 'BEHIND' || pr.mergeStateStatus === 'UNKNOWN') {
        await actions.update(pr.number);
        out.push({ pr: pr.number, action: 'updated' });
      }
    } catch {
      out.push({ pr: pr.number, action: 'failed' });
    }
  }
  return out;
}
