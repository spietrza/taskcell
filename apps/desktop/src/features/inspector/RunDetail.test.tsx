import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunDetail } from './RunDetail';
import type { RunDetail as RunDetailT, StageDetail } from '../../taskcell-output';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  delete (window as unknown as { __TASKCELL_HUB__?: boolean }).__TASKCELL_HUB__;
  vi.unstubAllGlobals();
});

function stage(diffOmitted?: StageDetail['record']['diffOmitted'], diff?: string): StageDetail {
  return {
    record: {
      taskId: 'task-1', completed: true, exitReason: 'completed', turns: 1,
      worktreePath: '/tmp/wt', worktreePreserved: false, finalText: 'done',
      timestamp: '2026-07-06T19:12:02.000Z', diffOmitted,
    },
    diff,
  };
}

function showDiff(stages: StageDetail[]) {
  const detail: RunDetailT = { taskId: 'task-1', timestamp: stages[0].record.timestamp, stages };
  render(<RunDetail detail={detail} project="/repo" />);
  fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
}

test.each(['secret-blocked', 'secret-scan'] as const)('explains a diff withheld for %s', (reason) => {
  showDiff([stage(reason)]);
  expect(screen.getByText(`diff withheld: ${reason}`)).toBeInTheDocument();
  expect(screen.queryByText('No diff captured.')).not.toBeInTheDocument();
});

test('withheld stages hide stale diffs while normal stages still show their diff', () => {
  showDiff([stage('secret-blocked', '+sensitive stale diff'), stage(undefined, '+safe diff')]);
  expect(screen.queryByText('+sensitive stale diff')).not.toBeInTheDocument();
  expect(screen.getByText('+safe diff')).toBeInTheDocument();
});

test('shows the empty state when there is no diff or omission reason', () => {
  showDiff([stage()]);
  expect(screen.getByText('No diff captured.')).toBeInTheDocument();
});

test('T29: overview renders verdict and all structured findings as text', async () => {
  const reviewer = stage();
  reviewer.record.stage = 'reviewer';
  reviewer.record.verdict = 'changes';
  reviewer.record.findings = [
    { severity: 'high', kind: 'security', title: 'Secret leak', evidence: '<img src=x onerror=alert(1)>' },
    { severity: 'medium', kind: 'correctness', title: 'Wrong result', evidence: 'return undefined' },
  ];
  render(<RunDetail detail={{ taskId: 'task-1', timestamp: reviewer.record.timestamp, stages: [reviewer] }} project="/repo" />);
  expect(screen.getByText('verdict: changes')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /reviewer/ }));
  for (const finding of reviewer.record.findings) {
    expect(await screen.findByText(finding.severity)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(finding.kind))).toHaveTextContent(finding.title);
    expect(screen.getByText(finding.evidence)).toBeInTheDocument();
  }
  expect(document.querySelector('img[src="x"]')).toBeNull();
});

test('T29/T30: legacy records have no verdict; withheld findings are explained', () => {
  const reviewer = stage('secret-blocked');
  reviewer.record.stage = 'reviewer';
  reviewer.record.verdict = 'pass';
  const legacy = stage();
  legacy.record.stage = 'implementer';
  render(<RunDetail detail={{ taskId: 'task-1', timestamp: reviewer.record.timestamp, stages: [reviewer, legacy] }} project="/repo" />);
  expect(screen.getAllByText(/^verdict:/)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /reviewer/ }));
  expect(screen.getByText('findings withheld: secret-blocked')).toBeInTheDocument();
});

test('the overview says which credential funded the run; nothing without one', () => {
  const withSource = (credentialSource?: 'instance' | 'user'): StageDetail => ({ record: { ...stage().record, credentialSource } });
  const { unmount } = render(<RunDetail detail={{ taskId: 'task-1', timestamp: stage().record.timestamp, stages: [withSource('user')] }} project="/repo" />);
  expect(screen.getByText(/billed to the starter's own account/)).toBeInTheDocument();
  unmount();
  const { unmount: unmount1 } = render(<RunDetail detail={{ taskId: 'task-1', timestamp: stage().record.timestamp, stages: [withSource('instance')] }} project="/repo" />);
  expect(screen.getByText(/billed to the hub's account/)).toBeInTheDocument();
  unmount1();
  const { unmount: unmount2 } = render(<RunDetail detail={{ taskId: 'task-1', timestamp: stage().record.timestamp, stages: [withSource()] }} project="/repo" />);
  expect(screen.queryByText(/billed to/)).not.toBeInTheDocument();
  unmount2();
});

test('a changed gate config says why it matters', () => {
  const changed: StageDetail = { record: { ...stage().record, configPaths: ['package.json'] } };
  render(<RunDetail detail={{ taskId: 'task-1', timestamp: stage().record.timestamp, stages: [changed] }} project="/repo" />);
  expect(screen.getByRole('note')).toHaveAttribute('title', 'This run changed a file your test commands come from. Check it before merging.');
  expect(screen.getByRole('note')).toHaveTextContent('Gate config changed: package.json');
});

test('the overview shows the stored credential name, never a value', () => {
  const named: StageDetail = { record: { ...stage().record, credentialSource: 'instance', credentialName: 'Team key 2' } };
  render(<RunDetail detail={{ taskId: 'task-1', timestamp: stage().record.timestamp, stages: [named] }} project="/repo" />);
  expect(screen.getByText(/billed to the hub's account "Team key 2"/)).toBeInTheDocument();
});
