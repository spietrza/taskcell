import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { RepoSkill } from '../../wire';
import { Skills } from './Skills';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

const fixture: RepoSkill[] = [
  { name: 'caveman', source: 'https://github.com/o/caveman', commit: 'abc1234', status: 'pinned', check: 'outdated', usage: { runs: 4, passRate: 0.75, avgRepairRounds: 0.5, avgCostUsd: 1.2 } },
  { name: 'simplify', source: 'https://github.com/o/simplify', commit: 'def5678', status: 'pinned', check: 'current' },
];

function stubHub(fail: Record<string, string> = {}): { cmd: string; body: unknown }[] {
  const calls: { cmd: string; body: unknown }[] = [];
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const cmd = url.slice(url.indexOf('/rpc/') + 5);
    calls.push({ cmd, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const message = fail[cmd];
    if (message !== undefined) return new Response(JSON.stringify({ error: { kind: 'bad-request', message } }), { status: 400 });
    const result = cmd === 'list_repo_skills' ? { skills: fixture } : { prUrl: 'https://github.com/o/r/pull/9' };
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

test('renders the skills table from fixture data', async () => {
  stubHub();
  render(<Skills project="/repo" />);
  expect(await screen.findByText('caveman')).toBeInTheDocument();
  expect(screen.getByText('simplify')).toBeInTheDocument();
  expect(screen.getByText('abc1234')).toBeInTheDocument();
  expect(screen.getByText('outdated')).toBeInTheDocument();
  expect(screen.getByText('75%')).toBeInTheDocument();
  expect(screen.getByText('1.2000')).toBeInTheDocument();
});

test('the outdated filter hides current skills', async () => {
  stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('simplify');
  fireEvent.click(screen.getByLabelText('Outdated only'));
  expect(screen.queryByText('simplify')).toBeNull();
  expect(screen.getByText('caveman')).toBeInTheDocument();
});

test('Open update PR calls update_skill_pr for that skill and shows the PR link', async () => {
  const calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.click(screen.getAllByRole('button', { name: 'Open update PR' })[0]!);
  expect(await screen.findByRole('link', { name: /Pull request opened/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/9');
  expect(calls.find((c) => c.cmd === 'update_skill_pr')?.body).toEqual({ repoPath: '/repo', name: 'caveman' });
});

test('Add skill opens a PR; a failed add shows the reason', async () => {
  const calls = stubHub({ add_skill_pr: 'Cannot resolve HEAD of https://x/y.' });
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://x/y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByText(/Cannot resolve HEAD of https:\/\/x\/y/)).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === 'add_skill_pr')?.body).toEqual({ repoPath: '/repo', source: 'https://x/y' });
});
