import { test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Credentials } from './Credentials';

vi.mock('../../ipc', () => ({
  getCredentials: vi.fn(async () => ({ enabled: false, reason: 'VANGUARD_HUB_SECRET is not set', providers: [{ provider: 'claude', set: false, env: true }] })),
  setCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

test('shows the store as disabled with the reason', async () => {
  render(<Credentials />);
  await waitFor(() => expect(screen.getByText(/Credential store disabled/)).toBeInTheDocument());
  expect(screen.getByText('from environment')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});
