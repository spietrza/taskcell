import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, initialTheme, saveTheme, THEME_KEY } from './theme';

beforeEach(() => {
  localStorage.clear();
});

describe('initialTheme', () => {
  it('honours a saved light theme', () => {
    localStorage.setItem(THEME_KEY, 'light');
    expect(initialTheme()).toBe('light');
  });

  it('honours a saved dark theme', () => {
    localStorage.setItem(THEME_KEY, 'dark');
    expect(initialTheme()).toBe('dark');
  });

  it('defaults to dark with nothing saved', () => {
    expect(initialTheme()).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('toggles the dark class on the root element', () => {
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('saveTheme', () => {
  it('applies the pick and survives it to the next launch', () => {
    saveTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(initialTheme()).toBe('light');
  });
});
