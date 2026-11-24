// Runs whose agent stopped to ask the person (RunSummary.asked) as "Needs you" items, for hub-board cards and tracker
// cards alike, and the reply that answers one. Run records only: no model call, no tracker read to list them.
import { BadRequestError } from '../sidecar/sidecar.js';
import { githubSlug } from './command-kit.js';
import { commentGithubIssue, defaultGhRunner, type GhRunner } from '../tasks/github.js';
import { readAppConfig } from './app-config.js';
import { editHubTask, listHubTasks, MAX_BODY_LENGTH, type HubTaskOwner } from './hub-tasks.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import { newestRuns } from './card-view.js';
import { ensureLabel, listNeedsYou, type NeedsYouOptions } from './needs-you.js';
import { DEFAULT_GITHUB_AGENT_LABEL } from '../cli/args.js';
import type { NeedsYouItem } from '../wire.js';

const issueNumberOf = (key: string): number | undefined => {
  const m = /^gh-(\d+)$/.exec(key);
  return m ? Number(m[1]) : undefined;
};

/** Where a GitHub card's answer goes: the repository, its trigger label, and the `gh` runner. */
export interface GithubAnswerTarget {
  repoSlug: string;
  agentLabel?: string;
  gh?: GhRunner;
}

/**
 * Whether issue `number` still waits on an answer: open, and not carrying the trigger label an answer puts back (the
 * issue flow's own marker that it went back to the factory). Undefined when `gh` cannot tell.
 */
async function issueAwaitsAnswer(target: GithubAnswerTarget, number: number): Promise<boolean | undefined> {
  const label = target.agentLabel ?? DEFAULT_GITHUB_AGENT_LABEL;
  try {
    const out = await (target.gh ?? defaultGhRunner)(['issue', 'view', String(number), '--repo', target.repoSlug, '--json', 'state,labels']);
    const issue = JSON.parse(out) as { state?: string; labels?: { name?: string }[] };
    return issue.state === 'OPEN' && !(issue.labels ?? []).some((l) => l.name === label);
  } catch {
    return undefined;
  }
}

/**
 * Cards whose newest run's agent stopped to ask (kind `card`, ask `question`). A hub-board card counts until it is
 * answered, retried or accepted; a GitHub card only when that run opened no pull request (a PR waits
 * in the list on its own), the issue number is known, and, with a `github` target, the issue is open and not
 * already answered (it carries the trigger label again). A `gh` failure keeps the card listed. `id` is the card id.
 */
export async function askingCards(configDir: string, repoPath: string, github?: GithubAnswerTarget): Promise<NeedsYouItem[]> {
  const runs = newestRuns(await listRunSummaries(defaultRunsRoot(repoPath)).catch(() => []));
  const hub = (await readAppConfig(repoPath)).taskSource === 'hub';
  const tasks = hub ? new Map((await listHubTasks(configDir, repoPath)).map((t) => [t.id, t])) : undefined;
  const items: NeedsYouItem[] = [];
  for (const [key, run] of runs) {
    if (run.asked === undefined) continue;
    const task = tasks?.get(key);
    const number = tasks !== undefined ? Number(key.slice('hub-'.length)) : issueNumberOf(key);
    // A hub card waits while it is failed (an answer, a Retry or an Accept moves it on); hub-board.ts marks the same cards `asked`.
    if (tasks !== undefined ? task?.status !== 'failed' : run.prUrl !== undefined) continue;
    if (number === undefined || !Number.isInteger(number)) continue;
    if (tasks === undefined && github !== undefined && (await issueAwaitsAnswer(github, number)) === false) continue;
    items.push({
      id: key,
      kind: 'card',
      number,
      repoSlug: '',
      title: task?.title ?? `Issue #${number}`,
      url: '',
      reason: 'asked',
      ask: 'question',
      lastComment: { author: 'agent', body: run.asked },
    });
  }
  return items;
}

/** A GitHub card's answer target: the repository and its configured trigger label (app.json `label`). */
async function answerTarget(repoPath: string, repoSlug: string | undefined): Promise<GithubAnswerTarget | undefined> {
  if (repoSlug === undefined) return undefined;
  const { label } = await readAppConfig(repoPath);
  return { repoSlug, ...(label?.trim() ? { agentLabel: label } : {}) };
}

