import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { flowOptionsFrom, issueRefFrom, providerOptionsFrom, NewRunForm } from './NewRunForm';
import * as ipc from '../../ipc';
import type { Capabilities } from '../../ipc';

vi.mock('../../ipc.js', () => ({
  apiListFlows: vi.fn(async () => ({ flows: [] })),
  apiListProviders: vi.fn(async () => ({ providers: [] })),
  apiListSkills: vi.fn(async () => ({ skills: ['ponytail', 'simplify'] })),
}));

beforeEach(() => {
  window.__TASKCELL_HUB__ = true;
});

const caps: Capabilities = {
  providers: ['claude', 'codex'],
  flows: [
    { name: 'default', label: 'Default' },
    { name: 'plan', label: 'Plan' },
  ],
  stages: ['planner', 'implementer'],
  transports: ['github', 'gitlab', 'linear'],
  defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
};

test('Run is disabled until issueRef is non-blank', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  const run = screen.getByRole('button', { name: /^run$/i });
  expect(run).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  expect(run).not.toBeDisabled();
});

test('Run is disabled when maxTurns is not a positive integer', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  const run = screen.getByRole('button', { name: /^run$/i });
  expect(run).not.toBeDisabled();
  fireEvent.click(screen.getByText('Advanced')); // maxTurns lives in the collapsed Advanced panel
  fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '0' } });
  expect(run).toBeDisabled();
});

test('Run calls onRun with repoPath=project and defaulted fields', async () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: '322' } });
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  expect(onRun).toHaveBeenCalledWith(
    expect.objectContaining({
      issueRef: '322',
      repoPath: '/repo',
      provider: 'claude',
      transport: 'github',
      flow: 'default',
      maxTurns: 30,
    }),
  );
});

test('flowOptionsFrom merges built-ins with healthy repo flows and never offers errored entries (S5)', () => {
  const merged = flowOptionsFrom(caps, [
    { file: 'my-flow.hcl', name: 'my-flow', label: 'Mine' },
    { file: 'odd.hcl', name: 'odd', label: 'Odd', error: 'unknown stage' }, // invalid: excluded
    { file: 'broken.hcl', error: 'parse error' }, // unparseable: excluded
  ]);
  expect(merged).toEqual([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
    { value: 'my-flow', label: 'Mine' },
  ]);
  // degraded ('error') and not-yet-loaded (null) both fall back to built-ins only
  expect(flowOptionsFrom(caps, 'error').map((o) => o.value)).toEqual(['default', 'plan']);
  expect(flowOptionsFrom(caps, null).map((o) => o.value)).toEqual(['default', 'plan']);
});

test('the form fetches repo flows fresh for its project on open (S5)', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalledWith('/repo'));
});

test('listFlows failure degrades to built-ins with a notice — the form never disappears', async () => {
  vi.mocked(ipc.apiListFlows).mockRejectedValueOnce('sidecar dead');
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  expect(await screen.findByText(/repo flows unavailable/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
});

test('flowOptionsFrom keeps option values unique even if colliding entries slip past the error flag', () => {
  const merged = flowOptionsFrom(caps, [
    { file: 'plan.hcl', name: 'plan', label: 'Shadow' }, // built-in collision
    { file: 'a.hcl', name: 'twin', label: 'First' }, // repo-vs-repo collision
    { file: 'b.hcl', name: 'twin', label: 'Second' },
  ]);
  expect(merged.filter((o) => o.value === 'plan')).toEqual([{ value: 'plan', label: 'Plan' }]); // built-in wins, once
  expect(merged.filter((o) => o.value === 'twin')).toEqual([{ value: 'twin', label: 'First' }]); // first wins, once
  expect(new Set(merged.map((o) => o.value)).size).toBe(merged.length); // globally unique
});


test('providerOptionsFrom merges built-ins with healthy repo customs; errored entries never offered (S6)', () => {
  const options = providerOptionsFrom(caps, [
    { index: 0, name: 'my-proxy' },
    { index: 1, name: 'bad', error: 'customProviders[1]: "baseUrl" must be an absolute http:// or https:// URL' },
    { index: 2, name: 'claude' }, // built-in collision slipping past the error flag — first wins
  ]);
  expect(options.map((o) => o.value)).toEqual(['claude', 'codex', 'my-proxy']);
});

test('the form fetches repo providers fresh for its project on open (S6)', async () => {
  vi.mocked(ipc.apiListProviders).mockResolvedValueOnce({ providers: [{ index: 0, name: 'my-proxy' }] });
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListProviders).toHaveBeenCalledWith('/repo'));
});

