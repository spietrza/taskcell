// Runs whose agent stopped to ask the person (RunSummary.asked) as "Needs you" items, for hub-board cards and tracker
// cards alike, and the reply that answers one. Run records only: no model call, no tracker read to list them.
import { BadRequestError } from '../sidecar/sidecar.js';
import { taskRefKey } from '../tasks/board.js';
import { commentGithubIssue, defaultGhRunner, type GhRunner } from '../tasks/github.js';
import { ensureLabel } from './needs-you.js';
import { readAppConfig } from './app-config.js';
import { editHubTask, listHubTasks, MAX_BODY_LENGTH, type HubTaskOwner } from './hub-tasks.js';
import { defaultRunsRoot, listRunSummaries } from './runs.js';
import { DEFAULT_GITHUB_AGENT_LABEL } from '../cli/args.js';
import type { NeedsYouItem, RunSummary } from '../wire.js';

/** Each task's newest run, keyed by its board id (`hub-4`, `gh-27`). */
async function latestRuns(repoPath: string): Promise<Map<string, RunSummary>> {
  const out = new Map<string, RunSummary>();
  for (const r of await listRunSummaries(defaultRunsRoot(repoPath)).catch(() => [])) {
    const key = taskRefKey(r.taskId);
    if (!out.has(key) || out.get(key)!.timestamp < r.timestamp) out.set(key, r);
  }
  return out;
}

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
  const runs = await latestRuns(repoPath);
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
