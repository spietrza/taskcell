import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QuickView, waitingWhy, type QuickTask } from './QuickView';
import type { NeedsYouItem, RunDetail, RunSummary } from '../../wire';

vi.mock('../../ipc', () => ({
  callerCapabilities: vi.fn(async () => ({ mutationsAllowed: true, owner: true, admin: true, canAddProject: { allowed: true }, teamRoles: {} })),
  listRuns: vi.fn(),
  readRun: vi.fn(),
  listNeedsYou: vi.fn(),
  needsYouComment: vi.fn(async () => ({})),
  replyNeedsYou: vi.fn(),
  mergeNeedsYou: vi.fn(),
  apiListSkills: vi.fn(async () => ({ skills: ['db', 'release'] })),
  apiSetTaskSkills: vi.fn(async (_repo: string, _id: string, skills: string[]) => ({ skills })),
  readAppConfigStrict: vi.fn(async () => ({})),
  hubTaskStart: vi.fn(async (_repo: string, id: string) => ({ id })),
  fetchSpec: vi.fn(async () => 'The issue body.'),
}));
import { hubTaskStart, apiListSkills, apiSetTaskSkills, listNeedsYou, needsYouComment, listRuns, readAppConfigStrict, readRun } from '../../ipc';

const PR = 'https://github.com/o/r/pull/9';
const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({ id: 'o/r#9', kind: 'pr', number: 9, repoSlug: 'o/r', title: 'T', url: PR, reason: 'taskcell:needs-human-review', baseRef: 'main', ...over });
const summary: RunSummary = { taskId: 'gh-7', timestamp: 'ts', stages: ['implementer'], totalCostUsd: 1.5, anyFailed: false, prUrl: PR };
const detail: RunDetail = { taskId: 'gh-7', timestamp: 'ts', prUrl: PR, stages: [{ record: { stage: 'reviewer', verdict: 'pass' } as never }] };
// The hub's answer rides on the card: its place, its newest run and the item that waits on the person.
const task: QuickTask = { id: 'gh-7', title: 'Seven', column: 'review', state: 'review', source: 'github', url: 'https://github.com/o/r/issues/7', view: { place: { at: 5, failed: false }, waiting: item({}) } };
const open = (t: QuickTask = task): ReturnType<typeof render> => render(<QuickView task={t} project="/repo" onClose={() => {}} onFullPage={() => {}} />);

beforeEach(() => {
  window.__TASKCELL_HUB__ = true;
  vi.mocked(listRuns).mockResolvedValue([summary]);
  vi.mocked(readRun).mockResolvedValue(detail);
  vi.mocked(listNeedsYou).mockResolvedValue({ items: [item({})] });
});

