import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QuickView, matchNeedsYou, waitingWhy, type QuickTask } from './QuickView';
import type { NeedsYouItem, RunDetail, RunSummary } from '../../wire';

vi.mock('../../ipc', () => ({
  listRuns: vi.fn(),
  readRun: vi.fn(),
  listNeedsYou: vi.fn(),
  replyNeedsYou: vi.fn(),
  mergeNeedsYou: vi.fn(),
}));
import { listNeedsYou, listRuns, readRun } from '../../ipc';

const PR = 'https://github.com/o/r/pull/9';
const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({ id: 'o/r#9', kind: 'pr', number: 9, repoSlug: 'o/r', title: 'T', url: PR, reason: 'vanguard:needs-human-review', baseRef: 'main', ...over });
const summary: RunSummary = { taskId: 'gh-7', timestamp: 'ts', stages: ['implementer'], totalCostUsd: 1.5, anyFailed: false, prUrl: PR };
const detail: RunDetail = { taskId: 'gh-7', timestamp: 'ts', prUrl: PR, stages: [{ record: { stage: 'reviewer', verdict: 'pass' } as never }] };
const task: QuickTask = { id: 'gh-7', title: 'Seven', column: 'review', state: 'review', source: 'github', url: 'https://github.com/o/r/issues/7' };
const open = (t: QuickTask = task): ReturnType<typeof render> => render(<QuickView task={t} project="/repo" onClose={() => {}} onFullPage={() => {}} />);

beforeEach(() => {
  vi.mocked(listRuns).mockResolvedValue([summary]);
  vi.mocked(readRun).mockResolvedValue(detail);
  vi.mocked(listNeedsYou).mockResolvedValue({ items: [item({})] });
});

describe('QuickView', () => {
  test('shows the stage line, the receipt with missing facts, and the pull request link', async () => {
    open();
    const receipt = await screen.findByRole('region', { name: 'Receipt' });
    expect(within(receipt).getByText('Second-AI review').nextSibling).toHaveTextContent('passed');
    expect(within(receipt).getByText('Tests').nextSibling).toHaveTextContent('not available');
    expect(within(receipt).getByText('Cost').nextSibling).toHaveTextContent('$1.50');
    const steps = within(screen.getByRole('list', { name: 'Stage line' })).getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-status'))).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
    expect(screen.getAllByRole('link', { name: 'Open in GitHub' }).map((a) => a.getAttribute('href'))).toEqual(['https://github.com/o/r/issues/7', PR]);
  });

  test('a waiting pull request shows why, Reply and Merge (matched by its address)', async () => {
    open();
    expect(await screen.findByText(/Needs you · Pull request ready/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeInTheDocument();
    expect(screen.getByLabelText('reply to o/r#9')).toBeInTheDocument();
  });

  test('a card with no receipt data and no pull request shows no receipt', async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    open({ ...task, column: 'running', stage: 'implementer' });
    await screen.findByRole('list', { name: 'Stage line' });
    expect(screen.queryByRole('region', { name: 'Receipt' })).not.toBeInTheDocument();
  });
});

describe('matchNeedsYou / waitingWhy', () => {
  test('a PR matches by address, never by number', () => {
    const pr = item({ number: 7 });
    expect(matchNeedsYou([pr], { id: 'gh-7', source: 'github' }, undefined)).toBeNull();
    expect(matchNeedsYou([pr], { id: 'gh-7', source: 'github' }, 'https://github.com/o/r/pull/other')).toBeNull();
    expect(matchNeedsYou([pr], { id: 'gh-7', source: 'github' }, PR)).toBe(pr);
  });

  test('an issue matches a GitHub card by number, never a Linear card', () => {
    const issue = item({ kind: 'issue', number: 12, url: 'https://github.com/o/r/issues/12' });
    expect(matchNeedsYou([issue], { id: 'gh-12', source: 'github' }, undefined)).toBe(issue);
    expect(matchNeedsYou([issue], { id: 'linear-eng-12', source: 'linear' }, undefined)).toBeNull();
  });

  test('plain words', () => {
    expect(waitingWhy({ kind: 'pr' })).toBe('Pull request ready');
    expect(waitingWhy({ kind: 'issue' })).toBe('Question for you');
  });
});
