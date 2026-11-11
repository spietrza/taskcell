import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { needsYouItems } from '../../dev/fixtures';
import type { NeedsYouItem } from '../../wire';
import { NeedsYou } from './NeedsYou';

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  delete window.__VANGUARD_HUB__;
});

/** A hub stub: a reply hands the item back to the factory, so it leaves the next list (issue or PR). */
function stubHub(initial: NeedsYouItem[], failReply = false): { cmd: string; body: unknown }[] {
  let items = initial;
  const calls: { cmd: string; body: unknown }[] = [];
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const cmd = url.slice(url.indexOf('/rpc/') + 5);
      const body = (init?.body ? JSON.parse(String(init.body)) : undefined) as { id?: string } | undefined;
      calls.push({ cmd, body });
      if (cmd === 'reply_needs_you' && failReply) {
        return new Response(JSON.stringify({ error: { kind: 'internal', message: 'not waiting' } }), { status: 500 });
      }
      if (cmd === 'reply_needs_you') items = items.filter((i) => i.id !== body?.id);
      const result = cmd === 'list_needs_you' ? { items } : null;
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

function reply(item: NeedsYouItem, text: string): void {
  fireEvent.change(screen.getByLabelText(`reply to ${item.id}`), { target: { value: text } });
  const box = screen.getByLabelText(`reply to ${item.id}`).closest('div')!.parentElement!;
  fireEvent.click(Array.from(box.querySelectorAll('button')).find((b) => b.textContent === 'Reply')!);
}

test('shows the factory question as text; a reply to an issue and to a PR each refresh the list', async () => {
  const question = '<img src=x onerror=alert(1)> Which browser?';
  const [issue, pr] = [{ ...needsYouItems[0], lastComment: { author: 'vanguard[bot]', body: question } }, needsYouItems[1]];
  const calls = stubHub([issue, pr]);
  const { container } = render(<NeedsYou project="/repo" />);

  // Untrusted text renders verbatim as a text node, never as markup.
  expect(await screen.findByText(question)).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('2 waiting');

  reply(issue, 'Safari on macOS');
  await vi.waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
  expect(calls.find((c) => c.cmd === 'reply_needs_you')?.body).toEqual(
    expect.objectContaining({ repoPath: '/repo', id: issue.id, kind: 'issue', body: 'Safari on macOS' }),
  );

  reply(pr, 'Keep the scope as is');
  expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
  expect(calls.filter((c) => c.cmd === 'reply_needs_you').at(-1)?.body).toEqual(expect.objectContaining({ id: pr.id, kind: 'pr' }));
  expect(calls.filter((c) => c.cmd === 'list_needs_you')).toHaveLength(3);
});

test('a refused reply keeps the item and says why', async () => {
  const item = needsYouItems[0];
  stubHub([item], true);
  render(<NeedsYou project="/repo" />);
  await screen.findByText(item.title);
  reply(item, 'late answer');
  expect(await screen.findByRole('alert')).toHaveTextContent('Reply not sent');
  expect(screen.getByText(item.title)).toBeInTheDocument();
});