describe('QuickView', () => {
  test('the opened item\'s last comment is fetched, as the list carries none', async () => {
    vi.mocked(needsYouComment).mockResolvedValueOnce({ lastComment: { author: 'bot', body: 'Which branch?' } });
    open();
    expect(await screen.findByText('Which branch?')).toBeInTheDocument();
    expect(needsYouComment).toHaveBeenCalledWith('/repo', 'o/r#9', 'pr');
  });

  test('says it could not check when the hub could not read what waits', async () => {
    open({ ...task, view: { place: { at: 5, failed: false }, waitingUnchecked: true } });
    expect(await screen.findByText('Could not check whether this card waits for you.')).toBeInTheDocument();
  });

  test('a delivered card whose run stopped to ask: Done with the Board\'s warning, the stop station marked, the run "stopped to ask"', async () => {
    vi.mocked(listRuns).mockResolvedValue([{ ...summary, taskId: 'hub-4', anyFailed: true, asked: 'Which file?', prUrl: undefined } as RunSummary]);
    vi.mocked(listNeedsYou).mockResolvedValue({ items: [] });
    open({ id: 'hub-4', title: 'Validate', column: 'done', state: 'done', chips: [{ key: 'warning', label: 'delivered, but a stage failed (see Runs)', tone: 'changes' }], view: { place: { at: 6, failed: false }, run: { state: 'stopped to ask', place: { at: 2, failed: true }, timestamp: 'ts' } } });
    expect(await screen.findByText('Done · delivered, but a stage failed (see Runs)')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('list', { name: 'Stage line' }).querySelector('[data-status="failed"]')).not.toBeNull());
    expect([...screen.getByRole('list', { name: 'Stage line' }).querySelectorAll('li')].map((l) => l.getAttribute('data-status'))).toEqual(['done', 'done', 'failed', 'done', 'done', 'done']);
    expect(await screen.findByText('stopped to ask')).toBeInTheDocument();
  });

  test('a queued-column card says "Queued" only when the factory has it queued, else "Not started"', () => {
    const { unmount } = open({ ...task, column: 'queued' });
    expect(screen.getByText('Not started')).toHaveAttribute('data-column', 'queued');
    unmount();
    open({ ...task, column: 'queued', waiting: true });
    expect(screen.getByText('Queued')).toHaveAttribute('data-column', 'queued');
  });

  test('a tracker comment is plain text: markdown images and links stay literal', async () => {
    const body = 'see ![x](http://evil/img) and [a](javascript:alert(1))';
    vi.mocked(listNeedsYou).mockResolvedValue({ items: [item({ kind: 'issue', id: 'o/r#7', number: 7, url: 'https://github.com/o/r/issues/7', lastComment: { author: 'someone', body } })] });
    const { container } = open({ ...task, column: 'queued', view: { place: { at: 0, failed: false }, waiting: item({ kind: 'issue', id: 'o/r#7', number: 7, url: 'https://github.com/o/r/issues/7', lastComment: { author: 'someone', body } }) } });
    expect(await screen.findByText(body)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  test('a card whose run stopped to ask says "Waiting for your answer" as needs you, not "Verify failed"', async () => {
    open({ id: 'hub-4', title: 'Validate', column: 'verify-failed', state: 'failed', asked: true });
    const chip = await screen.findByText('Waiting for your answer');
    expect(chip.className).toContain('text-primary-text');
    expect(screen.queryByText('Verify failed')).toBeNull();
    // Answering is the way on: no Start run beside it.
    expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull();
  });

  test('shows the stage line, the receipt with missing facts, the issue link on the id and the pull request link', async () => {
    open();
    const receipt = await screen.findByLabelText('Receipt');
    expect(within(receipt).getByText('Second-AI review').nextSibling).toHaveTextContent('passed');
    expect(within(receipt).getByText('Tests').nextSibling).toHaveTextContent('not recorded');
    expect(within(receipt).getByText('Cost').nextSibling).toHaveTextContent('$1.50');
    const steps = within(screen.getByRole('list', { name: 'Stage line' })).getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-status'))).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
    expect(screen.getByRole('link', { name: 'gh-7' })).toHaveAttribute('href', 'https://github.com/o/r/issues/7');
    expect(screen.getAllByRole('link', { name: 'PR #9' }).map((a) => a.getAttribute('href'))).toEqual([PR]);
    expect(steps[5]).toHaveTextContent('you sign off');
    expect(steps[4]).toHaveTextContent('passed');
  });

  test('a queued card: Start run, the Line config under waiting stations, the description and no runs', async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    vi.mocked(readAppConfigStrict).mockResolvedValueOnce({ verifyCmd: 'pnpm verify', reviewProvider: 'codex' });
    const onStartRun = vi.fn();
    render(<QuickView task={{ ...task, column: 'queued', waiting: true, view: { place: { at: 0, failed: false } } }} project="/repo" onClose={() => {}} onFullPage={() => {}} onStartRun={onStartRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(onStartRun).toHaveBeenCalled();
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
    expect(await screen.findByText('The issue body.')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Stage line' })).getAllByRole('listitem');
    await vi.waitFor(() => expect(steps[3]).toHaveTextContent('pnpm verify · secret scan'));
    expect(steps[0]).toHaveTextContent('waiting for a cell');
    expect(steps[4]).toHaveTextContent('engine codex');
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
  });

  test('a running card shows its live state and the way to the run, not Start run', async () => {
    const onOpenRuns = vi.fn();
    render(<QuickView task={{ ...task, column: 'running', stage: 'implementer' }} project="/repo" onClose={() => {}} onFullPage={() => {}} onStartRun={() => {}} onOpenRuns={onOpenRuns} />);
    expect(screen.getByRole('status')).toHaveTextContent('Running · implementer');
    expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open the run' }));
    expect(onOpenRuns).toHaveBeenCalled();
  });

  test('the run history lists every run of the card, newest first', async () => {
    vi.mocked(listRuns).mockResolvedValue([summary, { ...summary, timestamp: 'old', anyFailed: true, prUrl: undefined }, { ...summary, taskId: 'gh-8' }]);
    open();
    const activity = await screen.findByRole('region', { name: 'Activity' });
    expect(within(activity).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Run passed'), expect.stringContaining('Run failed')]);
  });

  test('a waiting pull request shows why, Reply and Merge (matched by its address)', async () => {
    open();
    expect(await screen.findByText(/Waiting for you · Pull request ready/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeInTheDocument();
    expect(screen.getByLabelText('reply to o/r#9')).toBeInTheDocument();
  });

  test('a card with no runs shows no receipt', async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    open({ ...task, column: 'running', stage: 'implementer' });
    await screen.findByText('No runs yet.');
    expect(screen.queryByLabelText('Receipt')).not.toBeInTheDocument();
  });
});

test('a paused pull request card offers no issue-only actions', async () => {
  open({ ...task, id: 'gh-pr-12', url: PR, paused: { reason: 'provider-limit' } });
  expect(await screen.findByText('Paused: provider limit')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Full page' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  expect(screen.queryByText(/skills/i)).toBeNull();
});

describe('QuickView start and header', () => {
  const queued: QuickTask = { ...task, column: 'queued', waiting: true };
  test('a hub card calls hub_task_start, shows Starting and reloads the board', async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    const onStartRun = vi.fn();
    const onChanged = vi.fn();
    render(<QuickView task={{ id: 'hub-3', title: 'H', column: 'queued', state: 'queued' }} project="/repo" onClose={() => {}} onFullPage={() => {}} onStartRun={onStartRun} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(hubTaskStart).toHaveBeenCalledWith('/repo', 'hub-3');
    expect(onStartRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'hub-3' })).toBeNull();
  });
  test('a hub start error is shown', async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    vi.mocked(hubTaskStart).mockRejectedValueOnce(new Error('nope'));
    render(<QuickView task={{ id: 'hub-3', title: 'H', column: 'queued', state: 'queued' }} project="/repo" onClose={() => {}} onFullPage={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
  test('a GitHub card opens the form, its id is the issue link and the header has no Open in GitHub', async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    const onStartRun = vi.fn();
    render(<QuickView task={queued} project="/repo" onClose={() => {}} onFullPage={() => {}} onStartRun={onStartRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(onStartRun).toHaveBeenCalled();
    expect(hubTaskStart).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'gh-7' })).toHaveAttribute('href', 'https://github.com/o/r/issues/7');
    expect(within(screen.getByRole('banner')).queryByText('Open in GitHub')).toBeNull();
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
  });
});

describe('QuickView skills', () => {
  test('the card shows its skills ticked; Save writes the new choice to the task', async () => {
    const onSkillsSaved = vi.fn();
    render(<QuickView task={{ ...task, skills: ['db'] }} project="/repo" onClose={() => {}} onFullPage={() => {}} onSkillsSaved={onSkillsSaved} />);
    const section = await screen.findByRole('region', { name: 'Skills' });
    expect(await within(section).findByLabelText('db')).toBeChecked();
    expect(within(section).queryByRole('button', { name: 'Save skills' })).not.toBeInTheDocument();
    fireEvent.click(within(section).getByLabelText('release'));
    fireEvent.click(within(section).getByLabelText('db'));
    fireEvent.click(within(section).getByRole('button', { name: 'Save skills' }));
    await vi.waitFor(() => expect(onSkillsSaved).toHaveBeenCalledWith(['release']));
    expect(apiSetTaskSkills).toHaveBeenCalledWith('/repo', 'gh-7', ['release']);
  });

  test('a refused save and an unreadable skill list both say why', async () => {
    vi.mocked(apiListSkills).mockRejectedValueOnce(new Error('Skills cannot be listed: ENOENT /skills'));
    vi.mocked(apiSetTaskSkills).mockRejectedValueOnce(new Error('gh: not signed in'));
    render(<QuickView task={{ ...task, skills: ['db'] }} project="/repo" onClose={() => {}} onFullPage={() => {}} />);
    const section = await screen.findByRole('region', { name: 'Skills' });
    expect(await within(section).findByRole('status')).toHaveTextContent('ENOENT /skills');
    fireEvent.click(within(section).getByLabelText('db'));
    fireEvent.click(within(section).getByRole('button', { name: 'Save skills' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('gh: not signed in');
  });

  test('a hub-board card has a skills section; Save writes to its hub task', async () => {
    const { source: _source, ...hubCard } = task;
    render(<QuickView task={{ ...hubCard, id: 'hub-3', skills: ['db'] }} project="/repo" onClose={() => {}} onFullPage={() => {}} />);
    const section = await screen.findByRole('region', { name: 'Skills' });
    fireEvent.click(await within(section).findByLabelText('release'));
    fireEvent.click(within(section).getByRole('button', { name: 'Save skills' }));
    await vi.waitFor(() => expect(apiSetTaskSkills).toHaveBeenCalledWith('/repo', 'hub-3', ['db', 'release']));
  });
  test('the invalid-entries card explains itself and offers neither Schedule nor Full page', async () => {
    const { source: _source, ...hubCard } = task;
    const reason = '2 entries of this board\'s task store are not a valid task; kept in the file, never run';
    render(<QuickView task={{ ...hubCard, id: 'hub-invalid', schedule: { state: 'invalid', reason, label: `cannot start: ${reason}` } }} project="/repo" onClose={() => {}} onFullPage={() => {}} onChanged={() => {}} />);
    expect(await screen.findByText(/not a valid task/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save schedule' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Full page/ })).toBeNull();
  });
  test('no installed skill is one quiet line with the way to Settings → Skills', async () => {
    vi.mocked(apiListSkills).mockResolvedValueOnce({ skills: [] });
    const onOpenSkills = vi.fn();
    render(<QuickView task={task} project="/repo" onClose={() => {}} onFullPage={() => {}} onOpenSkills={onOpenSkills} />);
    const section = await screen.findByRole('region', { name: 'Skills' });
    expect(await within(section).findByText(/None installed/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Settings → Skills' }));
    expect(onOpenSkills).toHaveBeenCalled();
  });
  test('a card of no tracker has no skills section', async () => {
    const { source: _source, ...draft } = task;
    open(draft);
    await screen.findByRole('list', { name: 'Stage line' });
    expect(screen.queryByRole('region', { name: 'Skills' })).not.toBeInTheDocument();
  });
});

describe('waitingWhy', () => {
  test('plain words', () => {
    expect(waitingWhy({ kind: 'pr' })).toBe('Pull request ready');
    expect(waitingWhy({ kind: 'issue' })).toBe('Question for you');
  });
});
