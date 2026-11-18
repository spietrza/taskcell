import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import * as ipc from '../../ipc';
import { CardAnswer } from './CardAnswer';

afterEach(() => vi.restoreAllMocks());

const asked = { kind: 'card' as const, id: 'hub-4', number: 4, repoSlug: '', title: 'T', url: '', reason: 'question', lastComment: { author: 'agent', body: 'Which file?' } };

test('answers a waiting card in place and says what happens next', async () => {
  vi.spyOn(ipc, 'listNeedsYou').mockResolvedValue({ items: [asked] });
  const reply = vi.spyOn(ipc, 'replyNeedsYou').mockResolvedValue(undefined);
  render(<CardAnswer project="/r" taskId="hub-4" showQuestion />);
  expect(await screen.findByText('Which file?')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'reply to hub-4' }), { target: { value: 'config.json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  expect(await screen.findByRole('status')).toHaveTextContent(/Answer sent\. Your answer is added to the card/);
  expect(reply).toHaveBeenCalledWith('/r', 'hub-4', 'card', 'config.json');
});

test('nothing for a card that does not wait on an answer', async () => {
  const list = vi.spyOn(ipc, 'listNeedsYou').mockResolvedValue({ items: [] });
  const { container } = render(<CardAnswer project="/r" taskId="hub-3" />);
  await vi.waitFor(() => expect(list).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});
