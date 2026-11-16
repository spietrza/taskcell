import { expect, test } from 'vitest';
import { issueNumber, repoInitials, startedByLabel, titleKey } from './runLabels';

test('"started by" never says token: the shared hub identity and the local worker get plain names', () => {
  expect(startedByLabel('token')).toBe('Hub');
  expect(startedByLabel('local-worker')).toBe('Local worker');
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
