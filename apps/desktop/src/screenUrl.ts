import type { Screen } from './Rail';

const PARAM = 'screen';
const SCREENS: readonly Screen[] = ['home', 'runs', 'board', 'task', 'settings'];

/** The screen the address names (`?screen=runs`); Home when it names none. */
export function screenFromUrl(): Screen {
  const named = new URLSearchParams(window.location.search).get(PARAM);
  return SCREENS.find((s) => s === named) ?? 'home';
}

/** The current address naming `screen`. Other query parameters (`demo=1`) and the fragment (a launch token) stay as they are. */
export function urlForScreen(screen: Screen): string {
  const params = new URLSearchParams(window.location.search);
  if (screen === 'home') params.delete(PARAM);
  else params.set(PARAM, screen);
  const query = params.toString();
  return `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`;
}
