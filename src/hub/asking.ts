// Runs whose agent stopped to ask the person (RunSummary.asked) as "Needs you" items, for hub-board cards and tracker
// cards alike, and the reply that answers one. Run records only: no model call, no tracker read to list them.
import { BadRequestError } from '../sidecar/sidecar.js';
import { githubSlug } from './command-kit.js';
import { commentGithubIssue, defaultGhRunner, type GhRunner } from '../tasks/github.js';
import { readAppConfig } from './app-config.js';
import { editHubTask, listHubTasks, MAX_BODY_LENGTH, type HubTaskOwner } from './hub-tasks.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import { newestRuns } from './card-view.js';
import { ensureLabel, listNeedsYou, withLastComments, type CommentMemo } from './needs-you.js';
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
async function answerTarget(repoPath: string, repoSlug: string | undefined, gh?: GhRunner): Promise<GithubAnswerTarget | undefined> {
  if (repoSlug === undefined) return undefined;
  const { label } = await readAppConfig(repoPath);
  return { repoSlug, ...(label?.trim() ? { agentLabel: label } : {}), ...(gh !== undefined ? { gh } : {}) };
}

/** How long a repository's read of GitHub's waiting items is kept: the board polls every 5-20 s, the read is tracker calls. */
const NEEDS_YOU_TTL_MS = 60_000;

/** What waits in one repository. `unchecked`: GitHub could not be read; its items are the last good ones (none yet: none). */
export interface NeedsYouRead {
  items: NeedsYouItem[];
  unchecked?: true;
}

interface GithubRead {
  at: number;
  /** GitHub's needs-info issues and PRs. */
  items: Promise<NeedsYouItem[]>;
  /** Last comments fetched for Home's lists, kept per item for the life of this read. */
  comments: CommentMemo;
  /** The read failed: kept (as a failure) for FAILED_TTL_MS only. */
  failed?: true;
  /** The `gh issue view` answers of this read's cards, shared until it expires. */
  views: Map<string, Promise<string>>;
}
/** How long a failed read is kept: long enough that a rate-limited poll does not retry every few seconds. */
const FAILED_TTL_MS = 15_000;
const githubCache = new Map<string, GithubRead>();
const lastGood = new Map<string, NeedsYouItem[]>();

/**
 * What waits on the person in one repository, shared by the board (`list_tasks`) and Home (`list_needs_you`).
 * GitHub's side (for every project with a GitHub remote, whatever its task source) is kept for NEEDS_YOU_TTL_MS and shared
 * by concurrent reads; the board gets no per-item comments, Home's lists fetch them once per item (`withLastComments`); a reply, a merge or a card change forgets it
 * (`forgetBoardWaiting`). The cards whose run stopped to ask come from run records and are read on each call. A failed
 * GitHub read is kept for FAILED_TTL_MS: it returns the last good items flagged `unchecked`.
 */
export async function cachedNeedsYou(
  configDir: string,
  repoPath: string,
  gh?: GhRunner,
  /** Home's lists pass the comment-fetch budget (shared across repositories); the board passes none and gets no comments. */
  commentBudget?: { remaining: number },
): Promise<NeedsYouRead> {
  const repoSlug = await githubSlug(repoPath);
  const held = githubCache.get(repoPath);
  const entry: GithubRead = held !== undefined && Date.now() - held.at < (held.failed ? FAILED_TTL_MS : NEEDS_YOU_TTL_MS)
    ? held
    : {
      at: Date.now(),
      items: repoSlug === undefined ? Promise.resolve([]) : listNeedsYou(repoSlug, gh, { commentBudget: { remaining: 0 } }),
      comments: new Map(),
      views: new Map(),
    };
  githubCache.set(repoPath, entry);
  let unchecked = false;
  const github = await entry.items.then(
    (items) => {
      if (githubCache.get(repoPath) === entry) lastGood.set(repoPath, items);
      return items;
    },
    () => {
      unchecked = true;
      entry.failed = true;
      return lastGood.get(repoPath) ?? [];
    },
  );
  const run = gh ?? defaultGhRunner;
  const memo: GhRunner = (args) => {
    const key = args.join('\0');
    const kept = entry.views.get(key);
    if (kept !== undefined) return kept;
    const read = run(args);
    entry.views.set(key, read);
    read.catch(() => entry.views.delete(key));
    return read;
  };
  const target = await answerTarget(repoPath, repoSlug, memo);
  const waiting = commentBudget !== undefined && repoSlug !== undefined ? await withLastComments(repoSlug, github, run, entry.comments, commentBudget) : github;
  return { items: [...waiting, ...(await askingCards(configDir, repoPath, target))], ...(unchecked ? { unchecked: true as const } : {}) };
}

/** Drop a repository's kept read of what waits: something was answered, merged or moved on. */
export function forgetBoardWaiting(repoPath: string): void {
  githubCache.delete(repoPath);
  lastGood.delete(repoPath);
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
