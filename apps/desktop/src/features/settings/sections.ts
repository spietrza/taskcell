export type SettingsSection = 'general' | 'line' | 'runners' | 'lessons' | 'skills' | 'hub' | 'audit';

/** The sections in tab order: the in-screen tabs and the top bar's Settings menu share this list. */
export const SETTINGS_SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'line', label: 'Line' },
  { key: 'runners', label: 'Runners' },
  { key: 'lessons', label: 'Lessons' },
  { key: 'skills', label: 'Skills' },
  { key: 'hub', label: 'Team & hub' },
  { key: 'audit', label: 'Audit' },
];

/** Sections that hold hub-wide settings (the team, credentials, the setup guide, the audit log): no project picker there. */
export const HUB_WIDE_SECTIONS: readonly SettingsSection[] = ['hub', 'audit'];
