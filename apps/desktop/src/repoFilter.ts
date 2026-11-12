/** The one repository filter Board, Runs and Needs you share: `'all'` or one repository's path. */
import { isTauri } from '@tauri-apps/api/core';
import { isHubMode } from './transport';

export const ALL_REPOS = 'all';
const KEY = 'vanguard.repoFilter';

export function loadRepoFilter(): string {
  try {
    return localStorage.getItem(KEY) || ALL_REPOS;
  } catch {
    return ALL_REPOS;
  }
}

export function saveRepoFilter(filter: string): void {
  try {
    localStorage.setItem(KEY, filter);
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
}

/** `list_*_all` are served by the hub only; outside it only the browser dev build's mock answers them. */
export function canUseAllRepos(): boolean {
  return isHubMode() || (import.meta.env.DEV && !isTauri());
}
