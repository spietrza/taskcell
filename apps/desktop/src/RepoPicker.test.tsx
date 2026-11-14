import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RepoPicker } from './RepoPicker';
import type { DirListing } from './taskcell-output';

vi.mock('./ipc', () => ({ browseDirs: vi.fn() }));
import { browseDirs } from './ipc';
const mockBrowseDirs = vi.mocked(browseDirs);

const ROOT: DirListing = {
  path: '/root',
  entries: [
    { name: 'git-repo', path: '/root/git-repo', isGitRepo: true, hasTaskcell: true },
    { name: 'plain', path: '/root/plain', isGitRepo: false, hasTaskcell: false },
  ],
};
const GIT_REPO: DirListing = { path: '/root/git-repo', parent: '/root', entries: [] };
const PLAIN: DirListing = { path: '/root/plain', parent: '/root', entries: [] };
// Not reachable by walking down from ROOT: another Windows drive.
const OTHER_DRIVE: DirListing = { path: 'D:\\code\\repo', parent: 'D:\\code', isGitRepo: true, entries: [] };

function install(): void {
  mockBrowseDirs.mockImplementation(async (path?: string) => {
    if (path === GIT_REPO.path) return GIT_REPO;
    if (path === PLAIN.path) return PLAIN;
    if (path === OTHER_DRIVE.path) return OTHER_DRIVE;
    if (path === ROOT.path || path === undefined) return ROOT;
    throw new Error(`unexpected path ${path}`);
  });
}

// The Tabs primitive reads matchMedia on mount; jsdom has none.
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => vi.unstubAllGlobals());

describe('RepoPicker', () => {
  test('T-96 badges render per entry, and Add is disabled until a git-repo row is entered', async () => {
    install();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<RepoPicker onAdd={onAdd} onClone={vi.fn()} onClose={() => {}} />);

    await screen.findByText('git-repo');
    const gitRow = screen.getByText('git-repo').closest('button')!;
    const plainRow = screen.getByText('plain').closest('button')!;
    expect(within(gitRow).getByText('git')).toBeInTheDocument();
    expect(within(gitRow).getByText('.taskcell')).toBeInTheDocument();
    expect(within(plainRow).queryByText('git')).not.toBeInTheDocument();
    expect(within(plainRow).queryByText('.taskcell')).not.toBeInTheDocument();

    // Root itself isn't known to be a git repo — Add starts disabled.
    expect(screen.getByRole('button', { name: /add this repo/i })).toBeDisabled();
  });

  test('T-96 navigation: entering a non-git row keeps Add disabled; entering a git row enables it; "up" returns to the parent listing', async () => {
    install();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<RepoPicker onAdd={onAdd} onClone={vi.fn()} onClose={() => {}} />);

    await screen.findByText('git-repo');
    fireEvent.click(screen.getByText('plain'));
    await screen.findByText('/root/plain');
    expect(screen.getByRole('button', { name: /add this repo/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /parent directory/i }));
    await screen.findByText('git-repo'); // back at root

    fireEvent.click(screen.getByText('git-repo'));
    await screen.findByText('/root/git-repo');
    expect(screen.getByRole('button', { name: /add this repo/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /add this repo/i }));
    expect(onAdd).toHaveBeenCalledWith('/root/git-repo');
  });

  test('a typed path opens a folder outside the root listing (another drive) and adds it', async () => {
    install();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<RepoPicker onAdd={onAdd} onClone={vi.fn()} onClose={() => {}} />);
    await screen.findByText('git-repo');

    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: ` ${OTHER_DRIVE.path} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await screen.findByText(OTHER_DRIVE.path);
    expect(mockBrowseDirs).toHaveBeenLastCalledWith(OTHER_DRIVE.path);

    fireEvent.click(screen.getByRole('button', { name: /add this repo/i }));
    expect(onAdd).toHaveBeenCalledWith(OTHER_DRIVE.path);
  });

  test('a typed path the hub refuses shows the error and keeps the current folder; the next successful move clears it', async () => {
    install();
    render(<RepoPicker onAdd={vi.fn()} onClone={vi.fn()} onClose={() => {}} />);
    await screen.findByText('git-repo');

    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open that folder');
    expect(screen.getByText('/root')).toBeInTheDocument();

    fireEvent.click(screen.getByText('plain'));
    await screen.findByText('/root/plain');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('T-96 Escape dismisses the picker', async () => {
    install();
    const onClose = vi.fn();
    render(<RepoPicker onAdd={vi.fn()} onClone={vi.fn()} onClose={onClose} />);
    await screen.findByText('git-repo');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

test('a folder that is not a git repository says why Add is disabled', async () => {
  install();
  render(<RepoPicker onAdd={vi.fn()} onClone={vi.fn()} onClose={() => {}} />);
  fireEvent.click(await screen.findByText('plain'));
  expect(await screen.findByText(/This folder is not a git repository/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add this repo' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Parent directory' }));
  fireEvent.click(await screen.findByText('git-repo'));
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Add this repo' })).toBeEnabled());
  expect(screen.queryByText(/This folder is not a git repository/)).toBeNull();
});

test('Clone: a URL with a space or a folder name with a path in it disables the button and says why', async () => {
  install();
  render(<RepoPicker onAdd={vi.fn()} onClone={vi.fn()} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Clone repository' }));
  const url = await screen.findByLabelText('Repository URL');
  const button = screen.getByRole('button', { name: 'Clone & add' });
  await screen.findByText(/Clone into: \/root/);
  fireEvent.change(url, { target: { value: 'abc def' } });
  expect(button).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/no spaces/);
  fireEvent.change(url, { target: { value: 'https://github.com/o/r' } });
  expect(button).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: '../../x' } });
  expect(button).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/folder name/i);
});
