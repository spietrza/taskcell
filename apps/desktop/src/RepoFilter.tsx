import { ALL_REPOS } from './repoFilter';
import type { Project, RepoReadFailure } from './wire';

/** The repository filter Board, Runs and Needs you share: "All repositories" first, then one per repository. */
export function RepoFilter({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label="Repository"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-60 rounded border border-border bg-background px-2 py-0.5 text-sm font-medium outline-none hover:bg-muted"
    >
      <option value={ALL_REPOS}>All repositories</option>
      {projects.map((p) => (
        <option key={p.path} value={p.path}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

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
