import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FallbackChain, TeamFallbackChain } from './FallbackChain';
import { stubHubCalls } from '../../testHub';
import type { FallbackEntry, Team } from '../../wire';

afterEach(() => vi.restoreAllMocks());

const providers = ['claude', 'codex', 'cursor'];

test('row 1 is the read-only Engine; add, move and remove change the chain in order', () => {
  const onChange = vi.fn<(c: FallbackEntry[] | undefined) => void>();
  const chain = [{ provider: 'codex', model: 'gpt-6-sol' }, { provider: 'cursor' }];
  render(<FallbackChain engine="claude" chain={chain} providers={providers} onChange={onChange} />);
  expect(screen.getByText('Engine').previousSibling).toHaveTextContent('claude');
  expect(screen.getByLabelText('Move fallback 1 up')).toBeDisabled();
  expect(screen.getByLabelText('Move fallback 2 down')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Move fallback 2 up'));
  expect(onChange).toHaveBeenLastCalledWith([{ provider: 'cursor' }, { provider: 'codex', model: 'gpt-6-sol' }]);
  fireEvent.click(screen.getByLabelText('Remove fallback 1'));
  expect(onChange).toHaveBeenLastCalledWith([{ provider: 'cursor' }]);
  fireEvent.click(screen.getByText(/Add fallback/));
  // The first provider that is not the Engine.
  expect(onChange).toHaveBeenLastCalledWith([...chain, { provider: 'codex' }]);
  fireEvent.change(screen.getByLabelText('Fallback 1 model'), { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith([{ provider: 'codex' }, { provider: 'cursor' }]);
  fireEvent.click(screen.getByText('Use team default'));
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test('per-row and list errors show inline; an unknown saved provider stays visible as not configured', () => {
  render(<FallbackChain engine="claude" chain={[{ provider: 'claude' }, { provider: 'gone' }, { provider: 'gone' }]} providers={providers} onChange={() => {}} />);
  expect(screen.getByText(/Engine itself/)).toHaveAttribute('role', 'alert');
  expect(screen.getAllByText('Unknown provider "gone".')).toHaveLength(2);
  expect(screen.getAllByRole('option', { name: 'gone (not configured)' })).toHaveLength(2);
  render(<FallbackChain engine="claude" chain={[{ provider: 'claude', model: 'sonnet' }]} providers={providers} onChange={() => {}} />);
  expect(screen.getByText(/add a second entry/)).toHaveAttribute('role', 'alert');
});

test('without its own chain the project shows the team default it inherits, or that none applies', () => {
  const { rerender } = render(<FallbackChain engine="claude" chain={undefined} providers={providers} inherited={[{ provider: 'codex', model: 'gpt-6-sol' }, { provider: 'cursor' }]} onChange={() => {}} />);
  expect(screen.getByText('Team default: codex/gpt-6-sol → cursor')).toBeInTheDocument();
  expect(screen.queryByText('Use team default')).toBeNull();
  rerender(<FallbackChain engine="claude" chain={undefined} providers={providers} onChange={() => {}} />);
  expect(screen.getByText('No team default: a run waits for the limit to reset.')).toBeInTheDocument();
  rerender(<FallbackChain engine="claude" chain={[]} providers={providers} onChange={() => {}} />);
  expect(screen.queryByText(/team default:/i)).toBeNull();
});

const team: Team = { id: 't', name: 'T', members: [], repositories: [] };

test('a team admin saves the team default with set_team_fallback_chain; Save waits for a valid change', async () => {
  const saved: Team = { ...team, fallbackChain: [{ provider: 'codex' }] };
  const call = stubHubCalls({ set_team_fallback_chain: async () => saved });
  const onTeam = vi.fn();
  render(<TeamFallbackChain team={team} providers={providers} admin onTeam={onTeam} />);
  const save = screen.getByRole('button', { name: 'Save team default' });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByText(/Add fallback/));
  fireEvent.change(screen.getByLabelText('Fallback 1 provider'), { target: { value: '' } });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Fallback 1 provider'), { target: { value: 'codex' } });
  fireEvent.click(save);
  await waitFor(() => expect(onTeam).toHaveBeenCalledWith(saved));
  expect(call).toHaveBeenCalledWith('set_team_fallback_chain', { teamId: 't', chain: [{ provider: 'codex' }] });
});

test('a non-admin reads the team default as text and cannot edit it', () => {
  render(<TeamFallbackChain team={{ ...team, fallbackChain: [{ provider: 'codex', model: 'gpt-6-sol' }] }} providers={providers} admin={false} onTeam={() => {}} />);
  expect(screen.getByText('codex/gpt-6-sol')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
