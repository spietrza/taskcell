import { Button } from '@/ui';
import { errorClause } from './errors';
import { NO_TASK_SOURCE_MESSAGE, type RepoReadFailure } from './wire';

/** Names the repositories an all-repositories list could not read; the rest are still listed.
 * `total` is how many repositories were asked: with no others, nothing claims they are listed. */
export function RepoFailures({ failures, total }: { failures: RepoReadFailure[]; total?: number }) {
  if (failures.length === 0) return null;
  return (
    <div role="alert" className="mb-2 shrink-0 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      Could not read {failures.map((f) => `${f.repoName} (${errorClause(f.error)})`).join(', ')}.
      {(total === undefined || total > failures.length) && ' The other repositories are listed.'}
    </div>
  );
}

/** True for the board's "no task source chosen" answer: a setup step, shown as a hint and not as an error. */
export const isNoTaskSource = (error: string): boolean => error.includes(NO_TASK_SOURCE_MESSAGE);

/** A project whose task source is not chosen yet: what to do, and the way there when Settings is this project's. */
export function TaskSourceHint({ repoNames, onOpenSettings }: { repoNames: string[]; onOpenSettings?: (() => void) | undefined }) {
  return (
    <div role="note" className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <span>
        {repoNames.length > 0 ? `${repoNames.join(', ')} has no task source yet.` : 'This project has no task source yet.'} Choose one
        (GitHub Issues, GitLab Issues or Linear) in Settings and its cards show up here.
      </span>
      {onOpenSettings && (
        <Button variant="outlined" className="ml-auto" onClick={onOpenSettings}>
          Open Settings
        </Button>
      )}
    </div>
  );
}

/** The repository a card / run row / item belongs to; shown only under "All repositories". */
export function RepoLabel({ name }: { name: string | undefined }) {
  if (name === undefined) return null;
  return <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{name}</span>;
}
