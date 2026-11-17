// Home's activity feed: recent events across the caller's repositories, merged from data the hub already keeps.
import type { ActivityEvent, AuditEntry, RepoStamp, RunSummary } from '../wire.js';

export const ACTIVITY_LIMIT = 30;

const stamp = (repoPath: string, repos: ReadonlyMap<string, string>): RepoStamp => ({ repoPath, repoName: repos.get(repoPath) ?? repoPath });

/** The repository an audit target belongs to (`<repo>` or `<repo>:<item>`) among `repos`, and the item part. */
function ownerOf(target: string, repos: ReadonlyMap<string, string>): { repo: string; item?: string } | undefined {
  if (repos.has(target)) return { repo: target };
  for (const repo of repos.keys()) if (target.startsWith(`${repo}:`)) return { repo, item: target.slice(repo.length + 1) };
  return undefined;
}

/**
 * One audit line as a feed event: only successful actions the feed names, only in `repos`; settings saves carry key names only.
 * A run start's target is its run id (`run-12`, or `run-12 hub-4` from the hub board's scheduler): its repository is the subject's.
 */
export function fromAudit(e: AuditEntry, repos: ReadonlyMap<string, string>): ActivityEvent | undefined {
  if (e.outcome !== 'ok' || e.target === undefined) return undefined;
  if (e.action === 'run-start') {
    const repo = e.subject?.repo ?? e.target;
    if (!repos.has(repo)) return undefined;
    const task = repo === e.target ? undefined : e.target.split(' ')[1];
    return { time: e.time, ...stamp(repo, repos), login: e.login, kind: 'run-started', ...(task !== undefined ? { subject: task } : {}) };
  }
  const owner = ownerOf(e.target, repos);
  if (owner === undefined) return undefined;
  const base = { time: e.time, ...stamp(owner.repo, repos), login: e.login };
  if (owner.item === undefined) {
    if (e.action === 'task-create') return { ...base, kind: 'card-created' };
    // A bare-target save without keys is the local worker switch, not app.json.
    if (e.action === 'settings-change' && (e.detail ?? []).length > 0) return { ...base, kind: 'settings-changed', keys: [...(e.detail ?? [])] };
    return undefined;
  }
  const num = /#(\d+)$/.exec(owner.item);
  if (e.action === 'needs-merge' && num !== null) return { ...base, kind: 'pr-merged', subject: `#${num[1]}` };
  return undefined;
}

/**
 * Newest first, at most `limit`: finished runs from run records, and hub actions (run started, card created, pull
 * request merged, settings saved) from the audit log. `repos` maps each repository in scope to its display name.
 */
export function activityFeed(
  runs: readonly (RunSummary & RepoStamp)[],
  audit: readonly AuditEntry[],
  repos: ReadonlyMap<string, string>,
  limit: number = ACTIVITY_LIMIT,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const r of runs) {
    if (!repos.has(r.repoPath)) continue;
    // shortcut: a run summary carries its start time, not its end; the feed places the outcome there until records carry an end time.
    const failed = r.anyFailed && r.stoppedBy !== 'provider-limit';
    // A run whose agent stopped to ask waits on a person: not a failure in the feed.
    const kind = r.asked !== undefined ? 'run-asked' : failed ? 'run-failed' : 'run-finished';
    events.push({ time: r.timestamp, kind, ...stamp(r.repoPath, repos), subject: r.taskId, ...(r.startedBy !== undefined ? { login: r.startedBy } : {}) });
  }
  for (const e of audit) {
    const ev = fromAudit(e, repos);
    if (ev !== undefined) events.push(ev);
  }
  const at = (e: ActivityEvent): number => Date.parse(e.time) || 0;
  return events.sort((a, b) => at(b) - at(a)).slice(0, Math.max(0, limit));
}
