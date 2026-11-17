import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LineEditor } from './LineEditor';
import { Settings } from '../settings/Settings';
import { NavGuardContext, createNavGuardRegistry, useDiscardGuard } from '../../navGuard';
import * as ipc from '../../ipc';
import { asCode } from './asCode';
import { STATIONS, STATION_SHORT } from '../../stations';

vi.mock('../../ipc.js', () => ({
  readAppConfigStrict: vi.fn(async () => ({})),
  writeAppConfig: vi.fn(async () => {}),
  callerCapabilities: vi.fn(async () => ({})),
  apiCapabilitiesCached: vi.fn(async () => ({ flows: [{ name: 'plan' }] })),
  apiListFlows: vi.fn(async () => ({ flows: [] })),
  readSettingsHistory: vi.fn(async () => []),
}));
vi.mock('../settings/AutoMerge', () => ({ AutoMerge: () => <div>auto-merge panel</div> }));
vi.mock('../settings/CredentialsPanel', async (importOriginal) => ({ ...(await importOriginal<typeof import('../settings/CredentialsPanel')>()), CredentialsPanel: () => null }));
vi.mock('../workflow/WorkflowEditor', () => ({
  // A second dirty editor on the same screen, like the real flow draft.
  WorkflowEditor: () => {
    useDiscardGuard(true, () => window.confirm('Discard unsaved flow?'));
    return <div>flow editor</div>;
  },
}));

const read = vi.mocked(ipc.readAppConfigStrict);
const write = vi.mocked(ipc.writeAppConfig);
const history = vi.mocked(ipc.readSettingsHistory);

beforeEach(() => {
  write.mockClear();
  read.mockResolvedValue({});
});

const open = async (cfg: Record<string, unknown> = {}) => {
  read.mockResolvedValueOnce(cfg);
  const registry = createNavGuardRegistry();
  const view = render(
    <NavGuardContext.Provider value={registry}>
      <LineEditor project="/repo" />
    </NavGuardContext.Provider>,
  );
  await screen.findByRole('group', { name: 'Stations' });
  return { registry, ...view };
};

test('six stations in order; clicking one opens its editor', async () => {
  await open();
  const buttons = screen.getAllByRole('button', { pressed: undefined }).filter((b) => b.hasAttribute('aria-pressed'));
  expect(buttons.map((b) => STATIONS.find((s) => b.textContent?.includes(STATION_SHORT[s]))!)).toEqual([...STATIONS]);
  expect(screen.getByPlaceholderText('pnpm typecheck && pnpm test')).toBeInTheDocument(); // Gates is open by default
  fireEvent.click(screen.getByRole('button', { name: /Cell/ }));
  expect(screen.getByPlaceholderText('No cap')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Cell/ })).toHaveAttribute('aria-pressed', 'true');
});

test('editing Gates and pressing Publish writes the whole config; Discard puts it back', async () => {
  await open({ label: 'go', color: '#123456' });
  fireEvent.change(screen.getByPlaceholderText('pnpm typecheck && pnpm test'), { target: { value: 'pnpm verify' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(screen.getByPlaceholderText('pnpm typecheck && pnpm test')).toHaveValue('');
  fireEvent.change(screen.getByPlaceholderText('pnpm typecheck && pnpm test'), { target: { value: 'pnpm verify' } });
  history.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  await waitFor(() => expect(write).toHaveBeenCalledWith('/repo', { label: 'go', color: '#123456', verifyCmd: 'pnpm verify' }));
  await waitFor(() => expect(history).toHaveBeenCalled()); // history re-reads after a publish
});

test('the locked rows have no input and the CLI-only facts are plain text', async () => {
  await open();
  const row = screen.getByText('Secret scan').closest('div')!.parentElement!;
  expect(row.querySelector('input,select,button')).toBeNull();
  expect(screen.getByText('dropped')).toBeInTheDocument();
  expect(screen.getByText(/--escalate-model/)).toBeInTheDocument();
});

test('what Publish writes is the config, masked', async () => {
  await open({ label: 'go', customProviders: [{ name: 'p', baseUrl: 'https://a:b@x.example.com/v1', keyEnv: 'K' }] });
  const text = screen.getByRole('region', { name: 'What Publish writes' }).textContent ?? '';
  expect(text).toContain('"label": "go"');
  expect(text).not.toContain('a:b');
  expect(asCode({ label: 'go' })).toBe(JSON.stringify({ label: 'go' }, null, 2));
});

test('PR holds the auto-merge panel; Custom flows holds the flow picker and the editor', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: /PR/ }));
  expect(screen.getByText('auto-merge panel')).toBeInTheDocument();
  expect(screen.getByText('flow editor')).toBeInTheDocument();
  expect(screen.getByText('Custom flows (advanced)')).toBeInTheDocument();
});

test('a blocked publish names General', async () => {
  await open({ concurrency: 0 });
  fireEvent.change(screen.getByPlaceholderText('pnpm typecheck && pnpm test'), { target: { value: 'x' } });
  expect(screen.getByRole('alert')).toHaveTextContent('fix concurrency in General');
  expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
});

test('both dirty editors (app.json and flow draft) are confirmed on navigation', async () => {
  const { registry } = await open();
  fireEvent.change(screen.getByPlaceholderText('pnpm typecheck && pnpm test'), { target: { value: 'x' } });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  expect(registry.confirm()).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);
  expect(registry.confirm()).toBe(false);
  confirm.mockRestore();
});

// Guard for the "nothing lost" rule: General and Line together edit every field the old General form did.
test('every field the old General form edited is still editable in General or Line', async () => {
  read.mockResolvedValue({ taskSource: 'linear' });
  const general = render(<Settings project="/repo" />);
  await screen.findByPlaceholderText('claude-sonnet-5');
  const generalText = general.container.textContent ?? '';
  general.unmount();
  await open({ taskSource: 'linear' });
  const rendered = new Set<string>();
  for (const s of STATIONS) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(STATION_SHORT[s]) }));
    document.body.querySelectorAll('label').forEach((l) => rendered.add(l.textContent ?? ''));
  }
  const all = [generalText, ...rendered].join('|');
  for (const label of ['Task source', 'Runs on', 'Linear team key', 'Parallel runs', 'Usage cap %', 'Doc chat model', 'Project color', 'Trigger label', 'Engine', 'Budget cap per run', 'Verify command', 'Review engine', 'Default target branch', 'Runs with flow']) {
    expect(all).toContain(label);
  }
});

test('history shows the token-auth placeholder as "you (local hub)"', async () => {
  history.mockResolvedValueOnce([{ time: '2026-11-17T10:00:00Z', login: 'token', outcome: 'ok', target: '/repo', detail: ['label'] }]);
  await open();
  expect(await screen.findByText('you (local hub)')).toBeInTheDocument();
  expect(screen.queryByText('token')).toBeNull();
});
