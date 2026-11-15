/** Helpers for the hub's all-repositories lists. */
/** Rows of the hub's all-repositories lists that belong to the selected team's repositories. */
export function inRepos<T extends { repoPath: string }>(rows: T[], repos: string[]): T[] {
  return rows.filter((r) => repos.includes(r.repoPath));
}
