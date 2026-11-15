import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EnableFactoryDialog } from './EnableFactoryDialog';
import { factoryApplyResult, factoryPlan, gitlabFactoryPlan, factorySecret, factoryStateNone, factoryStateSettingUp, factoryVerify } from '../../dev/fixtures';
import type { FactoryState } from '../../wire';

vi.mock('../../ipc', () => ({
  enableFactoryHost: vi.fn(),
  enableFactoryPlan: vi.fn(),
  enableFactoryApply: vi.fn(),
  enableFactoryStart: vi.fn(),
  enableFactoryVerify: vi.fn(),
  enableFactoryWatch: vi.fn(),
  localWorkerState: vi.fn(),
  localWorkerSet: vi.fn(),
  localWorkerDoctor: vi.fn(),
  factoryState: vi.fn(),
  factoryRefresh: vi.fn(),
}));
import { enableFactoryApply, enableFactoryHost, enableFactoryPlan, enableFactoryStart, enableFactoryVerify, enableFactoryWatch, factoryRefresh, factoryState, localWorkerSet, localWorkerState } from '../../ipc';

const project = { path: '/repos/my-app', name: 'my-app' };

const at = (statuses: Array<'done' | 'current' | 'pending' | 'failed'>, extra: Partial<FactoryState> = {}): FactoryState => ({
  ...factoryStateSettingUp,
  steps: (['pr', 'secret', 'merged', 'doctor'] as const).map((id, i) => ({ id, status: statuses[i]! })),
  ...extra,
});

