import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { stubHubCalls } from '../../testHub';
import { CardAnswer } from './CardAnswer';

afterEach(() => vi.restoreAllMocks());

const asked = { kind: 'card' as const, id: 'hub-4', number: 4, repoSlug: '', title: 'T', url: '', reason: 'question', lastComment: { author: 'agent', body: 'Which file?' } };

test('answers a waiting card in place and says what happens next', async () => {
  const hubCall = stubHubCalls({ list_needs_you: async () => ({ items: [asked] }), reply_needs_you: async () => undefined });
  render(<CardAnswer project="/r" taskId="hub-4" showQuestion />);
  expect(await screen.findByText('Which file?')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'reply to hub-4' }), { target: { value: 'config.json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  expect(await screen.findByRole('status')).toHaveTextContent(/Answer sent\. Your answer is added to the card/);
  expect(hubCall).toHaveBeenCalledWith('reply_needs_you', { repoPath: '/r', id: 'hub-4', kind: 'card', body: 'config.json' });
});

test('nothing for a card that does not wait on an answer', async () => {
  const hubCall = stubHubCalls({ list_needs_you: async () => ({ items: [] }) });
  const { container } = render(<CardAnswer project="/r" taskId="hub-3" />);
  await vi.waitFor(() => expect(hubCall).toHaveBeenCalledWith('list_needs_you', { repoPath: '/r' }));
  expect(container).toBeEmptyDOMElement();
});
