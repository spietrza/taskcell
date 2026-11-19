// The hub's design tokens (apps/desktop/src/tokens.css), light and dark. Dark is the default.
export interface Theme {
  background: string;
  foreground: string;
  card: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  input: string;
  caption: string;
  destructive: string;
}

export const dark: Theme = {
  background: '#0d1013',
  foreground: '#e8ecef',
  card: '#141a1f',
  primary: '#f99a2c',
  primaryForeground: '#14100a',
  muted: '#1b2228',
  mutedForeground: '#a3adb6',
  border: '#202c2f',
  input: '#3a5054',
  caption: '#79a9ad',
  destructive: '#ff6a5c',
};

export const light: Theme = {
  background: '#f7f8f9',
  foreground: '#0d1013',
  card: '#ffffff',
  primary: '#c8730f',
  primaryForeground: '#14100a',
  muted: '#e8ecef',
  mutedForeground: '#56616b',
  border: '#d3dadd',
  input: '#b9c3c7',
  caption: '#3f6b70',
  destructive: '#c4271a',
};

export const themeFor = (scheme: string | null | undefined): Theme => (scheme === 'light' ? light : dark);
