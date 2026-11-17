import { expect, test } from 'vitest';
import { loginLabel } from './AuditLog';

test('the audit login column says who "token" and "unknown" are', () => {
  expect(loginLabel('token')).toBe('hub token (owner)');
  expect(loginLabel('unknown')).toBe('unknown (not signed in)');
  expect(loginLabel('ann')).toBe('ann');
});
