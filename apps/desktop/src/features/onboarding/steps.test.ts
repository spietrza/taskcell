import { beforeEach, describe, expect, test } from 'vitest';
import type { SetupStatus } from '../../wire';
import { EMPTY_STORED, STARTER_TASK, loadOnboarding, saveOnboarding, showOnFirstRun, stepState, withSkipped } from './steps';

const status = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  tools: [
    { id: 'gh', state: 'ready' },
    { id: 'glab', state: 'missing' },
    { id: 'linear', state: 'needs-login' },
  ],
  models: { claude: false, codex: false },
  ...over,
});

describe('stepState', () => {
  test('git host is done when gh or glab is ready, else needs action', () => {
    expect(stepState('git-host', { status: status(), projectCount: 0, skipped: [], model: 'claude' })).toBe('done');
    const none = status({ tools: [{ id: 'gh', state: 'needs-login' }, { id: 'glab', state: 'missing' }] });
    expect(stepState('git-host', { status: none, projectCount: 0, skipped: [], model: 'claude' })).toBe('needs-action');
    expect(stepState('git-host', { status: null, projectCount: 0, skipped: [], model: 'claude' })).toBe('needs-action');
  });

  test('Linear alone does not complete the git host step', () => {
    const s = status({ tools: [{ id: 'linear', state: 'ready' }] });
    expect(stepState('git-host', { status: s, projectCount: 0, skipped: [], model: 'claude' })).toBe('needs-action');
  });

  test('model is done when either credential is found, whichever option is selected', () => {
    expect(stepState('model', { status: status(), projectCount: 0, skipped: [], model: 'claude' })).toBe('needs-action');
    // Only the selected provider's credential counts: Codex found does not finish a Claude choice.
    const codexOnly = status({ models: { claude: false, codex: true } });
    expect(stepState('model', { status: codexOnly, projectCount: 0, skipped: [], model: 'claude' })).toBe('done');
    expect(stepState('model', { status: codexOnly, projectCount: 0, skipped: [], model: 'codex' })).toBe('done');
  });

  test('repo is done once a project exists', () => {
    expect(stepState('repo', { status: null, projectCount: 0, skipped: [], model: 'claude' })).toBe('needs-action');
    expect(stepState('repo', { status: null, projectCount: 1, skipped: [], model: 'claude' })).toBe('done');
  });

  test('a skip hides needs-action but never overrides done', () => {
    expect(stepState('model', { status: status(), projectCount: 0, skipped: ['model'], model: 'claude' })).toBe('skipped');
    expect(stepState('repo', { status: null, projectCount: 2, skipped: ['repo'], model: 'claude' })).toBe('done');
  });

});

describe('first run and persistence', () => {
  beforeEach(() => localStorage.clear());

  test('shows only with no projects and onboarding not completed', () => {
    expect(showOnFirstRun(EMPTY_STORED, 0)).toBe(true);
    expect(showOnFirstRun(EMPTY_STORED, 1)).toBe(false);
    expect(showOnFirstRun({ completed: true, skipped: [], model: 'claude' }, 0)).toBe(false);
  });

  test('withSkipped adds and removes a step once', () => {
    const a = withSkipped(withSkipped(EMPTY_STORED, 'model', true), 'model', true);
    expect(a.skipped).toEqual(['model']);
    expect(withSkipped(a, 'model', false).skipped).toEqual([]);
  });

  test('save/load round-trips and ignores junk', () => {
    saveOnboarding({ completed: true, skipped: ['repo'], model: 'claude' });
    expect(loadOnboarding()).toEqual({ completed: true, skipped: ['repo'], model: 'claude' });
    localStorage.setItem('vanguard.onboarding', '{"completed":1,"skipped":["x","model"]}');
    expect(loadOnboarding()).toEqual({ completed: false, skipped: ['model'], model: 'claude' });
    localStorage.setItem('vanguard.onboarding', 'not json');
    expect(loadOnboarding()).toEqual(EMPTY_STORED);
  });

  test('the starter task carries acceptance criteria', () => {
    expect(STARTER_TASK.body).toContain('## Acceptance criteria');
    expect(STARTER_TASK.body).toContain('- [ ]');
  });
});

describe('model choice', () => {
  beforeEach(() => localStorage.clear());
  test('is remembered across a reload and defaults to claude', () => {
    saveOnboarding({ ...EMPTY_STORED, model: 'codex' });
    expect(loadOnboarding().model).toBe('codex');
    localStorage.setItem('vanguard.onboarding', '{"model":"x"}');
    expect(loadOnboarding().model).toBe('claude');
  });
});
