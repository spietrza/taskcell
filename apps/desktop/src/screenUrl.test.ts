import { afterEach, expect, test } from 'vitest';
import { resolveScreen, screenFromUrl, setUrlParam, settingsSectionFromUrl, urlForScreen, urlParam } from './screenUrl';

const at = (url: string): void => window.history.replaceState(null, '', url);
afterEach(() => at('/'));

test('the old Needs you entry opens Home at that section', () => {
  expect(resolveScreen('needs')).toEqual({ screen: 'home', section: 'needs' });
  expect(resolveScreen('board')).toEqual({ screen: 'board' });
});

test('the screen and the Settings section round-trip through the address', () => {
  at(urlForScreen('settings', 'line'));
  expect(window.location.search).toBe('?screen=settings&section=line');
  expect(screenFromUrl()).toBe('settings');
  expect(settingsSectionFromUrl()).toBe('line');
});

test('General and unknown sections leave no section parameter', () => {
  expect(urlForScreen('settings', 'general')).toBe('/?screen=settings');
  at('/?screen=settings&section=nope');
  expect(settingsSectionFromUrl()).toBe('general');
});

test('leaving Settings drops the section; other parameters and the fragment stay', () => {
  at('/?demo=1&screen=settings&section=audit#token=abc');
  expect(urlForScreen('board')).toBe('/?demo=1&screen=board#token=abc');
  expect(urlForScreen('home')).toBe('/?demo=1#token=abc');
});

test('a station deep link stays on Line, a card deep link on the Board; elsewhere they drop', () => {
  at('/?screen=settings&section=line&station=card#token=abc');
  expect(urlParam('station')).toBe('card');
  expect(urlForScreen('settings', 'line')).toBe('/?screen=settings&section=line&station=card#token=abc');
  expect(urlForScreen('settings', 'general')).toBe('/?screen=settings#token=abc');
  at('/?screen=board&card=gh-12');
  expect(urlForScreen('board')).toBe('/?screen=board&card=gh-12');
  expect(urlForScreen('runs')).toBe('/?screen=runs');
  setUrlParam('card', null);
  expect(window.location.search).toBe('?screen=board');
  setUrlParam('card', 'hub-3');
  expect(urlParam('card')).toBe('hub-3');
});
