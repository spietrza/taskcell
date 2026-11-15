import { useAsync } from '../../hooks';
import { conflictStats } from '../../ipc';

/** Conflicts with the base, as `taskcell stats` prints them: totals plus the most-conflicted files. Hidden until a base merge was recorded. */
export function ConflictStats({ repoPath, refreshKey }: { repoPath: string; refreshKey?: number }) {
  // A failed read hides the line (data stays null); the error text is the shared hook's.
  const { data: stats } = useAsync(() => conflictStats(repoPath), [repoPath, refreshKey], { keepPrevious: true });
  if (stats === null || stats.total.merges === 0) return null;
  const { total, topFiles } = stats;
  return (
    <div className="px-4 py-2 text-xs text-muted-foreground" data-testid="conflict-stats">
      Base merges: {total.merges} · conflicts {total.conflicts} · auto-resolved {total.autoResolved} · left for a human {total.leftForHuman}
      {topFiles.length > 0 ? ` · top conflicted files: ${topFiles.map((f) => `${f.file} (${f.conflicts})`).join(', ')}` : ''}
    </div>
  );
}
