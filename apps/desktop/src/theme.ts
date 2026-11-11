import { type Theme } from '@/ui';

/** Where the operator's pick is stored. The inline script in index.html reads the same key. */
export const THEME_KEY = 'vg-theme';

/**
 * Dark is the Taskcell look (taskcell.dev); light only when the operator picked it. Keep in step
 * with the inline script in index.html, which applies the same rule before first paint.
 */
export function initialTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/** The operator picked a theme: apply it and remember it for the next launch. */
export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  localStorage.setItem(THEME_KEY, theme);
}
