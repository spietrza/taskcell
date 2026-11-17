import type { Screen } from './MainNav';
import { SETTINGS_SECTIONS, type SettingsSection } from './features/settings/sections';

const PARAM = 'screen';
const SECTION = 'section';
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
  const query = params.toString();
  return `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`;
}
