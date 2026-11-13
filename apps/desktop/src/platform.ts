import type { RunLocationId, TaskSourceId } from './wire';

/** Per-project factory setup: where tasks come from and where work runs (docs/task-sources.md). */
export const TASK_SOURCES: { id: TaskSourceId; label: string }[] = [
  { id: 'github', label: 'GitHub Issues' },
  { id: 'github-project', label: 'GitHub Projects' },
  { id: 'gitlab', label: 'GitLab Issues' },
  { id: 'linear', label: 'Linear' },
  { id: 'hub', label: 'Hub board' },
];

const TRACKER = 'https://github.com/spietrza/taskcell/issues?q=is%3Aissue+';

/** `implemented` = Enable factory can set it up from the hub; the rest link to where it is tracked. */
export const RUN_LOCATIONS: { id: RunLocationId; label: string; implemented: boolean; trackingUrl?: string }[] = [
  { id: 'github-actions', label: 'GitHub Actions', implemented: true },
  { id: 'gitlab-ci', label: 'GitLab CI', implemented: false, trackingUrl: `${TRACKER}GitLab+CI+enable+factory` },
  { id: 'watch', label: 'Self-hosted (watch)', implemented: false, trackingUrl: `${TRACKER}self-hosted+watch+enable+factory` },
  { id: 'local', label: 'Local hub', implemented: false, trackingUrl: `${TRACKER}local+hub+enable+factory` },
];

export const DEFAULT_TASK_SOURCE: TaskSourceId = 'github';
export const DEFAULT_RUN_LOCATION: RunLocationId = 'github-actions';

const taskSourceIds: readonly string[] = TASK_SOURCES.map((s) => s.id);
const runLocationIds: readonly string[] = RUN_LOCATIONS.map((r) => r.id);

/** Stored values come from a hand-editable file: anything unknown falls back to the default. */
export function taskSourceOf(v: string | null | undefined): TaskSourceId {
  return v != null && taskSourceIds.includes(v) ? (v as TaskSourceId) : DEFAULT_TASK_SOURCE;
}
export function runLocationOf(v: string | null | undefined): RunLocationId {
  return v != null && runLocationIds.includes(v) ? (v as RunLocationId) : DEFAULT_RUN_LOCATION;
}

export const taskSourceLabel = (v: string | null | undefined): string => TASK_SOURCES.find((s) => s.id === taskSourceOf(v))!.label;
export const runLocationLabel = (v: string | null | undefined): string => RUN_LOCATIONS.find((r) => r.id === runLocationOf(v))!.label;

/** The `source` (board/transport/CLI `--source`) a task source maps to; none for sources the board does not read. */
export function legacySource(v: TaskSourceId): string | undefined {
  return v === 'github' || v === 'gitlab' || v === 'linear' ? v : undefined;
}

/**
 * Why a task source + run location pair does not work as it stands, or null when it does. These are
 * explained in the UI rather than blocked: the settings still save.
 */
export function combinationNote(source: string | null | undefined, location: string | null | undefined): string | null {
  const s = taskSourceOf(source);
  const l = runLocationOf(location);
  if (s === 'linear' && l === 'gitlab-ci') {
    return 'Linear only supplies tasks: the MR is opened on the code host, so the repo\'s origin must be on GitLab (set GITLAB_HOST for a self-hosted one).';
  }
  if (s === 'linear' && l === 'github-actions') {
    return 'Linear only supplies tasks: the PR is opened on GitHub, so the repo\'s origin must be on github.com.';
  }
  if (s === 'linear') {
    return 'Linear only supplies tasks: you still need a code host (GitHub or GitLab) for the PR/MR.';
  }
  if (s === 'gitlab' && l === 'github-actions') {
    return 'GitLab Issues with GitHub Actions: Actions cannot read GitLab issues, so use GitLab CI or run `watch` yourself.';
  }
  if (s === 'github' && l === 'gitlab-ci') {
    return 'GitHub Issues with GitLab CI: GitLab CI cannot be triggered by GitHub issues, so use GitHub Actions or run `watch` yourself.';
  }
  if (s === 'github-project' && l !== 'watch' && l !== 'local') {
    return 'GitHub Projects is read by `taskcell run --project` / `watch`, not by CI events: run it self-hosted (watch) or locally.';
  }
  if (s === 'hub' && (l === 'github-actions' || l === 'gitlab-ci')) {
    return 'The hub board lives in the hub, which CI cannot reach: use self-hosted (watch) or the local hub to run its tasks.';
  }
  return null;
}