test('listProviders failure degrades to built-ins with a notice — the form never disappears (S6)', async () => {
  vi.mocked(ipc.apiListProviders).mockRejectedValueOnce(new Error('sidecar down'));
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(screen.getByText(/repo providers unavailable/i)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
});

test('an issue ref with a space is refused with a reason', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: 'abc def' } });
  expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('An issue ref has no spaces');
  fireEvent.change(screen.getByPlaceholderText(/issue/i), { target: { value: ' 322 ' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^run$/i })).not.toBeDisabled();
});

test('opened from a card, the form carries that card\'s ref and tracker, under a heading with named fields', async () => {
  expect(issueRefFrom('gh-904')).toEqual({ issueRef: '904', transport: 'github' });
  expect(issueRefFrom('gl-42')).toEqual({ issueRef: '42', transport: 'gitlab' });
  expect(issueRefFrom('linear-dev-639')).toEqual({ issueRef: 'DEV-639', transport: 'linear' });
  expect(issueRefFrom('DEMO-104')).toEqual({ issueRef: 'DEMO-104' });
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" taskId="gl-42" onRun={onRun} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  expect(screen.getByRole('heading', { name: 'New run' })).toBeInTheDocument();
  for (const label of ['Task source', 'Provider', 'Flow']) expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByLabelText('Issue ref')).toHaveValue('42');
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ issueRef: '42', transport: 'gitlab' }));
});

test('each select has an accessible name matching its visible label', async () => {
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  await waitFor(() => expect(ipc.apiListFlows).toHaveBeenCalled());
  for (const name of ['Task source', 'Provider', 'Flow']) expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
});

test('hand-picked skills ride on the run params', async () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('Issue ref'), { target: { value: '5' } });
  fireEvent.click(screen.getByText('Advanced'));
  fireEvent.click(await screen.findByLabelText('ponytail'));
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ issueRef: '5', skills: ['ponytail'] }));
});

test('the card\'s skills are preselected, shown in the command preview, and one unticked is sent as not chosen', async () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" taskId="gh-5" taskSkills={['ponytail', 'simplify']} onRun={onRun} onCancel={() => {}} />);
  fireEvent.click(screen.getByText('Advanced'));
  expect(await screen.findByLabelText('ponytail')).toBeChecked();
  fireEvent.click(screen.getByText('≈ command'));
  expect(screen.getByText(/--skill ponytail --skill simplify/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('simplify'));
  fireEvent.click(screen.getByLabelText('ponytail'));
  expect(screen.queryByText(/--skill/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  // Sent empty, not left out: the run must not load them from the issue body.
  expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ skills: [] }));
});

test('a run with no card skills and nothing ticked sends no skills, so the issue body decides', async () => {
  const onRun = vi.fn();
  render(<NewRunForm capabilities={caps} project="/repo" onRun={onRun} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('Issue ref'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(onRun.mock.calls[0]?.[0]).not.toHaveProperty('skills');
});

test('when the skills cannot be listed the picker says why and keeps the card\'s skills untickable', async () => {
  vi.mocked(ipc.apiListSkills).mockRejectedValueOnce(new Error('skills.lock.json does not match code-review'));
  render(<NewRunForm capabilities={caps} project="/repo" taskId="gh-5" taskSkills={['ponytail']} onRun={vi.fn()} onCancel={() => {}} />);
  fireEvent.click(screen.getByText('Advanced'));
  expect(await screen.findByRole('status')).toHaveTextContent('skills unavailable — skills.lock.json does not match code-review');
  expect(screen.getByLabelText('ponytail')).toBeChecked();
});

test('no skill picker is rendered outside hub mode', async () => {
  delete window.__TASKCELL_HUB__;
  render(<NewRunForm capabilities={caps} project="/repo" onRun={vi.fn()} onCancel={() => {}} />);
  fireEvent.click(screen.getByText('Advanced'));
  expect(await screen.findByPlaceholderText(/card \/ repo default/)).toBeInTheDocument();
  expect(screen.queryByText('skills')).not.toBeInTheDocument();
});
