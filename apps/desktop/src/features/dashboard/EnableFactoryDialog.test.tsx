import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EnableFactoryDialog } from './EnableFactoryDialog';
import { factoryApplyResult, factoryPlan, factorySecret, factoryStateNone, factoryStateSettingUp, factoryVerify } from '../../dev/fixtures';
import type { FactoryState } from '../../wire';

vi.mock('../../ipc', () => ({
  enableFactoryPlan: vi.fn(),
  enableFactoryApply: vi.fn(),
  enableFactoryStart: vi.fn(),
  enableFactoryVerify: vi.fn(),
  factoryState: vi.fn(),
  factoryRefresh: vi.fn(),
}));
import { enableFactoryApply, enableFactoryPlan, enableFactoryStart, enableFactoryVerify, factoryRefresh, factoryState } from '../../ipc';

const project = { path: '/repos/my-app', name: 'my-app' };

const at = (statuses: Array<'done' | 'current' | 'pending' | 'failed'>, extra: Partial<FactoryState> = {}): FactoryState => ({
  ...factoryStateSettingUp,
  steps: (['pr', 'secret', 'merged', 'doctor'] as const).map((id, i) => ({ id, status: statuses[i]! })),
  ...extra,
});

beforeEach(() => {
  vi.mocked(factoryState).mockReset().mockResolvedValue(factoryStateNone);
  vi.mocked(factoryRefresh).mockReset().mockResolvedValue(factoryStateSettingUp);
  vi.mocked(enableFactoryPlan).mockReset().mockResolvedValue(factoryPlan);
  vi.mocked(enableFactoryApply).mockReset().mockResolvedValue(factoryApplyResult);
  vi.mocked(enableFactoryStart).mockReset().mockResolvedValue(factoryStateSettingUp);
  vi.mocked(enableFactoryVerify).mockReset().mockResolvedValue(factoryVerify);
});

afterEach(() => {
  vi.useRealTimers();
});

async function pickGithub(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /GitHub Actions/ }));
}

describe('EnableFactoryDialog', () => {
  test('unimplemented run locations are planned with a tracking link; only GitHub Actions plans', async () => {
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /GitLab CI/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('planned')).toHaveLength(3);
    const links = screen.getAllByRole('link', { name: /Tracking issue/ });
    expect(links).toHaveLength(3);
    for (const l of links) expect(l.getAttribute('href')).toMatch(/^https:\/\/github\.com\/spietrza\/taskcell\/issues\?q=/);
    expect(screen.queryByText('coming soon')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /GitHub Actions/ })).toBeEnabled();
  });

  test('plan -> Open PR lands on the checklist with the exact secret command', async () => {
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    await pickGithub();

    await screen.findByText('acme/my-app');
    expect(enableFactoryPlan).toHaveBeenCalledWith(project.path, 'github');
    expect(screen.getByText('.github/workflows/taskcell-implement.yml')).toBeInTheDocument();
    expect(screen.getByText('ready for agent')).toBeInTheDocument();
    expect(enableFactoryApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));
    expect(await screen.findByText(factoryApplyResult.prUrl, { selector: 'a' })).toBeInTheDocument();
    expect(enableFactoryApply).toHaveBeenCalledWith(project.path, factoryPlan);
    // CodeBlock highlights into spans, so match the whole code element's text.
    expect(screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent === factorySecret.command)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run doctor' })).not.toBeInTheDocument();
  });

  test('reopening shows the persisted checklist without asking for a plan', async () => {
    vi.mocked(factoryState).mockResolvedValue(factoryStateSettingUp);
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByText('Secret set')).toBeInTheDocument();
    expect(screen.getByText('PR merged')).toBeInTheDocument();
    expect(enableFactoryPlan).not.toHaveBeenCalled();
    expect(screen.queryByText('planned')).not.toBeInTheDocument();
  });

  test('"Check again" re-verifies the secret and advances the checklist', async () => {
    vi.mocked(factoryState).mockResolvedValue(factoryStateSettingUp);
    vi.mocked(factoryRefresh).mockResolvedValue(at(['done', 'done', 'current', 'pending'], { step: 'merged' }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/Waiting for the merge/)).toBeInTheDocument();
    expect(factoryRefresh).toHaveBeenCalledWith(project.path);
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  test('polls on its own and advances when the PR is merged; the PR is linked', async () => {
    vi.useFakeTimers();
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'done', 'current', 'pending'], { step: 'merged' }));
    vi.mocked(factoryRefresh).mockResolvedValue(at(['done', 'done', 'done', 'current'], { step: 'doctor' }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole('link', { name: 'Open the PR' })).toHaveAttribute('href', factoryStateSettingUp.prUrl);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(factoryRefresh).toHaveBeenCalled();
    expect(screen.queryByText(/Waiting for the merge/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run doctor' })).toBeEnabled();
  });

  test('the doctor can run once merged even if the secret cannot be seen (org-level secret)', async () => {
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'current', 'done', 'pending'], { step: 'secret' }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Run doctor' })).toBeEnabled();
  });

  test('a dispatched doctor with no run listed yet says so', async () => {
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'done', 'done', 'current'], { step: 'doctor', doctorPending: true }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByText(/has not shown up yet/)).toBeInTheDocument();
  });

  test('a failed initial state read still lets you pick a platform', async () => {
    vi.mocked(factoryState).mockRejectedValue(new Error('hub down'));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('hub down');
    expect(screen.getByRole('button', { name: /GitHub Actions/ })).toBeEnabled();
  });

  test('Run doctor dispatches and shows the linked run status', async () => {
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'done', 'done', 'current'], { step: 'doctor' }));
    vi.mocked(factoryRefresh).mockResolvedValue(at(['done', 'done', 'done', 'current'], { step: 'doctor', doctor: { url: factoryVerify.run!.url, status: 'in_progress', conclusion: '' } }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run doctor' }));
    expect(await screen.findByText(/Doctor run: in_progress/)).toHaveAttribute('href', factoryVerify.run!.url);
    expect(enableFactoryVerify).toHaveBeenCalledWith(project.path, factoryStateSettingUp.plan);
  });

  test('callers already on the default branch are marked; with all of them there, the checklist starts without a PR', async () => {
    vi.mocked(enableFactoryPlan).mockResolvedValue({ ...factoryPlan, existingCallerFiles: factoryPlan.callerFiles });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    await pickGithub();

    expect(await screen.findByText(/already on the default branch/)).toBeInTheDocument();
    expect(screen.getAllByText(/already exists, left as is/)).toHaveLength(factoryPlan.callerFiles.length);
    expect(screen.queryByRole('button', { name: 'Open PR' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start checklist' }));
    await screen.findByText('Secret set');
    expect(enableFactoryStart).toHaveBeenCalledWith(project.path, { ...factoryPlan, existingCallerFiles: factoryPlan.callerFiles });
  });

  test('a closed PR is shown as broken with a way to open it again', async () => {
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'current', 'failed', 'pending'], { state: 'broken', step: 'merged', reason: 'the callers PR was closed without merging' }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByText('the callers PR was closed without merging', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open PR again' })).toBeInTheDocument();
  });

  test('a failed step shows its error and keeps the dialog on the same step', async () => {
    vi.mocked(enableFactoryApply).mockRejectedValue(new Error('the working tree has uncommitted changes'));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    await pickGithub();
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('uncommitted changes');
    expect(screen.getByRole('button', { name: 'Open PR' })).toBeEnabled();
  });
});
