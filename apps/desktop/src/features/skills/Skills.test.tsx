import { test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { RepoSkill } from '../../wire';
import { Skills } from './Skills';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__TASKCELL_HUB__;
});

const fixture: RepoSkill[] = [
  { name: 'caveman', source: 'https://github.com/o/caveman', commit: 'abc1234', status: 'pinned', check: 'outdated', runs30d: 1, usage: { runs: 4, passRate: 0.75, avgRepairRounds: 0.5, avgCostUsd: 1.2 } },
  { name: 'simplify', source: 'https://github.com/o/simplify', commit: 'def5678', status: 'pinned', check: 'current' },
];

let pendingPrs: unknown[] = [];
let discovered: unknown = { commit: 'c'.repeat(40), skills: [{ path: 'skills/only', name: 'only' }] };

function stubHub(fail: Record<string, string> = {}): { cmd: string; body: unknown }[] {
  const calls: { cmd: string; body: unknown }[] = [];
  window.__TASKCELL_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const cmd = url.slice(url.indexOf('/rpc/') + 5);
    calls.push({ cmd, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const message = fail[cmd];
    if (message !== undefined) return new Response(JSON.stringify({ error: { kind: 'bad-request', message } }), { status: 400 });
    const result = cmd === 'list_repo_skills' ? { skills: fixture } : cmd === 'discover_skills' ? discovered : cmd === 'list_pending_skill_prs' ? { prs: pendingPrs } : cmd === 'pull_checkout' ? { updated: true } : { prUrl: 'https://github.com/o/r/pull/9' };
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
  // The 30-day count shows when the hub sends it; an older hub sends none.
  expect(screen.getByText('used in 1 run (30 days)')).toBeInTheDocument();
  expect(screen.getAllByText(/used in/)).toHaveLength(1);
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

test('Add skill looks through the repository first; one skill found is ticked, and Add selected opens one PR pinned to the commit', async () => {
  const calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://x/y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByText(/Found 1 skill in this repository/)).toBeInTheDocument();
  expect(screen.getByLabelText(/skills\/only/)).toBeChecked();
  expect(calls.some((c) => c.cmd === 'add_skill_pr')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 skill' }));
  expect(await screen.findByRole('link', { name: /Pull request #9 opened/ })).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === 'add_skill_pr')?.body).toEqual({ repoPath: '/repo', source: 'https://x/y', ref: 'c'.repeat(40), paths: ['skills/only'] });
});

test('a repository of several skills shows a picker; only the ticked ones are added', async () => {
  discovered = { commit: 'd'.repeat(40), skills: [{ path: 'skills/a', name: 'a' }, { path: 'skills/b', name: 'b' }, { path: 'skills/c', name: 'c' }] };
  const calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://github.com/o/many' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByText(/Found 3 skills in this repository/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add skills' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/skills\/a/));
  fireEvent.click(screen.getByLabelText(/skills\/c/));
  fireEvent.click(screen.getByRole('button', { name: 'Add 2 skills' }));
  await screen.findByRole('link', { name: /Pull request #9 opened/ });
  expect(calls.find((c) => c.cmd === 'add_skill_pr')?.body).toMatchObject({ paths: ['skills/a', 'skills/c'] });
  discovered = { commit: 'c'.repeat(40), skills: [{ path: 'skills/only', name: 'only' }] };
});

test('a link to a folder that is one skill is added directly after a scoped lookup; a failed add shows the reason', async () => {
  discovered = { commit: 'c'.repeat(40), skills: [{ path: 'skills/a', name: 'a' }] };
  const calls = stubHub({ add_skill_pr: 'Cannot resolve HEAD of https://x/y.' });
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://github.com/o/r/tree/main/skills/a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByText(/Cannot resolve HEAD of https:\/\/x\/y/)).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === 'add_skill_pr')?.body).toEqual({ repoPath: '/repo', source: 'https://github.com/o/r/tree/main/skills/a' });
});

test('a link to a branch only (no folder) still goes through discovery', async () => {
  const calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://github.com/o/r/tree/main' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  await screen.findByText(/Found 1 skill/);
  expect(calls.some((c) => c.cmd === 'discover_skills')).toBe(true);
});

test('Select all, Clear and the folder checkboxes (with a partial state) drive the picked list and the button count', async () => {
  discovered = {
    commit: 'e'.repeat(40),
    skills: [
      { path: 'skills/engineering/a', name: 'a' },
      { path: 'skills/engineering/b', name: 'b' },
      { path: 'skills/in-progress/c', name: 'c' },
    ],
  };
  const calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://github.com/o/many' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  await screen.findByText(/Found 3 skills/);
  const eng = screen.getByLabelText('Select all in skills/engineering') as HTMLInputElement;
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect(screen.getByRole('button', { name: 'Add 3 skills' })).toBeEnabled();
  fireEvent.click(screen.getByLabelText(/skills\/engineering\/a/));
  expect(eng.indeterminate).toBe(true);
  expect(eng.checked).toBe(false);
  fireEvent.click(eng);
  expect(eng.checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.getByRole('button', { name: 'Add skills' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Select all in skills/in-progress'));
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 skill' }));
  await screen.findByRole('link', { name: /Pull request #9 opened/ });
  expect(calls.find((c) => c.cmd === 'add_skill_pr')?.body).toMatchObject({ paths: ['skills/in-progress/c'] });
  discovered = { commit: 'c'.repeat(40), skills: [{ path: 'skills/only', name: 'only' }] };
});

test('after an add the notice stays with the PR link and the skill names', async () => {
  stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://x/y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  await screen.findByText(/Found 1 skill/);
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 skill' }));
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent('Pull request #9 opened: only — the skill appears here once it is merged.');
});

test('open skill-add PRs are listed under Waiting for merge', async () => {
  pendingPrs = [{ number: 29, url: 'https://github.com/o/r/pull/29', names: ['ponytail', 'caveman'] }];
  stubHub();
  render(<Skills project="/repo" />);
  const link = await screen.findByRole('link', { name: 'Pull request #29' });
  expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/29');
  expect(screen.getByText('ponytail, caveman')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Waiting for merge' })).toBeInTheDocument();
  expect(screen.getByText(/pull the checkout/)).toBeInTheDocument();
  pendingPrs = [];
});

test('Pull checkout calls pull_checkout, refreshes the lists and says it updated', async () => {
  const calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.click(screen.getByRole('button', { name: 'Pull checkout' }));
  expect(await screen.findByText('Checkout updated.')).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === 'pull_checkout')?.body).toEqual({ repoPath: '/repo' });
  expect(calls.filter((c) => c.cmd === 'list_repo_skills')).toHaveLength(2);
});

test('a refused pull shows the reason', async () => {
  stubHub({ pull_checkout: 'The checkout has uncommitted changes; commit or discard them first.' });
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.click(screen.getByRole('button', { name: 'Pull checkout' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Not pulled: .*uncommitted changes/);
});

test('a refused pull message clears when another Skills action starts', async () => {
  stubHub({ pull_checkout: 'The checkout has uncommitted changes; commit or discard them first.' });
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.click(screen.getByRole('button', { name: 'Pull checkout' }));
  await screen.findByRole('alert');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: 'https://x/y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  await screen.findByText(/Found \d+ skills? in this repository/);
  expect(screen.queryByText(/Not pulled/)).toBeNull();
});

test('a folder link holding several skills opens the picker; a folder that is one skill adds it directly', async () => {
  const link = 'https://github.com/o/r/tree/main/skills/eng';
  discovered = { commit: 'e'.repeat(40), skills: [{ path: 'skills/eng/a', name: 'a' }, { path: 'skills/eng/b', name: 'b' }] };
  let calls = stubHub();
  const { unmount } = render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: link } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  expect(await screen.findByText(/Found 2 skills in this repository/)).toBeInTheDocument();
  expect(calls.find((c) => c.cmd === 'discover_skills')?.body).toEqual({ repoPath: '/repo', source: link });
  expect(calls.some((c) => c.cmd === 'add_skill_pr')).toBe(false);
  unmount();
  discovered = { commit: 'e'.repeat(40), skills: [{ path: 'skills/eng', name: 'eng' }] };
  calls = stubHub();
  render(<Skills project="/repo" />);
  await screen.findByText('caveman');
  fireEvent.change(screen.getByLabelText('Skill source'), { target: { value: link } });
  fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
  await screen.findByRole('link', { name: /Pull request #9 opened/ });
  expect(calls.find((c) => c.cmd === 'add_skill_pr')?.body).toEqual({ repoPath: '/repo', source: link });
});
