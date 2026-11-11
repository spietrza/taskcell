import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { needsYouItems } from '../../dev/fixtures';
import { NeedsYou } from './NeedsYou';

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  delete window.__VANGUARD_HUB__;
});

test('lists waiting items, shows the factory question as text, and refreshes after a reply', async () => {
  window.__VANGUARD_HUB__ = true;
  const question = '<img src=x onerror=alert(1)> Which browser?';
  let items = [{ ...needsYouItems[0], lastComment: { author: 'vanguard[bot]', body: question } }, needsYouItems[1]];
  const calls: { cmd: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ cmd, body });
      if (cmd === 'reply_needs_you') items = items.slice(1);
      const result = cmd === 'list_needs_you' ? { items } : null;
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { container } = render(<NeedsYou project="/repo" />);

  // Untrusted text renders verbatim as a text node, never as markup.
  expect(await screen.findByText(question)).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText(needsYouItems[1].title)).toBeInTheDocument();

  const first = needsYouItems[0];
  fireEvent.change(screen.getByLabelText(`reply to ${first.id}`), { target: { value: 'Safari on macOS' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]);

  await vi.waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
  expect(calls.find((c) => c.cmd === 'reply_needs_you')?.body).toEqual(
    expect.objectContaining({ repoPath: '/repo', id: first.id, kind: 'issue', body: 'Safari on macOS' }),
  );
  expect(calls.filter((c) => c.cmd === 'list_needs_you')).toHaveLength(2);
});
