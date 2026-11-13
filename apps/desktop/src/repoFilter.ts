/** Helpers for the hub's all-repositories lists. */
import { isTauri } from '@tauri-apps/api/core';
import { isHubMode } from './transport';

/** `list_*_all` are served by the hub only; outside it only the browser dev build's mock answers them. */
export function canUseAllRepos(): boolean {
  return isHubMode() || (import.meta.env.DEV && !isTauri());
}

/** Rows of the hub's all-repositories lists that belong to the selected team's repositories. */
export function inRepos<T extends { repoPath: string }>(rows: T[], repos: string[]): T[] {
  return rows.filter((r) => repos.includes(r.repoPath));
}
