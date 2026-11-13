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
function stubHub(initial: NeedsYouItem[], failReply = false, failMerge = false): { cmd: string; body: unknown }[] {
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
      if (cmd === 'merge_needs_you' && failMerge) {
        return new Response(JSON.stringify({ error: { kind: 'internal', message: 'has failing or pending required checks' } }), { status: 500 });
      }
      if (cmd === 'reply_needs_you' || cmd === 'merge_needs_you') items = items.filter((i) => i.id !== body?.id);
      const result = cmd === 'list_needs_you' ? { items } : cmd === 'list_needs_you_all' ? { items, failures: [] } : null;
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
  const { container } = render(<NeedsYou project="/repo" repos={[]} />);

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
  expect(await screen.findByText(/Nothing needs you/)).toBeInTheDocument();
  expect(calls.filter((c) => c.cmd === 'reply_needs_you').at(-1)?.body).toEqual(expect.objectContaining({ id: pr.id, kind: 'pr' }));
  expect(calls.filter((c) => c.cmd === 'list_needs_you')).toHaveLength(3);
});

test('a refused reply keeps the item and says why', async () => {
  const item = needsYouItems[0];
  stubHub([item], true);
  render(<NeedsYou project="/repo" repos={[]} />);
  await screen.findByText(item.title);
  reply(item, 'late answer');
  expect(await screen.findByRole('alert')).toHaveTextContent('Reply not sent');
  expect(screen.getByText(item.title)).toBeInTheDocument();
});

test('a known factory label reads as plain words; an unknown one shows as-is', async () => {
  stubHub([needsYouItems[1], { ...needsYouItems[1], id: 'acme/my-app#58', number: 58, reason: 'custom:label' }]);
  render(<NeedsYou project="/repo" repos={[]} />);
  expect(await screen.findByText('needs a human review')).toHaveAttribute('title', 'vanguard:needs-human-review');
  expect(screen.queryByText('vanguard:needs-human-review')).toBeNull();
  expect(screen.getByText('custom:label')).toBeInTheDocument();
});

test('under "All repositories" an item names its repository and a reply targets that repository', async () => {
  const item = { ...needsYouItems[0], repoPath: '/r/beta', repoName: 'beta' };
  const calls = stubHub([item]);
  render(<NeedsYou project="/r/alpha" allRepos repos={['/r/alpha', '/r/beta']} />);
  await screen.findByText(item.title);
  expect(screen.getByText('beta')).toBeInTheDocument();
  reply(item, 'go ahead');
  await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'reply_needs_you')).toBe(true));
  expect(calls.find((c) => c.cmd === 'reply_needs_you')?.body).toEqual(expect.objectContaining({ repoPath: '/r/beta' }));
  expect(calls.some((c) => c.cmd === 'list_needs_you_all')).toBe(true);
});

test('Merge names the PR base branch, merges, and the item leaves the list', async () => {
  const pr = { ...needsYouItems[1], baseRef: 'release/2' };
  const calls = stubHub([pr]);
  render(<NeedsYou project="/repo" repos={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Merge into release/2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm merge into release/2' }));
  expect(await screen.findByText(/Nothing needs you/)).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === 'merge_needs_you')?.body).toEqual({ repoPath: '/repo', id: pr.id });
});

test('a refused merge keeps the item and says why; an issue has no Merge button', async () => {
  const [issue, pr] = [needsYouItems[0], needsYouItems[1]];
  stubHub([issue, pr], false, true);
  render(<NeedsYou project="/repo" repos={[]} />);
  await screen.findByText(pr.title);
  expect(screen.getAllByRole('button').filter((b) => b.textContent?.startsWith('Merge'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /^Merge/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Confirm merge/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Not merged');
  expect(screen.getByText(pr.title)).toBeInTheDocument();
});

test('the Home section reports how many items wait, and says so in one line when none do', async () => {
  stubHub([needsYouItems[0], needsYouItems[1]]);
  const onCount = vi.fn();
  render(<NeedsYou project="/repo" repos={[]} onCount={onCount} />);
  expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
  await vi.waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
  expect(screen.getByRole('status')).toHaveTextContent('2 waiting');
});

test('under "All repositories" the selected team is sent to the hub, so a second team is not read as the first', async () => {
  const item = { ...needsYouItems[0], repoPath: '/r/beta', repoName: 'beta' };
  const calls = stubHub([item]);
  render(<NeedsYou project="/r/beta" allRepos repos={['/r/beta']} teamId="b" />);
  await screen.findByText(item.title);
  expect(calls.find((c) => c.cmd === 'list_needs_you_all')?.body).toEqual({ teamId: 'b' });
});

test('the empty state links to the Board', async () => {
  stubHub([]);
  const onOpenBoard = vi.fn();
  render(<NeedsYou project="/repo" repos={[]} onOpenBoard={onOpenBoard} />);
  await screen.findByText(/Nothing needs you/);
  fireEvent.click(screen.getByRole('button', { name: 'Board' }));
  expect(onOpenBoard).toHaveBeenCalled();
});
