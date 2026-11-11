import { test, expect } from 'vitest';
import { errorMessage } from './errors';

test('uses the underlying message, never a raw dump', () => {
  expect(errorMessage(new Error('repo not found'))).toBe('repo not found');
  expect(errorMessage('plain string from the backend')).toBe('plain string from the backend');
  expect(errorMessage({ code: 500 })).toBe('Something went wrong.');
});

test('falls back to the default text when the message is blank', () => {
  // A failed fetch with a message-less Error must still read as a failure.
  expect(errorMessage(new Error(''))).toBe('Something went wrong.');
  expect(errorMessage(new Error('   '))).toBe('Something went wrong.');
  expect(errorMessage('')).toBe('Something went wrong.');
});
