export type SettingsSection = 'general' | 'line' | 'runners' | 'lessons' | 'skills' | 'audit';

/** The sections in tab order: the in-screen tabs and the top bar's Settings menu share this list. */
export const SETTINGS_SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'line', label: 'Line' },
  { key: 'runners', label: 'Runners' },
  { key: 'lessons', label: 'Lessons' },
  { key: 'skills', label: 'Skills' },
  { key: 'audit', label: 'Audit' },
];
