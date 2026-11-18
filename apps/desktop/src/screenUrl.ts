import type { Screen } from './MainNav';
import { SETTINGS_SECTIONS, type SettingsSection } from './features/settings/sections';

const PARAM = 'screen';
const SECTION = 'section';
const STATION = 'station';
const CARD = 'card';
const RUN = 'run';
const SCREENS: readonly Screen[] = ['home', 'runs', 'board', 'task', 'settings'];

/** Old entries (links, ⌘K) that now land elsewhere: the separate Needs you screen opens Home at that section. */
export function resolveScreen(s: Screen | 'needs'): { screen: Screen; section?: 'needs' } {
  return s === 'needs' ? { screen: 'home', section: 'needs' } : { screen: s };
}

/** The screen the address names (`?screen=runs`); Home when it names none. */
export function screenFromUrl(): Screen {
  const named = new URLSearchParams(window.location.search).get(PARAM);
  return SCREENS.find((s) => s === named) ?? 'home';
}

/** The Settings section the address names (`?screen=settings&section=line`); General when it names none. */
export function settingsSectionFromUrl(): SettingsSection {
  const named = new URLSearchParams(window.location.search).get(SECTION);
  return SETTINGS_SECTIONS.find((s) => s.key === named)?.key ?? 'general';
}

/** The current address naming `screen` (and, on Settings, a non-General `section`). Other query parameters (`demo=1`) and the fragment (a launch token) stay as they are. */
export function urlForScreen(screen: Screen, section: SettingsSection = 'general'): string {
  const params = new URLSearchParams(window.location.search);
  if (screen === 'home') params.delete(PARAM);
  else params.set(PARAM, screen);
  if (screen === 'settings' && section !== 'general') params.set(SECTION, section);
  else params.delete(SECTION);
  // A deep link's station or card belongs to the screen it opened; another screen drops it.
  if (screen !== 'settings' || section !== 'line') params.delete(STATION);
  if (screen !== 'board') params.delete(CARD);
  if (screen !== 'runs') params.delete(RUN);
  const query = params.toString();
  return `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`;
}

/** The Line station the address names (`…&section=line&station=card`), the card the Board opens (`?screen=board&card=gh-12`),
 *  or the run Runs opens (`?screen=runs&run=<taskId>@<timestamp>`, a live run by `<taskId>` alone). */
export const urlParam = (name: 'station' | 'card' | 'run'): string | null => new URLSearchParams(window.location.search).get(name);

/** Rewrites one deep-link parameter in place (no history step); `null` removes it. */
export function setUrlParam(name: 'station' | 'card' | 'run', value: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (value === null) params.delete(name);
  else params.set(name, value);
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`);
}