/** Everything of one repository that waits on the person: GitHub's needs-info issues and PRs, and the cards whose run stopped to ask. */
export async function repoNeedsYou(configDir: string, repoPath: string, opts: NeedsYouOptions = {}, gh?: GhRunner): Promise<NeedsYouItem[]> {
  const repoSlug = await githubSlug(repoPath);
  // Cards whose run stopped to ask come from run records; a repository without a GitHub remote has only those.
  return [...(repoSlug === undefined ? [] : await listNeedsYou(repoSlug, gh, opts)), ...(await askingCards(configDir, repoPath, await answerTarget(repoPath, repoSlug)))];
}

/** How long the board's read of what waits is kept per repository: a board polls every few seconds, the read is tracker calls. */
const BOARD_WAITING_TTL_MS = 15_000;
const boardWaitingCache = new Map<string, { at: number; items: Promise<NeedsYouItem[]> }>();

/**
 * What waits on the person in one repository, for the cards' views (`list_tasks`). Kept briefly and shared by
 * concurrent reads (failures too: an empty list); a reply, a merge or a card change forgets it (`forgetBoardWaiting`).
 * GitHub is read for every project with a GitHub remote, whatever its task source (hub board, Linear, GitLab), as `list_needs_you`.
 * `commentBudget` caps the comment fetches across every repository of one listing.
 */
export function boardWaiting(configDir: string, repoPath: string, opts: { commentBudget?: { remaining: number }; gh?: GhRunner } = {}): Promise<NeedsYouItem[]> {
  const held = boardWaitingCache.get(repoPath);
  if (held !== undefined && Date.now() - held.at < BOARD_WAITING_TTL_MS) return held.items;
  const items = repoNeedsYou(configDir, repoPath, opts.commentBudget !== undefined ? { commentBudget: opts.commentBudget } : {}, opts.gh).catch(() => []);
  boardWaitingCache.set(repoPath, { at: Date.now(), items });
  return items;
}

/** Drop a repository's kept read of what waits: something was answered, merged or moved on. */
export function forgetBoardWaiting(repoPath: string): void {
  boardWaitingCache.delete(repoPath);
}

/**
 * Answer a card that waits on a question: a hub-board card gets the answer appended to its body and goes back to To do
 * as `owner` (Retry); a GitHub issue gets the answer as a comment and the trigger label again. Refused when the card no
 * longer waits on a question.
 */
export async function answerCard(
  opts: { configDir: string; repoPath: string; id: string; body: string; owner: HubTaskOwner; repoSlug?: string; agentLabel?: string; gh?: GhRunner },
): Promise<void> {
  const { configDir, repoPath, id, body } = opts;
  const github = opts.repoSlug !== undefined ? { repoSlug: opts.repoSlug, ...(opts.agentLabel !== undefined ? { agentLabel: opts.agentLabel } : {}), ...(opts.gh !== undefined ? { gh: opts.gh } : {}) } : undefined;
  if (!(await askingCards(configDir, repoPath, github)).some((i) => i.id === id)) throw new BadRequestError(`${id} is not waiting for an answer`);
  if ((await readAppConfig(repoPath)).taskSource === 'hub') {
    await editHubTask(configDir, repoPath, id, (t) => {
      const next = `${t.body}\n\n## Answer\n${body}`;
      if (next.length > MAX_BODY_LENGTH) throw new BadRequestError(`the answer makes the task body longer than ${MAX_BODY_LENGTH} characters`);
      t.body = next;
      t.status = 'todo';
      delete t.reason;
      delete t.result;
      delete t.accepted;
      t.owner = opts.owner;
    });
    return;
  }
  const number = issueNumberOf(id);
  if (github === undefined || number === undefined) throw new BadRequestError(`${id}: this project has no GitHub remote`);
  // The list keeps a card `gh` could not check; an answer needs a positive read (the issue flow's issueIsWaiting rule).
  if ((await issueAwaitsAnswer(github, number)) !== true) throw new BadRequestError(`${id} is not waiting for an answer (closed, already answered, or GitHub could not be read)`);
  const label = opts.agentLabel ?? DEFAULT_GITHUB_AGENT_LABEL;
  const gh = opts.gh ?? defaultGhRunner;
  await commentGithubIssue(github.repoSlug, String(number), body, gh);
  await ensureLabel(github.repoSlug, label, gh);
  await gh(['issue', 'edit', String(number), '--repo', github.repoSlug, '--add-label', label]);
}
