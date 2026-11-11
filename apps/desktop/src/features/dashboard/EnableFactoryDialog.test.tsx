import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EnableFactoryDialog } from './EnableFactoryDialog';
import { factoryApplyResult, factoryPlan, factorySecret, factoryVerify } from '../../dev/fixtures';

vi.mock('../../ipc', () => ({
  enableFactoryPlan: vi.fn(),
  enableFactoryApply: vi.fn(),
  enableFactorySecret: vi.fn(),
  enableFactoryVerify: vi.fn(),
}));
import { enableFactoryApply, enableFactoryPlan, enableFactorySecret, enableFactoryVerify } from '../../ipc';

const project = { path: '/repos/my-app', name: 'my-app' };

beforeEach(() => {
  vi.mocked(enableFactoryPlan).mockReset().mockResolvedValue(factoryPlan);
  vi.mocked(enableFactorySecret).mockReset().mockResolvedValue(factorySecret);
  vi.mocked(enableFactoryApply).mockReset().mockResolvedValue(factoryApplyResult);
  vi.mocked(enableFactoryVerify).mockReset().mockResolvedValue(factoryVerify);
});

describe('EnableFactoryDialog', () => {
  test('GitLab and Linear are coming soon and disabled; only GitHub Actions plans', () => {
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /GitLab CI/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Linear/ })).toBeDisabled();
    expect(screen.getAllByText('coming soon')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /GitHub Actions/ })).toBeEnabled();
  });

  test('plan -> Open PR -> Run verify, passing the planned plan through each step', async () => {
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /GitHub Actions/ }));

    await screen.findByText('acme/my-app');
    expect(enableFactoryPlan).toHaveBeenCalledWith(project.path, 'github');
    expect(screen.getByText('.github/workflows/vanguard-implement.yml')).toBeInTheDocument();
    expect(screen.getByText('ready for agent')).toBeInTheDocument();
    // CodeBlock highlights into spans, so match the whole code element's text.
    expect(screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent === factorySecret.command)).toBeInTheDocument();
    expect(enableFactoryApply).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run verify' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));
    await screen.findByText(factoryApplyResult.prUrl);
    expect(enableFactoryApply).toHaveBeenCalledWith(project.path, factoryPlan);

    fireEvent.click(screen.getByRole('button', { name: 'Run verify' }));
    expect(await screen.findByText(/Doctor run: queued/)).toHaveAttribute('href', factoryVerify.run!.url);
    expect(enableFactoryVerify).toHaveBeenCalledWith(project.path, factoryPlan);
  });

  test('a failed step shows its error and keeps the dialog on the same step', async () => {
    vi.mocked(enableFactoryApply).mockRejectedValue(new Error('the working tree has uncommitted changes'));
    render(<EnableFactoryDialog project={project} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /GitHub Actions/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('uncommitted changes');
    expect(screen.getByRole('button', { name: 'Open PR' })).toBeEnabled();
  });
});
