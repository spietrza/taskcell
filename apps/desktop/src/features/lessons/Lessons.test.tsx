import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { RepoLesson } from '../../wire';
import { AppliedLessons, Lessons } from './Lessons';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

const lesson = (id: string, paths: string[], over: Partial<RepoLesson> = {}): RepoLesson => ({
  id, rule: `rule ${id}`, why: `why ${id}`, evidence: `https://github.com/o/r/pull/${id.length}`, paths, prNumber: 7, timestamp: '2026-07-01T10:00:00Z', ...over,
});

function stubHub(initial: RepoLesson[], opts: { branchFound?: boolean; fail?: boolean; failDismiss?: boolean } = {}): { cmd: string; body: unknown }[] {
  let lessons = initial;
  const calls: { cmd: string; body: unknown }[] = [];
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const cmd = url.slice(url.indexOf('/rpc/') + 5);
    const body = (init?.body ? JSON.parse(String(init.body)) : undefined) as { id?: string } | undefined;
    calls.push({ cmd, body });
    const err = (message: string): Response => new Response(JSON.stringify({ error: { kind: 'internal', message } }), { status: 500 });
    if (opts.fail) return err('boom');
    if (cmd === 'dismiss_lesson' && opts.failDismiss) return err('forbidden');
    if (cmd === 'dismiss_lesson') lessons = lessons.filter((l) => l.id !== body?.id);
    const result = cmd === 'list_lessons' ? { lessons, branchFound: opts.branchFound ?? true } : cmd === 'fetch_spec' ? { spec: 'spec text' } : null;
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

test('lists each lesson with rule, why, scope, stage and a working evidence link', async () => {
  stubHub([lesson('a', ['src/core/**'], { stage: 'review' })]);
  render(<Lessons project="/repo" />);
  expect(await screen.findByText('rule a')).toBeInTheDocument();
  expect(screen.getByText('Why: why a')).toBeInTheDocument();
  expect(screen.getByText('src/core/**')).toBeInTheDocument();
  expect(screen.getByText('review')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: /Evidence: PR #7/ });
  expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/1');
});

test('a non-http evidence address is not rendered as a link', async () => {
  stubHub([lesson('a', [], { evidence: 'javascript:alert(1)' })]);
  render(<Lessons project="/repo" />);
  await screen.findByText('rule a');
  expect(screen.queryByRole('link')).toBeNull();
});

test('the path filter narrows the list', async () => {
  stubHub([lesson('a', ['src/core/**']), lesson('bb', ['docs/**'])]);
  render(<Lessons project="/repo" />);
  await screen.findByText('rule a');
  fireEvent.change(screen.getByLabelText('Filter by path'), { target: { value: 'DOCS' } });
  expect(screen.queryByText('rule a')).toBeNull();
  expect(screen.getByText('rule bb')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter by path'), { target: { value: 'nothing' } });
  expect(screen.getByText(/No lesson applies to a path containing/)).toBeInTheDocument();
});

test('Dismiss asks for confirmation, then removes the lesson', async () => {
  const calls = stubHub([lesson('a', [])]);
  render(<Lessons project="/repo" />);
  await screen.findByText('rule a');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(calls.some((c) => c.cmd === 'dismiss_lesson')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }));
  await vi.waitFor(() => expect(screen.queryByText('rule a')).toBeNull());
  expect(calls.find((c) => c.cmd === 'dismiss_lesson')?.body).toEqual({ repoPath: '/repo', id: 'a' });
  expect(screen.getByText(/No lessons yet/)).toBeInTheDocument();
});

test('a refused dismissal shows why and keeps the lesson', async () => {
  stubHub([lesson('a', [])], { failDismiss: true });
  render(<Lessons project="/repo" />);
  await screen.findByText('rule a');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Not dismissed');
  expect(screen.getByText('rule a')).toBeInTheDocument();
});

test('no metrics branch explains itself instead of erroring; a failure says so in plain words', async () => {
  stubHub([], { branchFound: false });
  const { unmount } = render(<Lessons project="/repo" />);
  expect(await screen.findByText(/has no metrics branch/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  unmount();
  stubHub([], { fail: true });
  render(<Lessons project="/repo" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the lessons');
});

test('AppliedLessons asks for the lessons matching the task spec and has no Dismiss', async () => {
  const calls = stubHub([lesson('a', [])]);
  render(<AppliedLessons project="/repo" taskId="gh-5" />);
  expect(await screen.findByText('rule a')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  expect(calls.find((c) => c.cmd === 'list_lessons')?.body).toEqual({ repoPath: '/repo', taskText: 'spec text' });
});

test('says where lessons are stored and what writes them, empty or not; nothing to filter disables the filter', async () => {
  stubHub([], { branchFound: false });
  const empty = render(<Lessons project="/repo" />);
  const note = await screen.findByText(/has no metrics branch/);
  expect(note).toHaveTextContent('lessons.jsonl on the taskcell-metrics branch, written by taskcell lessons record (the Lessons workflow) when a factory PR closes');
  expect(screen.getByRole('link', { name: 'How lessons work' })).toHaveAttribute('href', expect.stringContaining('docs/autonomous-loop.md'));
  expect(screen.getByLabelText('Filter by path')).toBeDisabled();
  empty.unmount();
  stubHub([lesson('a', [])]);
  render(<Lessons project="/repo" />);
  expect(await screen.findByText('rule a')).toBeInTheDocument();
  expect(screen.getByText(/taskcell-metrics/)).toBeInTheDocument();
  expect(screen.getByLabelText('Filter by path')).toBeEnabled();
});
