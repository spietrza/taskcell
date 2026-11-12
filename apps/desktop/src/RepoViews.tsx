import type { RepoReadFailure } from './wire';

/** Names the repositories an all-repositories list could not read; the rest are still listed. */
export function RepoFailures({ failures }: { failures: RepoReadFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <div role="alert" className="mb-2 shrink-0 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      Could not read {failures.map((f) => `${f.repoName} (${f.error})`).join(', ')}. The other repositories are listed.
    </div>
  );
}

/** The repository a card / run row / item belongs to; shown only under "All repositories". */
export function RepoLabel({ name }: { name: string }) {
  return <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{name}</span>;
}