beforeEach(() => {
  vi.mocked(enableFactoryHost).mockReset().mockResolvedValue({ host: 'github' });
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
  test('GitLab CI is unavailable with the reason for a GitHub project; no location is marked planned', async () => {
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByText(/remote is on GitHub, not GitLab/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GitLab CI/ })).not.toBeInTheDocument();
    expect(screen.queryByText('planned')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Local hub/ })).toBeEnabled();
    expect(await screen.findByRole('button', { name: /GitHub Actions/ })).toBeEnabled();
  });

  test('Local hub: a switch that is off by default, turns on, and says why when blocked', async () => {
    const base = { enabled: false, source: 'github' as const, credentials: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], present: true } };
    vi.mocked(localWorkerState).mockReset().mockResolvedValue(base);
    vi.mocked(localWorkerSet).mockReset().mockResolvedValue({ ...base, enabled: true });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Local hub/ }));
    const sw = await screen.findByRole('switch');
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await screen.findByText(/Local hub worker: on/);
    expect(localWorkerSet).toHaveBeenCalledWith(project.path, true);
  });

  test('Local hub: a blocked project cannot be switched on and the reason is shown', async () => {
    vi.mocked(localWorkerState).mockReset().mockResolvedValue({ enabled: false, blocked: 'This project has no task source; pick one.', credentials: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], present: false } });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Local hub/ }));
    expect(await screen.findByRole('switch')).toBeDisabled();
    expect(screen.getByText(/no task source/)).toBeInTheDocument();
    expect(screen.getByText(/no provider credential/)).toBeInTheDocument();
  });

  const watchList = {
    repoSlug: 'acme/widgets',
    source: 'github' as const,
    compose: 'services:\n  taskcell-watch:\n    mem_limit: 1024m',
    command: 'taskcell watch --github-repo=acme/widgets',
    credentials: ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'],
    seen: 'unknown' as const,
  };

  test('Self-hosted (watch) shows the snippet, command, credential names and worker-seen state', async () => {
    vi.mocked(enableFactoryWatch).mockReset().mockResolvedValue(watchList);
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Self-hosted \(watch\)/ }));
    expect(await screen.findByText('GH_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('CLAUDE_CODE_OAUTH_TOKEN')).toBeInTheDocument();
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain('mem_limit: 1024m');
    expect(text).toContain('taskcell watch --github-repo=acme/widgets');
    expect(screen.getByText(/Cannot tell/)).toBeInTheDocument();
    expect(enableFactoryPlan).not.toHaveBeenCalled();
  });

  test('Check again re-reads the worker state: recent and stale say when, in plain time', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(enableFactoryWatch).mockReset()
      .mockResolvedValueOnce({ ...watchList, seen: 'stale', lastRunAt: '2026-10-01T08:30:00.000Z' })
      .mockResolvedValueOnce({ ...watchList, seen: 'recent', lastRunAt: recent });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Self-hosted \(watch\)/ }));
    expect(await screen.findByText(/Not recently: .* from 2026-10-01 08:30 \(/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/Yes: a watch worker last recorded a run .*\(1m ago\)/)).toBeInTheDocument();
    expect(enableFactoryWatch).toHaveBeenCalledTimes(2);
  });

  test('a failed watch read shows the hub\'s sentence and Back returns to the picker', async () => {
    vi.mocked(enableFactoryWatch).mockReset()
      .mockRejectedValueOnce(new Error('A `taskcell watch` worker cannot read the hub board; the hub runs its own tasks.'))
      .mockResolvedValueOnce(watchList);
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Self-hosted \(watch\)/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot read the hub board/);
    fireEvent.click(screen.getByRole('button', { name: /Self-hosted \(watch\)/ }));
    await screen.findByText('GH_TOKEN');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: /GitHub Actions/ })).toBeInTheDocument();
  });

  test('only the pressed Copy button says Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(enableFactoryWatch).mockReset().mockResolvedValue(watchList);
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Self-hosted \(watch\)/ }));
    await screen.findByText('GH_TOKEN');
    const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
    fireEvent.click(copyButtons[copyButtons.length - 1]!);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(watchList.command);
    expect(screen.getAllByRole('button', { name: 'Copied' })).toHaveLength(1);
  });

  test('a project with no remote says so, and offers no watch checklist', async () => {
    vi.mocked(enableFactoryHost).mockResolvedValue({ host: 'none' });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect((await screen.findAllByText(/no remote/)).length).toBe(2);
    expect(screen.queryByRole('button', { name: /Self-hosted \(watch\)/ })).not.toBeInTheDocument();
  });

  test('GitLab CI is offered for a GitLab remote and plans through the gitlab provider', async () => {
    vi.mocked(enableFactoryHost).mockResolvedValue({ host: 'gitlab' });
    vi.mocked(enableFactoryPlan).mockResolvedValue(gitlabFactoryPlan);
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitLab CI/ }));
    await screen.findByText('acme/my-app');
    expect(enableFactoryPlan).toHaveBeenCalledWith(project.path, 'gitlab');
    expect(screen.getByText('.gitlab/taskcell.yml')).toBeInTheDocument();
    expect(screen.getByText(/never edits CI config itself/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open merge request' }));
    await vi.waitFor(() => expect(enableFactoryApply).toHaveBeenCalledWith(project.path, { ...gitlabFactoryPlan, gitlabRunnerTags: [] }));
  });

  test('GitLab: a CI file the hub cannot edit is named with the exact include line; no MR is offered when only that line is missing', async () => {
    vi.mocked(enableFactoryHost).mockResolvedValue({ host: 'gitlab' });
    vi.mocked(enableFactoryPlan).mockResolvedValue({ ...gitlabFactoryPlan, gitlabManualInclude: true });
    const first = render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitLab CI/ }));
    expect(await screen.findByText(/not edited automatically/)).toBeInTheDocument();
    expect(screen.getByText('- local: .gitlab/taskcell.yml')).toBeInTheDocument();
    expect(screen.getByText(/Before merging the merge request/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open merge request' })).toBeEnabled();
    first.unmount();

    vi.mocked(enableFactoryPlan).mockResolvedValue({ ...gitlabFactoryPlan, gitlabManualInclude: true, existingCallerFiles: ['.gitlab/taskcell.yml'] });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitLab CI/ }));
    expect(await screen.findByText(/no merge request to open/)).toBeInTheDocument();
    expect(screen.getByText('- local: .gitlab/taskcell.yml')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open merge request' })).toBeDisabled();
  });

  test('GitLab: Run doctor asks for an explicit confirmation when the project has jobs without rules', async () => {
    const plan = { ...gitlabFactoryPlan, gitlabUnruledJobs: ['deploy', 'publish'] };
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'done', 'done', 'current'], { step: 'doctor', plan }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run doctor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This also runs deploy, publish');
    expect(enableFactoryVerify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run doctor anyway' }));
    await vi.waitFor(() => expect(enableFactoryVerify).toHaveBeenCalledWith(project.path, plan, ['deploy', 'publish']));
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
    expect(enableFactoryVerify).toHaveBeenCalledWith(project.path, factoryStateSettingUp.plan, []);
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

  test('GitLab: the runner tags are pre-filled, parsed on apply, and hidden when the jobs file already exists', async () => {
    vi.mocked(enableFactoryHost).mockResolvedValue({ host: 'gitlab' });
    vi.mocked(enableFactoryPlan).mockResolvedValue({ ...gitlabFactoryPlan, gitlabRunnerTags: ['docker', 'linux'] });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitLab CI/ }));
    const field = await screen.findByLabelText('Runner tags');
    expect(field).toHaveValue('docker, linux');
    fireEvent.change(field, { target: { value: ' arm64 , secure:prod ,, big runner' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open merge request' }));
    await vi.waitFor(() => expect(enableFactoryApply).toHaveBeenCalledWith(project.path, expect.objectContaining({ gitlabRunnerTags: ['arm64', 'secure:prod', 'big runner'] })));
  });

  test('GitLab: default tags the hub could not copy leave the field empty with the note', async () => {
    vi.mocked(enableFactoryHost).mockResolvedValue({ host: 'gitlab' });
    vi.mocked(enableFactoryPlan).mockResolvedValue({ ...gitlabFactoryPlan, gitlabRunnerTags: [], gitlabRunnerTagsNote: 'The project\'s `default: tags` could not be copied' });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitLab CI/ }));
    expect(await screen.findByLabelText('Runner tags')).toHaveValue('');
    expect(screen.getByText(/could not be copied/)).toBeInTheDocument();
  });

  test('GitLab: the runner tags field is not offered when the jobs file is already on the default branch', async () => {
    vi.mocked(enableFactoryHost).mockResolvedValue({ host: 'gitlab' });
    vi.mocked(enableFactoryPlan).mockResolvedValue({ ...gitlabFactoryPlan, existingCallerFiles: ['.gitlab/taskcell.yml'] });
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitLab CI/ }));
    await screen.findByText('acme/my-app');
    expect(screen.queryByLabelText('Runner tags')).not.toBeInTheDocument();
  });

  test('GitLab: "Open MR again" after a reopen re-applies the saved plan\'s tags', async () => {
    const saved = { ...gitlabFactoryPlan, gitlabRunnerTags: ['docker', 'linux'] };
    vi.mocked(factoryState).mockResolvedValue(at(['done', 'current', 'failed', 'pending'], { state: 'broken', step: 'merged', reason: 'the callers MR was closed without merging', plan: saved }));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open MR again' }));
    await vi.waitFor(() => expect(enableFactoryApply).toHaveBeenCalledWith(project.path, saved));
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
