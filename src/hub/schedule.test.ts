import { describe, expect, test } from 'vitest';
import { planSchedule, formatWait } from './schedule.js';
import { parseStart, type HubTask } from './hub-tasks.js';

const t = (id: string, over: Partial<HubTask> = {}): HubTask => ({ id, title: id, body: '', status: 'todo', blockedBy: [], ...over });
const now = new Date('2026-11-14T10:00:00Z');
const plan = (tasks: HubTask[], limit = 3) => planSchedule(tasks, { now, limit, timeZone: 'Europe/Berlin' });

describe('planSchedule', () => {
  test('three independent tasks start together; the limit holds the rest back', () => {
    expect(plan([t('a'), t('b'), t('c')]).start).toEqual(['a', 'b', 'c']);
    const p = plan([t('a'), t('b'), t('c')], 2);
    expect(p.start).toEqual(['a', 'b']);
    expect(p.byId.get('c')).toMatchObject({ state: 'waits-slot' });
  });

  test('running tasks use slots', () => {
    expect(plan([t('r', { status: 'running' }), t('a'), t('b')], 2).start).toEqual(['a']);
  });

  test('a task starts only after its dependency is done', () => {
    const open = plan([t('a'), t('b', { blockedBy: ['a'] })]);
    expect(open.start).toEqual(['a']);
    expect(open.byId.get('b')).toMatchObject({ state: 'blocked', blockedBy: ['a'], label: 'blocked by a' });
    expect(plan([t('a', { status: 'done' }), t('b', { blockedBy: ['a'] })]).start).toEqual(['b']);
    expect(plan([t('a', { status: 'failed' }), t('b', { blockedBy: ['a'] })]).start).toEqual([]);
  });

  test('a future start date holds an unblocked task even with a free slot; a past one does not', () => {
    const p = plan([t('a', { startDate: '2026-11-18T00:00:00+01:00' }), t('b', { startDate: '2026-11-14T09:00:00Z' }), t('c')]);
    expect(p.start).toEqual(['b', 'c']);
    expect(p.byId.get('a')).toMatchObject({ state: 'waits-date', label: 'waits until Wed 18.11 (Europe/Berlin)' });
  });

  test('a date-only start is midnight in the hub time zone', () => {
    expect(parseStart('2026-11-18', 'Europe/Berlin')?.toISOString()).toBe('2026-11-17T23:00:00.000Z');
    expect(parseStart('2026-07-01', 'America/New_York')?.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(parseStart('2026-11-18', 'UTC')?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(parseStart('18.11.2026')).toBeUndefined();
    expect(parseStart('2026-02-31')).toBeUndefined();
  });

  test('a missing reference is shown with its reason and the task never starts', () => {
    const p = plan([t('a', { blockedBy: ['ghost'] })]);
    expect(p.start).toEqual([]);
    expect(p.byId.get('a')).toMatchObject({ state: 'invalid', reason: 'blocked by ghost, which is not a task of this project' });
  });

  test('a cycle (and a self-reference) is invalid for its members, naming the loop', () => {
    const p = plan([t('a', { blockedBy: ['b'] }), t('b', { blockedBy: ['a'] }), t('s', { blockedBy: ['s'] }), t('c', { blockedBy: ['a'] }), t('free')]);
    expect(p.start).toEqual(['free']);
    expect(p.byId.get('a')).toMatchObject({ state: 'invalid', reason: 'dependency cycle: a → b → a' });
    expect(p.byId.get('b')?.state).toBe('invalid');
    expect(p.byId.get('s')).toMatchObject({ state: 'invalid', reason: 'dependency cycle: s → s' });
    expect(p.byId.get('c')?.state).toBe('blocked'); // waits on a task that can never finish — visible, not started
  });

  test('an invalid start date is shown, not skipped', () => {
    expect(plan([t('a', { startDate: 'soon' })]).byId.get('a')).toMatchObject({ state: 'invalid' });
  });

  test('tasks without dependencies or dates all start within the limit, in order', () => {
    expect(plan([t('a'), t('b')], 1).start).toEqual(['a']);
  });
});

test('formatWait names the weekday, day and zone', () => {
  expect(formatWait(new Date('2026-11-18T12:00:00Z'), 'Europe/Berlin')).toBe('Wed 18.11 (Europe/Berlin)');
});
