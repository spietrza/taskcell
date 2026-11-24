import { expect, test } from 'vitest';
import { askedOf, cardIdOf, issueNumber, repoInitials, runStateTone, startedByLabel, titleKey } from './runLabels';

test('"started by" names a person only: the shared hub identity and the local worker show nothing', () => {
  expect(startedByLabel('token')).toBeUndefined();
  expect(startedByLabel('local-worker')).toBeUndefined();
  expect(startedByLabel('alice@example.com')).toBe('alice@example.com');
  expect(startedByLabel(undefined)).toBeUndefined();
});

test('the issue number is the id\'s trailing number, for GitHub and GitLab runs only', () => {
  expect(issueNumber('gh-spietrza-taskcell-demo-form-3')).toBe(3);
  expect(issueNumber('gh-904')).toBe(904);
  expect(issueNumber('gl-12')).toBe(12);
  expect(issueNumber('DEMO-101')).toBeUndefined();
  expect(issueNumber('hub-4')).toBeUndefined();
});

test('a run and its board card meet on the same key', () => {
  expect(titleKey('/r', 'gh-owner-repo-7')).toBe(titleKey('/r', 'gh-7'));
  expect(titleKey('/r', 'gh-7')).not.toBe(titleKey('/s', 'gh-7'));
});

test('avatar initials come from the first two words of the repository name', () => {
  expect(repoInitials('taskcell-demo-form')).toBe('TD');
  expect(repoInitials('api')).toBe('AP');
  expect(repoInitials(undefined)).toBe('?');
});

test('the state word and its colour are one reading: a failed run is never green, a run waiting on the person is orange', () => {
  expect(runStateTone('failed')).toBe('destructive');
  expect(runStateTone('Waiting for your answer')).toBe('primary');
  // Its card is done: the ask is history, not the person's turn.
  expect(runStateTone('stopped to ask')).toBe('secondary');
  expect(runStateTone('merged')).toBe('success');
  // Orange (primary) is only the person's turn.
  expect(runStateTone('running')).toBe('secondary');
});

test('a run\'s card id is the one the Board shows', () => {
  expect(cardIdOf('gh-spietrza-taskcell-demo-form-27')).toBe('gh-27');
  expect(cardIdOf('hub-4')).toBe('hub-4');
});

test('repoInitials skips the leading words the shown names share', () => {
  expect(repoInitials('taskcell-demo-form')).toBe('TD');
  expect(repoInitials('taskcell-demo-form', ['taskcell-demo-form', 'taskcell-demo-local'])).toBe('FO');
  expect(repoInitials('taskcell-demo-local', ['taskcell-demo-form', 'taskcell-demo-local'])).toBe('LO');
  expect(repoInitials('acme-shop', ['acme-shop', 'billing'])).toBe('AS');
});

test('askedOf: a run whose card is done waits on no answer', () => {
  const detail = { stages: [{ record: { stage: 'implementer', exitReason: 'incomplete', finalText: 'Which file?' } }] };
  expect(askedOf(undefined, detail)).toBe('Which file?');
  expect(askedOf({ asked: 'Which file?' }, detail)).toBe('Which file?');
  expect(askedOf({ asked: 'Which file?', cardDone: true }, detail)).toBeUndefined();
});
