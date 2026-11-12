// The hub's "start the factory on this issue" call: applies a trigger label to an issue of a
// registered project, as the hub's own `gh` identity (the same credential as the board and the
// needs-you reply). GitHub only; GitLab and Linear say so. See docs/cli.md.
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { checkDependencies, refText } from '../tasks/dependencies.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_SPEC_LABEL } from '../cli/args.js';
import {
  GITHUB_CLAIMED_LABEL,
  GITHUB_RATE_LIMITED_LABEL,
  GITHUB_RESEARCHING_LABEL,
  GITHUB_REVIEW_LABEL,
  GITHUB_SPEC_CLAIMED_LABEL,
  GITHUB_WAITING_LABEL,
} from '../github-labels.js';
import { isTriggerLabel } from '../tasks/board.js';
import { assertRepoSlug, ensureLabel } from './needs-you.js';
import type { StartTaskResult } from '../wire.js';

/** Labels meaning the factory already took the issue (as resume-rate-limited's `startedLabels`). */
const STARTED_LABELS: readonly string[] = [GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL, GITHUB_RESEARCHING_LABEL];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The labels a hub caller may apply: the factory defaults plus the project's configured trigger. */
export function triggerLabelsFor(configured: string | undefined): string[] {
  const extra = configured?.trim() ? [configured.trim()] : [];
  return [...new Set([DEFAULT_GITHUB_AGENT_LABEL, DEFAULT_GITHUB_SPEC_LABEL, ...extra])];
}

interface GhIssueApi {
  state: string;
  labels: { name: string }[];
  body?: string | null;
  title?: string;
  pull_request?: unknown;
}

/**
 * Apply `label` to issue `number` of `repoSlug`. Every refusal happens before any GitHub write.
 * `repoSlug` comes from the allowlisted repo, never from the client.
 */
export async function startGithubTask(
  repoSlug: string,
  number: number,
  label: string,
  triggerLabels: readonly string[],
  gh: GhRunner = defaultGhRunner,
): Promise<StartTaskResult> {
  assertRepoSlug(repoSlug);
  if (!Number.isInteger(number) || number <= 0) throw new BadRequestError(`number must be a positive integer, got ${String(number)}`);
  if (!triggerLabels.some((t) => t === label)) {
    throw new BadRequestError(`"${label}" is not a trigger label of this project (${triggerLabels.join(', ')})`);
  }
  const n = String(number);
  const issue = JSON.parse(await gh(['api', `repos/${repoSlug}/issues/${n}`])) as GhIssueApi;
  if (issue.pull_request != null) throw new BadRequestError(`#${n} is a pull request, not an issue.`);
  if (issue.state !== 'open') throw new BadRequestError(`#${n} is closed; the factory only starts open issues.`);

  const names = issue.labels.map((l) => l.name);
  const started = names.filter((x) => STARTED_LABELS.includes(x));
  const present = names.filter((x) => triggerLabels.some((t) => same(t, x)) || isTriggerLabel(x));
  const parked = names.some((x) => x === GITHUB_WAITING_LABEL || x === GITHUB_RATE_LIMITED_LABEL);
  const blocking = [...started, ...(parked ? [] : present)];
  if (blocking.length > 0) throw new BadRequestError(`#${n} is already running or queued (${blocking.join(', ')}); nothing was changed.`);

  // GitHub sends no `labeled` event for a label the issue already has, so drop a trigger label
  // still on a parked issue first (any of them: two triggers would start two stages).
  const edit = (flag: string, l: string): Promise<string> => gh(['issue', 'edit', n, '--repo', repoSlug, flag, l]);
  for (const stale of present) await edit('--remove-label', stale);
  await ensureLabel(repoSlug, label, gh);
  await edit('--add-label', label);

  let waitingOn: string[] = [];
  if (names.includes(GITHUB_WAITING_LABEL)) {
    const verdict = await checkDependencies(repoSlug, { id: `${repoSlug}#${n}`, ref: n, title: issue.title ?? '', description: issue.body ?? '', labels: names, children: [], comments: [] }, gh);
    if (verdict.status === 'waiting') waitingOn = verdict.blockers.map(refText);
  }
  return { status: present.length > 0 ? 'retried' : 'labelled', label, waitingOn };
}
