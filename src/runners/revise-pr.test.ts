import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { WorktreeManager } from '../worktree/manager.js';
import { runRevisePullRequest } from './revise-pr.js';
import { revisionCapMarker, revisionMarker } from './pr-feedback.js';
import * as registry from '../agents/registry.js';
import { selectAgents } from '../agents/registry.js';
import { AgentError } from '../core/errors.js';
import { gateConfigChangedBlock } from '../context/gate-config.js';
import { prBodyGapWarningBlock } from '../pipeline/conformance-gate.js';
import type { GhRunner } from '../tasks/github.js';
import type { IsolatedSandboxProvider, ExecResult, SandboxConfig } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

// Pass-through spy, so a test can assert the argv of a git call the runner makes on the host.
vi.mock('execa', async (importActual) => {
  const actual = await importActual<typeof import('execa')>();
  return { ...actual, execa: vi.fn(actual.execa) };
});

const dockerSandboxConfigs = vi.hoisted(() => [] as SandboxConfig[]);

vi.mock('../sandbox/docker.js', () => ({
  DockerSandboxProvider: class {
    readonly id = 'fake-docker';

    constructor(config: SandboxConfig = {}) {
      dockerSandboxConfigs.push(config);
    }

    start = async (): Promise<void> => {};
    exec = async (command: string): Promise<ExecResult> =>
      command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 };
    execStream = (): ReturnType<IsolatedSandboxProvider['execStream']> => ({
      stdout: (async function* (): AsyncIterable<string> {})(),
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    });
    copyIn = async (): Promise<void> => {};
    copyFileOut = async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace') {
        await mkdir(hostPath, { recursive: true });
        await writeFile(join(hostPath, 'fix.txt'), 'fix applied');
      }
    };
    exists = async (): Promise<boolean> => true;
    destroy = async (): Promise<void> => {};
    shellCommand = (): string => 'docker exec -it vg-fake bash';
  },
  sandboxImage: (): string => 'vanguard-sandbox:latest',
}));

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-revise-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# project');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
  // Create a branch representing the PR head
  await execa('git', ['checkout', '-b', 'feature-branch'], { cwd: repo });
  await execa('git', ['checkout', 'main'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeSandbox(fixContent = 'fix applied'): IsolatedSandboxProvider {
  return {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> =>
      command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
    execStream: () => ({
      stdout: (async function* (): AsyncIterable<string> {})(),
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace') {
        await mkdir(hostPath, { recursive: true });
        // Agent writes a file in the sandbox → synced to worktree
        await writeFile(join(hostPath, 'fix.txt'), fixContent);
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

function agentThatCompletes(received: AgentRunInput[], name = 'claude-code'): AgentProvider {
  return {
    name,
    async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      received.push(input);
      yield { text: 'applying fix' };
      return { finalText: 'done <promise>COMPLETE</promise>', turns: 1, sessionId: 'sess-1' };
    },
  };
}

/** gh mock answering every call a full revise round makes (view, diff, feedback, thread replies, comment, ready, labels). */
function makeGh(): GhRunner {
  return async (args) => {
    if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
    if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find((a) => a.startsWith('query=')) ?? '';
      if (query.includes('reviewThreads')) return makeFeedbackJson();
      if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
      if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
    }
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    if (args[0] === 'pr' && args[1] === 'ready') return '';
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

function makePrViewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    title: 'Fix auth',
    body: 'Adds guard.',
    url: 'https://github.com/o/r/pull/7',
    author: { login: 'SebaBoler' },
    headRefName: 'feature-branch',
    headRefOid: 'deadbeef',
    baseRefName: 'main',
    ...overrides,
  });
}

function makeFeedbackJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          isDraft: true,
          headRefOid: 'deadbeef',
          commits: { nodes: [{ commit: { committedDate: '2024-01-10T08:00:00Z' } }] },
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      author: { login: 'alice' }, authorAssociation: 'COLLABORATOR',
                      body: 'Please rename this.',
                      createdAt: '2024-01-11T10:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
          reviews: { nodes: [] },
          comments: { nodes: [] },
          ...overrides,
        },
      },
    },
  });
}

function makeFeedbackJsonWithRevisions(): string {
  // Two distinct revision markers simulate 2 prior rounds for countRevisionRounds.
  // selectActionableFeedback drops them via hasRevisionMarker; countRevisionRounds counts them.
  return makeFeedbackJson({
    comments: {
      nodes: [
        { author: { login: 'github-actions' }, body: '<!-- vanguard-revision: deadbeef -->', createdAt: '2024-01-09T00:00:00Z' },
        { author: { login: 'github-actions' }, body: '<!-- vanguard-revision: abc1234 -->', createdAt: '2024-01-09T00:00:01Z' },
      ],
    },
  });
}

function makeFeedbackJsonCapReset(): string {
  // Two prior rounds plus a cap notice, all from the bot, posted BEFORE the default thread's
  // trusted-human comment (alice/COLLABORATOR @ 2024-01-11T10:00:00Z, from makeFeedbackJson) — that
  // comment is both the actionable feedback for this round and the fresh human ask that resets the
  // budget: revisionBudgetResetAt should find it after the cap notice and countRevisionRoundsFromFeedback
  // should drop both prior markers.
  return makeFeedbackJson({
    reviews: { nodes: [
      {
        author: { login: 'github-actions' },
        body: `Revision cap reached (2/2 rounds). No further automated revisions will be applied.\n\n${revisionCapMarker()}`,
        state: 'COMMENTED',
        submittedAt: '2024-01-09T00:00:02Z',
      },
    ] },
    comments: { nodes: [
      { author: { login: 'github-actions' }, body: revisionMarker('deadbeef'), createdAt: '2024-01-09T00:00:00Z' },
      { author: { login: 'github-actions' }, body: revisionMarker('abc1234'), createdAt: '2024-01-09T00:00:01Z' },
    ] },
  });
}

function makeFeedbackJsonCapStillHeld(): string {
  // Same two prior rounds, but the cap notice is posted AFTER the (sole) trusted-human comment —
  // i.e. nothing trusted-human followed the notice. A bot/automated re-label alone must not reset
  // the budget.
  return makeFeedbackJson({
    reviews: { nodes: [
      {
        author: { login: 'github-actions' },
        body: `Revision cap reached (2/2 rounds). No further automated revisions will be applied.\n\n${revisionCapMarker()}`,
        state: 'COMMENTED',
        submittedAt: '2024-01-12T00:00:00Z',
      },
    ] },
    comments: { nodes: [
      { author: { login: 'github-actions' }, body: revisionMarker('deadbeef'), createdAt: '2024-01-09T00:00:00Z' },
      { author: { login: 'github-actions' }, body: revisionMarker('abc1234'), createdAt: '2024-01-09T00:00:01Z' },
    ] },
  });
}

function makeFeedbackJsonWithNonThreadItems(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          isDraft: true,
          headRefOid: 'deadbeef',
          commits: { nodes: [{ commit: { committedDate: '2024-01-10T08:00:00Z' } }] },
          reviewThreads: { nodes: [] },
          reviews: {
            nodes: [
              {
                author: { login: 'alice' }, authorAssociation: 'COLLABORATOR',
                body: 'Overall LGTM but please address the naming.',
                state: 'COMMENTED',
                submittedAt: '2024-01-11T10:00:00Z',
              },
            ],
          },
          comments: {
            nodes: [
              {
                author: { login: 'bob' }, authorAssociation: 'COLLABORATOR',
                body: 'Can you add a test?',
                createdAt: '2024-01-11T10:01:00Z',
              },
            ],
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runRevisePullRequest secret gate', () => {
  it('blocks the push when the revision diff carries a secret — no commit, masked comment, labels handed back, no undraft', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        return JSON.stringify({ data: {} });
      }
      return '';
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    try {
      const result = await runRevisePullRequest('7', {
        repoPath: repo,
        repoSlug: 'o/r',
        gh,
        _sandbox: makeSandbox('token = "ghp_' + 'A'.repeat(40) + '"\n'),
        _agent: agentThatCompletes([]),
        _worktrees: new WorktreeManager(repo),
        _pushRunner: async (_f, a) => { pushCalls.push(a); return ''; },
        _baseBranch: 'feature-branch',
        provider: 'claude',
      });
      expect(result.secretBlocked).toBe(true);
      expect(result.committed).toBe(false);
      expect(result.pushed).toBe(false);
      expect(result.addressed).toBeGreaterThan(0); // items abandoned, not "nothing actionable"
    } finally {
      spy.mockRestore();
    }
    expect(pushCalls).toEqual([]);
    // The blocked round still leaves a run record (cost trace), but no .diff / .bundle: the diff holds the secret.
    const recordFiles = await readdir(join(repo, '.taskcell', 'runs'), { recursive: true });
    expect(recordFiles.some((f) => f.endsWith('.json'))).toBe(true);
    expect(recordFiles.some((f) => f.endsWith('.diff') || f.endsWith('.bundle'))).toBe(false);
    // Ordering pin: no branch anywhere in the repo moved past the initial commit — the gate ran before commitStage.
    const mainSha = (await execa('git', ['rev-parse', 'main'], { cwd: repo })).stdout;
    const refs = (await execa('git', ['for-each-ref', '--format=%(objectname)', 'refs/heads'], { cwd: repo })).stdout.split('\n');
    expect(refs.every((sha) => sha === mainSha)).toBe(true);
    // Visible: a masked comment went to the PR and the routing labels were handed back; no undraft.
    const comment = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'comment');
    expect(comment?.join(' ')).toMatch(/secret/i);
    expect(comment?.join(' ')).not.toContain('ghp_' + 'A'.repeat(40));
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--remove-label'))).toBe(true);
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'ready')).toBe(false);
    // The operator sees the finding masked, never the raw token.
    expect(errors.join('\n')).toMatch(/secret scan blocked revise push for o\/r#7:.*fix\.txt \[github-token\]/);
    expect(errors.join('\n')).not.toContain('ghp_' + 'A'.repeat(40));
    expect(comment?.join(' ')).toMatch(/Nothing was pushed to this branch/);
    expect(comment?.join(' ')).not.toContain('No PR was opened');
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--add-label') && a.includes('vanguard:secret-blocked'))).toBe(true);
  });

  it('--out: a secret in the revision diff is reported but the dry-run touches neither the PR nor the labels and writes no preview', async () => {
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        return JSON.stringify({ data: {} });
      }
      return '';
    };
    const out = join(repo, 'preview.md');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runRevisePullRequest('7', {
        repoPath: repo, repoSlug: 'o/r', gh, out,
        _sandbox: makeSandbox('token = "ghp_' + 'A'.repeat(40) + '"\n'),
        _agent: agentThatCompletes([]), _worktrees: new WorktreeManager(repo), _pushRunner: async () => '', _baseBranch: 'feature-branch', provider: 'claude',
      });
      expect(result.secretBlocked).toBe(true);
      expect(result.dryRunOut).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(out)).toBe(false);
    expect(ghCalls.some((a) => a[0] === 'pr' && (a[1] === 'comment' || a[1] === 'edit' || a[1] === 'ready'))).toBe(false);
    expect(ghCalls.some((a) => a[0] === 'label')).toBe(false);
  });
});

describe('runRevisePullRequest happy path', () => {
  it.each([
    { name: 'T11: applies only trusted feedback in a mixed round', feedbackAuthors: undefined },
    { name: 'T12: an explicit allowlist promotes outsider feedback end to end', feedbackAuthors: ['ALICE'] },
  ])('$name', async ({ feedbackAuthors }) => {
    const ghCalls: string[][] = [];
    const pushCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const agentInputs: AgentRunInput[] = [];
    const logs: string[] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      // pr view for fetchPullRequestForReview
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.some((a) => a.includes('headRefName'))) {
        return makePrViewJson();
      }
      // pr diff
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      // graphql (feedback query or mutations)
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads') && feedbackAuthors !== undefined) return makeFeedbackJson().replaceAll('COLLABORATOR', 'NONE');
        if (query.includes('reviewThreads')) return makeFeedbackJson({ comments: { nodes: [
          { author: { login: 'mallory' }, authorAssociation: 'NONE', body: 'outsider instructions', createdAt: '2024-01-11T10:00:00Z' },
          { author: { login: 'mallory' }, authorAssociation: 'NONE', body: 'another outsider request', createdAt: '2024-01-11T10:01:00Z' },
        ] } });
        // reply mutation
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        // resolve mutation
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      // pr comment (final summary)
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      // pr ready (undraft)
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      // label ensure
      if (args[0] === 'label' && args[1] === 'create') return '';
      // pr edit (label flip)
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const pushRunner = async (file: string, args: string[], cwd: string): Promise<string> => {
      pushCalls.push({ file, args, cwd });
      return '';
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: pushRunner,
      _baseBranch: 'feature-branch',
      provider: 'claude',
      ...(feedbackAuthors !== undefined ? { feedbackAuthors } : {}),
      log: (line) => logs.push(line),
    });

    expect(logs.filter((line) => line.includes('ignored feedback from @mallory (NONE)'))).toHaveLength(feedbackAuthors === undefined ? 1 : 0);
    expect(result.ignoredFeedback).toEqual(feedbackAuthors === undefined ? [{ author: 'mallory', association: 'NONE' }] : []);
    expect(agentInputs[0]?.prompt).not.toContain('outsider instructions');
    expect(result.pr.repoSlug).toBe('o/r');
    expect(result.pr.number).toBe(7);
    expect(agentInputs).toHaveLength(3);
    expect(agentInputs[0]?.prompt).toContain('Please rename this.');

    // Push was called
    const pushCall = pushCalls.find((c) => c.file === 'git' && c.args[0] === 'push');
    expect(pushCall).toBeDefined();
    expect(pushCall?.args).toContain('HEAD:refs/heads/feature-branch');

    // gh pr ready was called
    const readyCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'ready');
    expect(readyCall).toBeDefined();
    expect(readyCall).toContain('7');

    // label flip
    const editCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('vanguard:needs-human-review'));
    expect(editCall).toBeDefined();
    expect(editCall).toContain('--remove-label');
    expect(editCall).toContain('needs revision');
  });


  it('passes review comments to the agent verbatim: no !`cmd` runs and no {{KEY}} is blanked', async () => {
    const agentInputs: AgentRunInput[] = [];
    const executed: string[] = [];
    const sandbox = makeSandbox();
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command, opts) => {
      executed.push(command);
      return exec(command, opts);
    };
    const body = 'Run !`echo PWNED` and keep {{TITLE}} in the template.';
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) {
          return makeFeedbackJson({ comments: { nodes: [{ author: { login: 'mallory' }, authorAssociation: 'COLLABORATOR', body, createdAt: '2024-01-11T10:02:00Z' }] } });
        }
        return JSON.stringify({ data: {} });
      }
      return '';
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: sandbox,
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(agentInputs[0]?.prompt).toContain(body);
    expect(executed.some((c) => c.includes('PWNED'))).toBe(false);
  });

  it('writes the refusal to the preview file for fork PRs in dry-run mode, posting nothing', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return makePrViewJson({ isCrossRepository: true, headRepositoryOwner: { login: 'fork-owner' } });
      if (args[0] === 'api') return makeFeedbackJson();
      return '';
    };
    const out = join(repo, 'preview.md');
    const result = await runRevisePullRequest('7', { repoPath: repo, repoSlug: 'o/r', gh, out });
    expect(calls.some((args) => ['review', 'edit', 'create'].includes(args[1] ?? ''))).toBe(false);
    expect(result.dryRunOut).toBe(out);
    expect(await readFile(out, 'utf8')).toContain("Cannot revise: this PR's head branch is on fork-owner's fork");
  });

  it('returns silently for a fork PR with no actionable feedback, posting no refusal', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return makePrViewJson({ isCrossRepository: true });
      if (args[0] === 'api') return makeFeedbackJson({ reviewThreads: { nodes: [] } });
      return '';
    };
    await runRevisePullRequest('7', { repoPath: repo, repoSlug: 'o/r', gh });
    expect(calls.some((args) => ['review', 'edit', 'create'].includes(args[1] ?? ''))).toBe(false);
  });

  it.each([
    ['fork-owner', "fork-owner's fork"],
    ['', 'a fork'],
  ])('refuses fork PRs before worktree creation or push (owner: %s)', async (owner, expected) => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson({
        isCrossRepository: true, headRepositoryOwner: owner === '' ? null : { login: owner },
      });
      if (args[0] === 'api') return makeFeedbackJson();
      return '';
    };
    const wm = new WorktreeManager(repo);
    const create = vi.spyOn(wm, 'create');
    const push = vi.fn(async () => '');
    const inputs: AgentRunInput[] = [];
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, _worktrees: wm,
      _pushRunner: push, _agent: agentThatCompletes(inputs), _sandbox: makeSandbox(),
    });
    expect(result).toMatchObject({ addressed: 0, committed: false, pushed: false, undrafted: false });
    expect(create).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(inputs).toEqual([]);
    const notice = calls.find((args) => args[1] === 'review')?.join(' ') ?? '';
    expect(notice).toContain('Cannot revise:');
    expect(notice).toContain(`head branch is on ${expected}`);
    expect(calls.find((args) => args[1] === 'edit')).toContain('vanguard:needs-human-review');
  });

  it('fetches refs/heads/<head> with --end-of-options, so a dash-led head ref cannot act as a git option', async () => {
    await execa('git', ['remote', 'add', 'origin', repo], { cwd: repo });
    const featureSha = (await execa('git', ['rev-parse', 'feature-branch'], { cwd: repo })).stdout;
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson({ headRefOid: featureSha });
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        return JSON.stringify({ data: {} });
      }
      return '';
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      provider: 'claude',
    });

    expect(vi.mocked(execa)).toHaveBeenCalledWith('git', ['fetch', '--end-of-options', 'origin', 'refs/heads/feature-branch'], expect.objectContaining({ cwd: repo }));
  });

  it.each([{ headRefName: undefined }, { headRefOid: undefined }])('fails with a clear error when the PR has no head ref (%o)', async (missing) => {
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson(missing);
      if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson();
      return '';
    };

    await expect(
      runRevisePullRequest('7', {
        repoPath: repo,
        repoSlug: 'o/r',
        gh,
        _sandbox: makeSandbox(),
        _agent: agentThatCompletes([]),
        _worktrees: new WorktreeManager(repo),
        _pushRunner: async () => '',
        provider: 'claude',
      }),
    ).rejects.toThrow('PR o/r#7 has no head ref to fetch');
  });

  it('hands the labels back and comments when the start cannot be resolved, instead of leaving the PR revising', async () => {
    await execa('git', ['remote', 'add', 'origin', repo], { cwd: repo });
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      // headRefOid is not the sha of feature-branch: resolveStartRef refuses the fetched head.
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
      if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson();
      return '';
    };

    await expect(
      runRevisePullRequest('7', {
        repoPath: repo,
        repoSlug: 'o/r',
        gh,
        _sandbox: makeSandbox(),
        _agent: agentThatCompletes([]),
        _worktrees: new WorktreeManager(repo),
        _pushRunner: async () => '',
        provider: 'claude',
      }),
    ).rejects.toThrow(/expected PR head/);

    expect(calls.find((args) => args[1] === 'review')?.join(' ')).toContain('Cannot revise:');
    expect(calls.find((args) => args[1] === 'edit')).toContain('vanguard:needs-human-review');
  });

  it('revises the PR head, not main, when the head branch name starts with "+"', async () => {
    const git = (args: string[]): Promise<{ stdout: string }> => execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
    await git(['checkout', '-b', '+main']);
    await writeFile(join(repo, 'pr.txt'), 'pr head');
    await git(['add', '.']);
    await git(['commit', '-m', 'pr head']);
    const prHead = (await git(['rev-parse', 'HEAD'])).stdout;
    await git(['checkout', 'main']);
    await git(['remote', 'add', 'origin', repo]);
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson({ headRefName: '+main', headRefOid: prHead });
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        return JSON.stringify({ data: {} });
      }
      return '';
    };
    let pushedHead: string | undefined;

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (_file, args, cwd) => {
        if (args[0] === 'push') pushedHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout;
        return '';
      },
      provider: 'claude',
    });

    expect(pushedHead).toBeDefined();
    const isAncestor = await execa('git', ['merge-base', '--is-ancestor', prHead, pushedHead!], { cwd: repo, reject: false });
    expect(isAncestor.exitCode).toBe(0);
  });

  it('--out writes a dry-run preview and pushes/comments NOTHING', async () => {
    const outPath = join(tmpdir(), `vanguard-revise-out-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    const ghCalls: string[][] = [];
    const pushCalls: unknown[] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('--json') && args.some((a) => a.includes('headRefName'))) {
        return makePrViewJson();
      }
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
      }
      // Any push/comment/mutation call in dry-run is a bug — fail loudly.
      throw new Error(`unexpected gh call in dry-run: ${args.join(' ')}`);
    };
    try {
      const result = await runRevisePullRequest('7', {
        repoPath: repo,
        repoSlug: 'o/r',
        gh,
        _sandbox: makeSandbox(),
        _agent: agentThatCompletes([]),
        _worktrees: new WorktreeManager(repo),
        _pushRunner: async (...a: unknown[]) => {
          pushCalls.push(a);
          return '';
        },
        _baseBranch: 'feature-branch',
        provider: 'claude',
        out: outPath,
      });

      expect(result.dryRunOut).toBe(outPath);
      expect(result.committed).toBe(false);
      expect(result.pushed).toBe(false);
      expect(pushCalls).toHaveLength(0);
      expect(ghCalls.some((a) => a[0] === 'pr' && (a[1] === 'comment' || a[1] === 'ready' || a[1] === 'edit'))).toBe(false);

      const content = await readFile(outPath, 'utf8');
      expect(content).toContain('dry-run');
      expect(content).toContain('## Code changes');
      expect(content).toContain('## Proposed replies');
      expect(content).not.toContain('vanguard-revision');
    } finally {
      await rm(outPath, { force: true });
    }
  });
});

describe('runRevisePullRequest — VANGUARD_PUSH_TOKEN', () => {
  const ORIGINAL_TOKEN = process.env.VANGUARD_PUSH_TOKEN;

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.VANGUARD_PUSH_TOKEN;
    else process.env.VANGUARD_PUSH_TOKEN = ORIGINAL_TOKEN;
  });

  it('when set, the push env carries the extraheader override (not argv) and still targets the PR head', async () => {
    process.env.VANGUARD_PUSH_TOKEN = 'test-pat';
    const pushCalls: Array<{ file: string; args: string[]; cwd: string; env?: Record<string, string> }> = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (file, args, cwd, env) => {
        pushCalls.push({ file, args, cwd, ...(env !== undefined ? { env } : {}) });
        return '';
      },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    const b64 = Buffer.from('x-access-token:test-pat').toString('base64');
    const pushCall = pushCalls.find((c) => c.file === 'git' && c.args.includes('push'));
    expect(pushCall?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/feature-branch']);
    expect(Object.values(pushCall?.env ?? {})).toContain(`AUTHORIZATION: basic ${b64}`);
  });

  it('when unset, the push argv is unchanged (no -c prefix)', async () => {
    delete process.env.VANGUARD_PUSH_TOKEN;
    const pushCalls: Array<{ file: string; args: string[]; cwd: string; env?: Record<string, string> }> = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (file, args, cwd) => {
        pushCalls.push({ file, args, cwd });
        return '';
      },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    const pushCall = pushCalls.find((c) => c.file === 'git' && c.args[0] === 'push');
    expect(pushCall?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/feature-branch']);
  });

  it('when set, pr ready runs with GH_TOKEN set to the push token', async () => {
    process.env.VANGUARD_PUSH_TOKEN = 'test-pat';
    const readyCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const gh: GhRunner = async (args, env) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') {
        readyCalls.push({ args, ...(env !== undefined ? { env } : {}) });
        return '';
      }
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(result.undrafted).toBe(true);
    expect(readyCalls).toHaveLength(1);
    expect(readyCalls[0]?.env).toEqual({ GH_TOKEN: 'test-pat' });
  });

  it.each([`ghp_${'B'.repeat(36)}`, 'unrecognized-token-value'])('when token %s is refused, pr ready retries without leaking it', async (pat) => {
    process.env.VANGUARD_PUSH_TOKEN = pat;
    const readyCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const logs: string[] = [];
    const gh: GhRunner = async (args, env) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') {
        readyCalls.push({ args, ...(env !== undefined ? { env } : {}) });
        if (env?.GH_TOKEN !== undefined) throw new Error(`HTTP 403: Resource not accessible by personal access token ${pat}`);
        return '';
      }
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      log: (line) => logs.push(line),
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(result.undrafted).toBe(true);
    expect(readyCalls).toHaveLength(2);
    expect(readyCalls[0]?.env).toEqual({ GH_TOKEN: pat });
    expect(readyCalls[1]?.env).toBeUndefined();
    // the retry warning never carries the raw token value
    expect(logs.some((l) => l.includes('retrying with the ambient credential'))).toBe(true);
    expect(logs.join('\n')).not.toContain(pat);
  });

  it('when unset, pr ready runs with no env override', async () => {
    delete process.env.VANGUARD_PUSH_TOKEN;
    const readyCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const gh: GhRunner = async (args, env) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') {
        readyCalls.push({ args, ...(env !== undefined ? { env } : {}) });
        return '';
      }
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(result.undrafted).toBe(true);
    expect(readyCalls).toHaveLength(1);
    expect(readyCalls[0]?.env).toBeUndefined();
  });

  it('is never forwarded into the sandbox secrets map (host-only credential)', () => {
    process.env.VANGUARD_PUSH_TOKEN = 'test-pat';
    const selected = selectAgents({ provider: 'claude' }, process.env);
    expect(Object.keys(selected.secrets)).not.toContain('VANGUARD_PUSH_TOKEN');
    expect(Object.values(selected.secrets)).not.toContain('test-pat');
    expect(Object.keys(selected.proxySecrets)).not.toContain('VANGUARD_PUSH_TOKEN');
  });

  it('does not pass VANGUARD_PUSH_TOKEN to the constructed sandbox provider', async () => {
    process.env.VANGUARD_PUSH_TOKEN = 'test-pat';
    dockerSandboxConfigs.length = 0;
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(dockerSandboxConfigs).toHaveLength(1);
    expect(dockerSandboxConfigs[0]?.secrets ?? {}).not.toHaveProperty('VANGUARD_PUSH_TOKEN');
    expect(Object.values(dockerSandboxConfigs[0]?.secrets ?? {})).not.toContain('test-pat');
  });
});

// ---------------------------------------------------------------------------
// Hardened sandbox (read-only rootfs)
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — hardened sandbox', () => {
  // Pin both vars so the host env cannot opt in or resize under the test.
  beforeEach(() => {
    vi.stubEnv('VANGUARD_SANDBOX_READONLY', undefined);
    vi.stubEnv('VANGUARD_SANDBOX_MEMORY_MB', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  // No `_sandbox`: the runner builds the (mocked) DockerSandboxProvider itself, so its config is the
  // assertion — the same opt-in resolution the other runners get (limits.test.ts covers the resolution).
  const revise = async (network?: string): Promise<SandboxConfig | undefined> => {
    dockerSandboxConfigs.length = 0;
    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGh(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
      ...(network !== undefined ? { network } : {}),
    });
    return dockerSandboxConfigs[0];
  };

  it('--egress/--llm-proxy (enclave network set) alone keeps the rootfs writable: read-only is opt-in', async () => {
    expect((await revise('vg-egr-1'))?.profile?.security.readOnlyRootfs).toBe(false);
  });

  it('--egress/--llm-proxy with VANGUARD_SANDBOX_READONLY=1: the sandbox gets a read-only rootfs', async () => {
    vi.stubEnv('VANGUARD_SANDBOX_READONLY', '1');
    expect((await revise('vg-egr-1'))?.profile?.security.readOnlyRootfs).toBe(true);
  });

  it('VANGUARD_SANDBOX_READONLY=0 keeps it off in hardened mode', async () => {
    vi.stubEnv('VANGUARD_SANDBOX_READONLY', '0');
    expect((await revise('vg-egr-1'))?.profile?.security.readOnlyRootfs).toBe(false);
  });

  it('without the flags the rootfs stays writable, as before', async () => {
    expect((await revise())?.profile?.security.readOnlyRootfs).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No actionable feedback
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — no actionable feedback', () => {
  it('returns early without committing, pushing, or undrafting', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        // Empty feedback
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                isDraft: true,
                headRefOid: 'deadbeef',
                commits: { nodes: [] },
                reviewThreads: { nodes: [] },
                reviews: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        });
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a) => { pushCalls.push(a); return ''; },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.undrafted).toBe(false);
    // No push happened
    expect(pushCalls.filter((a) => a[0] === 'push')).toHaveLength(0);
    // No undraft
    expect(ghCalls.find((a) => a[1] === 'ready')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round cap
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — round cap', () => {
  it.each([
    { author: 'alice', resumes: true },
    { author: 'github-actions', resumes: false },
  ])('resumes after a cap only for a human comment: $author', async ({ author, resumes }) => {
    const feedback = JSON.parse(makeFeedbackJsonWithRevisions());
    feedback.data.repository.pullRequest.comments.nodes.push(
      { author: { login: 'github-actions' }, body: '<!-- vanguard-revision-cap -->', createdAt: '2024-01-11T11:00:00Z' },
      { author: { login: author }, authorAssociation: 'OWNER', body: 'Please continue.', createdAt: '2024-01-11T12:00:00Z' },
    );
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify(feedback);
      return '';
    };
    const out = join(repo, 'preview.md');
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, maxRounds: 2, out,
      _sandbox: makeSandbox(), _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch',
    });
    expect(result.dryRunOut).toBe(resumes ? out : undefined);
    if (resumes) expect(await readFile(out, 'utf8')).toContain('Please continue.');
    else expect(ghCalls.some((args) => args.some((arg) => arg.includes('Revision cap reached')))).toBe(true);
  });

  it('posts a cap notice and flips labels without running the agent when cap is reached', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJsonWithRevisions();
      // cap comment post
      if (args[0] === 'pr' && args[1] === 'review') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a) => { pushCalls.push(a); return ''; },
      _baseBranch: 'feature-branch',
      maxRounds: 2,
      provider: 'claude',
    });

    // No push or undraft
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.undrafted).toBe(false);
    expect(pushCalls.filter((a) => a[0] === 'push')).toHaveLength(0);

    // Cap notice was posted
    const reviewPost = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'review' && a.includes('--comment'));
    expect(reviewPost).toBeDefined();

    // Labels were still flipped
    const editCall = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('vanguard:needs-human-review'));
    expect(editCall).toBeDefined();
    expect(ghCalls.filter((a) => a[0] === 'api' && a[1] === 'graphql')).toHaveLength(1);
  });

  it('does not fail the cap path when label hand-back fails', async () => {
    const ghCalls: string[][] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJsonWithRevisions();
      if (args[0] === 'pr' && args[1] === 'review') return '';
      if (args[0] === 'label' && args[1] === 'create') throw new Error('label create failed');
      if (args[0] === 'pr' && args[1] === 'edit') throw new Error('label edit failed');
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      maxRounds: 2,
      provider: 'claude',
    });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.undrafted).toBe(false);
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'edit')).toBe(true);
  });

  it('a trusted-human comment posted after the cap notice starts a new budget and the revision runs', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];
    const agentInputs: AgentRunInput[] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJsonCapReset();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
        return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a) => { pushCalls.push(a); return ''; },
      _baseBranch: 'feature-branch',
      maxRounds: 2,
      provider: 'claude',
    });

    // The round ran: the fresh human comment reset the budget instead of being refused again.
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.undrafted).toBe(true);
    expect(pushCalls.some((a) => a[0] === 'push')).toBe(true);
    expect(agentInputs[0]?.prompt).toContain('Please rename this.');

    // No second cap-refusal was posted this round.
    const capNoticePosts = ghCalls.filter((a) => a[0] === 'pr' && a[1] === 'review' && a.join(' ').includes('Revision cap reached'));
    expect(capNoticePosts).toHaveLength(0);
  });

  it('without a new trusted-human comment after the cap notice, the cap still holds', async () => {
    const ghCalls: string[][] = [];
    const pushCalls: string[][] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJsonCapStillHeld();
      if (args[0] === 'pr' && args[1] === 'review') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a) => { pushCalls.push(a); return ''; },
      _baseBranch: 'feature-branch',
      maxRounds: 2,
      provider: 'claude',
    });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.undrafted).toBe(false);
    expect(pushCalls.filter((a) => a[0] === 'push')).toHaveLength(0);

    const reviewPost = ghCalls.find((a) => a[0] === 'pr' && a[1] === 'review' && a.includes('--comment'));
    expect(reviewPost).toBeDefined();
    expect(reviewPost?.join(' ')).toContain('Revision cap reached');
  });
});

// ---------------------------------------------------------------------------
// Per-item replies for non-thread feedback
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — per-item replies for non-thread feedback', () => {
  it('posts a per-item reply for each review/comment item plus a final summary, without a lumped review', async () => {
    const ghCalls: string[][] = [];
    const prCommentBodies: string[] = [];
    const pushCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const agentInputs: AgentRunInput[] = [];

    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) {
        return makePrViewJson();
      }
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJsonWithNonThreadItems();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') {
        const bodyIdx = args.indexOf('--body');
        if (bodyIdx !== -1) prCommentBodies.push(args[bodyIdx + 1] ?? '');
        return '';
      }
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (f, a, c) => { pushCalls.push({ file: f, args: a, cwd: c }); return ''; },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    // Two per-item replies + one final summary = 3 pr comment calls
    expect(prCommentBodies).toHaveLength(3);

    // Per-item bodies reference their respective feedback authors
    const aliceBody = prCommentBodies.find((b) => b.includes('@alice'));
    const bobBody = prCommentBodies.find((b) => b.includes('@bob'));
    expect(aliceBody).toBeDefined();
    expect(bobBody).toBeDefined();

    // Each per-item body contains "Addressed in commit" and the revision marker
    expect(aliceBody).toContain('Addressed in commit');
    expect(aliceBody).toContain('<!-- vanguard-revision:');
    expect(bobBody).toContain('Addressed in commit');
    expect(bobBody).toContain('<!-- vanguard-revision:');

    // Final summary exists and has required sections
    const summaryBody = prCommentBodies.find((b) => b.includes('## Revision Summary'));
    expect(summaryBody).toBeDefined();
    expect(summaryBody).toContain('Deferred / not addressed');
    expect(summaryBody).toContain('Verification');
    expect(summaryBody).toContain('<!-- vanguard-revision:');

    // No lumped "Addressed N review comment(s)" review was posted
    const hasLumpedReview = ghCalls.some(
      (a) =>
        a[0] === 'pr' &&
        a[1] === 'review' &&
        a.some((s) => s.includes('review comment')),
    );
    expect(hasLumpedReview).toBe(false);

    // Per-item replies include a diff-derived "what changed" point (file path from the worktree diff).
    // The sandbox writes fix.txt → the revision diff contains that file.
    expect(aliceBody).toContain('fix.txt');
    expect(bobBody).toContain('fix.txt');

    // Final summary also carries the diff-derived points for each addressed item.
    expect(summaryBody).toContain('fix.txt');
  });
});

// ---------------------------------------------------------------------------
// Best-effort label hand-back
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — best-effort label hand-back', () => {
  function makeGhWithLabelFailure(ghCalls: string[][]): GhRunner {
    return async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      // label ensure — succeed
      if (args[0] === 'label' && args[1] === 'create') return '';
      // label flip — fail (simulates missing label in target repo)
      if (args[0] === 'pr' && args[1] === 'edit') throw new Error('label not found');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  async function runWithLabelFailure(): Promise<{ ghCalls: string[][]; result: Awaited<ReturnType<typeof runRevisePullRequest>> }> {
    const ghCalls: string[][] = [];
    const result = await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGhWithLabelFailure(ghCalls),
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });
    return { ghCalls, result };
  }

  it('resolves with pushed:true and undrafted:true even when the label flip throws', async () => {
    const { result } = await runWithLabelFailure();
    expect(result.pushed).toBe(true);
    expect(result.undrafted).toBe(true);
    expect(result.addressed).toBeGreaterThan(0);
  });

  it('ensures the rate-limited hold label exists before the hand-back removes it', async () => {
    const { ghCalls } = await runWithLabelFailure();
    const createIndex = ghCalls.findIndex((a) => a[0] === 'label' && a[1] === 'create' && a.includes('vanguard:rate-limited'));
    const editIndex = ghCalls.findIndex((a) => a[0] === 'pr' && a[1] === 'edit');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(editIndex).toBeGreaterThan(createIndex);
  });

  it('calls label create --force before the label flip', async () => {
    const { ghCalls } = await runWithLabelFailure();
    const createCallIndex = ghCalls.findIndex(
      (a) => a[0] === 'label' && a[1] === 'create' && a.includes('vanguard:needs-human-review'),
    );
    const editCallIndex = ghCalls.findIndex((a) => a[0] === 'pr' && a[1] === 'edit');
    expect(createCallIndex).toBeGreaterThanOrEqual(0);
    expect(editCallIndex).toBeGreaterThan(createCallIndex);
    expect(ghCalls[createCallIndex]).toContain('--force');
  });
});

// ---------------------------------------------------------------------------
// Revise-pass verification + body re-derivation
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — revise-pass verification', () => {
  const VERIFY_CMD = 'run-verify';

  // Clone the happy-path sandbox but drive the resolved verify command's exit code.
  function makeSandboxVerify(exit: number): IsolatedSandboxProvider {
    const base = makeSandbox() as unknown as Record<string, unknown>;
    return {
      ...base,
      exec: async (command: string): Promise<ExecResult> => {
        if (command.includes('$HOME')) return { stdout: '/root', stderr: '', exitCode: 0 };
        if (command === VERIFY_CMD) return { stdout: 'verify output', stderr: '', exitCode: exit };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
  }

  // gh runner referencing an issue via a closing keyword in the PR body, capturing pr-edit bodies.
  function makeGh(ghCalls: string[][], editBodies: string[], prBody = 'Adds guard.\n\nCloses o/r#42'): GhRunner {
    return async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) {
        return makePrViewJson({ body: prBody });
      }
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        if (query.includes('addPullRequestReviewThreadReply')) return JSON.stringify({ data: {} });
        if (query.includes('resolveReviewThread')) return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (args[0] === 'pr' && args[1] === 'ready') return '';
      if (args[0] === 'label' && args[1] === 'create') return '';
      if (args[0] === 'pr' && args[1] === 'edit') {
        const bodyIdx = args.indexOf('--body');
        if (bodyIdx !== -1) editBodies.push(args[bodyIdx + 1] ?? '');
        return '';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  it('runs the verify command and re-derives the body to Closes on a green pass', async () => {
    const ghCalls: string[][] = [];
    const editBodies: string[] = [];
    const agentInputs: AgentRunInput[] = [];

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGh(ghCalls, editBodies),
      verifyCmd: VERIFY_CMD,
      _sandbox: makeSandboxVerify(0),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    // Green verification → no repair resume (implement/review/simplify only).
    expect(agentInputs).toHaveLength(3);
    // Body re-derived to a closing reference for the issue recovered from the PR body.
    const body = editBodies.find((b) => b.includes('o/r#42'));
    expect(body).toBeDefined();
    expect(body).toContain('Closes o/r#42');
  });

  it('resumes the implement session once on red verification and re-derives the body to Part of', async () => {
    const ghCalls: string[][] = [];
    const editBodies: string[] = [];
    const agentInputs: AgentRunInput[] = [];

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGh(ghCalls, editBodies),
      verifyCmd: VERIFY_CMD,
      _sandbox: makeSandboxVerify(1),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    // One bounded repair iteration on red: implement/review/simplify + a single resumed repair.
    expect(agentInputs).toHaveLength(4);
    // No --provider-model: the repair carries no model, so the provider default applies.
    expect(agentInputs[3]?.model).toBeUndefined();
    // A red verification forces the Part-of path — never a silent stale Closes.
    const body = editBodies.find((b) => b.includes('o/r#42'));
    expect(body).toBeDefined();
    expect(body).toContain('Part of o/r#42');
    expect(body).not.toContain('Closes o/r#42');
  });

  it('carries a first-delivery gate-config block forward on a red round without re-adding its Closes', async () => {
    const editBodies: string[] = [];
    const configBlock = gateConfigChangedBlock([{ path: 'vitest.config.ts', patch: '+    thresholds: { lines: 0 },' }]);
    // The real first-delivery body order: gate block, then `Closes …` + attribution, then the proof.
    const prBody = [
      configBlock,
      'Closes o/r#42',
      'Automated implementation of o/r#42 by Vanguard.',
      '## Proof of work\n\nPASS',
    ].join('\n\n');

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGh([], editBodies, prBody),
      verifyCmd: VERIFY_CMD,
      _sandbox: makeSandboxVerify(1),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    const body = editBodies.find((b) => b.includes('o/r#42'));
    expect(body).toBeDefined();
    expect(body).toContain('Part of o/r#42');
    // The disclosure survives verbatim; the stale closing keyword next to it in the old body does not.
    expect(body).toContain(configBlock);
    expect(body).not.toContain('Closes o/r#42');
  });

  it('carries the required-PR-body-item block, with what a human pasted into it, across a round', async () => {
    const editBodies: string[] = [];
    const itemsBlock = prBodyGapWarningBlock([{ id: 'PR-1', contains: 'name: gate' }])
      .replace('<!-- vanguard:pr-body-items:end -->', '```yaml\nname: gate\n```\n<!-- vanguard:pr-body-items:end -->');
    const prBody = ['Part of o/r#42', 'Automated implementation of o/r#42 by Vanguard.', itemsBlock].join('\n\n');

    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGh([], editBodies, prBody),
      verifyCmd: VERIFY_CMD,
      _sandbox: makeSandboxVerify(0),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });

    const body = editBodies.find((b) => b.includes('o/r#42'));
    expect(body).toBeDefined();
    // A green round never upgrades the partial delivery to a closing keyword, and keeps the block verbatim.
    expect(body).not.toContain('Closes o/r#42');
    expect(body).toContain(itemsBlock);
  });

  describe('required-PR-body-item discharge', () => {
    const item = { id: 'PR-1', contains: 'name: gate' };
    const pastedBlock = prBodyGapWarningBlock([item])
      .replace('<!-- vanguard:pr-body-items:end -->', 'name: gate\n<!-- vanguard:pr-body-items:end -->');
    const prBody = ['Part of o/r#42', pastedBlock].join('\n\n');
    const comment = (login: string, assoc: string, manifest: object): object => ({
      author: { login }, authorAssociation: assoc, createdAt: '2026-01-01T00:00:00Z',
      body: `<spec_manifest>${JSON.stringify(manifest)}</spec_manifest>`,
    });

    async function round(comments: object[]): Promise<string> {
      const editBodies: string[] = [];
      const base = makeGh([], editBodies, prBody);
      const gh: GhRunner = async (args, env) => {
        if (args[0] === 'issue' && args[1] === 'view') {
          return JSON.stringify({ number: 42, title: 't', body: '', labels: [], comments, author: { login: 'reporter' }, state: 'OPEN' });
        }
        return base(args, env);
      };
      await runRevisePullRequest('7', {
        repoPath: repo, repoSlug: 'o/r', gh, verifyCmd: VERIFY_CMD,
        _sandbox: makeSandboxVerify(0), _agent: agentThatCompletes([]), _worktrees: new WorktreeManager(repo),
        _pushRunner: async () => '', _baseBranch: 'feature-branch', provider: 'claude',
      });
      return editBodies.find((b) => b.includes('o/r#42')) ?? '';
    }

    it('discharges from a non-author trusted manifest, keeping the pasted content', async () => {
      const body = await round([comment('maint', 'MEMBER', { prBody: [item] })]);
      expect(body).toContain('Required PR-body item discharged');
      expect(body).toContain('name: gate\n<!-- vanguard:pr-body-items:end -->');
    });

    it('keeps the block when the manifest is from an untrusted comment', async () => {
      expect(await round([comment('reporter', 'NONE', { prBody: [item] })])).toContain(pastedBlock);
    });

    it('keeps the block when the manifest is from the reporter, even as a member', async () => {
      expect(await round([comment('reporter', 'MEMBER', { prBody: [item] })])).toContain(pastedBlock);
    });

    it('keeps the block when a trusted manifest declares prBody: []', async () => {
      expect(await round([comment('maint', 'MEMBER', { prBody: [] })])).toContain(pastedBlock);
    });
  });

  it('the verify repair resumes on the implementer\'s routed model and turn cap', async () => {
    const agentInputs: AgentRunInput[] = [];
    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh: makeGh([], []),
      verifyCmd: VERIFY_CMD,
      _sandbox: makeSandboxVerify(1),
      _agent: agentThatCompletes(agentInputs),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
      providerModel: 'claude-sonnet-5',
    });
    expect(agentInputs).toHaveLength(4);
    expect(agentInputs[3]?.model).toBe('claude-sonnet-5');
    expect(agentInputs[3]?.maxTurns).toBe(agentInputs[0]?.maxTurns);
  });

  // gh runner whose PR body references o/r#42 and whose issue view returns the given labels.
  function makeGhWithIssueLabels(labels: string[], ghCalls: string[][]): GhRunner {
    const base = makeGh(ghCalls, []);
    return async (args, env) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        ghCalls.push(args);
        return JSON.stringify({ number: 42, title: 'Issue', body: '', labels: labels.map((name) => ({ name })), comments: [] });
      }
      return base(args, env);
    };
  }

  async function readRunRecordModels(): Promise<string[]> {
    const runsDir = join(repo, '.taskcell', 'runs');
    const files = (await readdir(runsDir, { recursive: true })).map(String).filter((f) => f.endsWith('.json'));
    const models: string[] = [];
    for (const f of files) {
      const text = await readFile(join(runsDir, f), 'utf8');
      for (const m of text.matchAll(/"requestedModel":\s*"([^"]+)"/g)) models.push(m[1] ?? '');
    }
    return models;
  }

  it('--provider-model: the implement stage runs on that model and the run record names it', async () => {
    const agentInputs: AgentRunInput[] = [];
    const ghCalls: string[][] = [];
    await runRevisePullRequest('12', {
      repoPath: repo, repoSlug: 'o/r', gh: makeGhWithIssueLabels([], ghCalls),
      _sandbox: makeSandbox(), _agent: agentThatCompletes(agentInputs), _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '', _baseBranch: 'feature-branch', provider: 'claude', providerModel: 'sonnet',
    });
    expect(agentInputs[0]?.model).toBe('sonnet');
    expect(await readRunRecordModels()).toContain('sonnet');
  });

  it('without --provider-model the implement stage carries no model (provider default)', async () => {
    const agentInputs: AgentRunInput[] = [];
    await runRevisePullRequest('12', {
      repoPath: repo, repoSlug: 'o/r', gh: makeGhWithIssueLabels([], []),
      _sandbox: makeSandbox(), _agent: agentThatCompletes(agentInputs), _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '', _baseBranch: 'feature-branch', provider: 'claude',
    });
    expect(agentInputs[0]?.model).toBeUndefined();
    expect(await readRunRecordModels()).toEqual([]);
  });

  it('a vanguard:model=<m> label on the source issue overrides --provider-model', async () => {
    const agentInputs: AgentRunInput[] = [];
    const ghCalls: string[][] = [];
    const logs: string[] = [];
    await runRevisePullRequest('12', {
      repoPath: repo, repoSlug: 'o/r', gh: makeGhWithIssueLabels(['bug', 'vanguard:model=opus'], ghCalls), log: (l) => logs.push(l),
      _sandbox: makeSandbox(), _agent: agentThatCompletes(agentInputs), _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '', _baseBranch: 'feature-branch', provider: 'claude', providerModel: 'sonnet',
    });
    expect(ghCalls.some((c) => c[0] === 'issue' && c[1] === 'view' && c[2] === '42')).toBe(true);
    expect(agentInputs[0]?.model).toBe('opus');
    expect(agentInputs.every((i) => i.model === 'opus')).toBe(true);
    expect(logs.some((l) => l.includes('pins the implementer model to opus via label'))).toBe(true);
    expect(await readRunRecordModels()).toContain('opus');
  });

  it('a failed issue lookup leaves --provider-model in place instead of blocking the revision', async () => {
    const agentInputs: AgentRunInput[] = [];
    const base = makeGh([], []);
    const gh: GhRunner = async (args, env) => {
      if (args[0] === 'issue' && args[1] === 'view') throw new Error('gh: issue not found');
      return base(args, env);
    };
    await runRevisePullRequest('12', {
      repoPath: repo, repoSlug: 'o/r', gh,
      _sandbox: makeSandbox(), _agent: agentThatCompletes(agentInputs), _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '', _baseBranch: 'feature-branch', provider: 'claude', providerModel: 'sonnet',
    });
    expect(agentInputs[0]?.model).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// pushToExistingBranch (remote-branch function)
// ---------------------------------------------------------------------------

describe('pushToExistingBranch', () => {
  it('calls git push origin HEAD:<prHeadRef> in the worktree path', async () => {
    const { pushToExistingBranch } = await import('../pipeline/remote-branch.js');
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
      calls.push({ file, args, cwd });
      return '';
    };
    const fakeCtx = {
      worktreePath: '/fake/worktree',
      branch: 'vanguard/test',
      taskId: 'test',
      sandbox: {} as IsolatedSandboxProvider,
      home: '/root',
      localRepoPath: '/repo',
      wm: {} as WorktreeManager,
      log: { info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) },
    } as unknown as import('../core/taskcell.js').RunContext;

    await pushToExistingBranch(fakeCtx, { prHeadRef: 'fix-auth', runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/fix-auth']);
    expect(calls[0]?.cwd).toBe('/fake/worktree');
  });

  it('respects a custom remote', async () => {
    const { pushToExistingBranch } = await import('../pipeline/remote-branch.js');
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return '';
    };
    const fakeCtx = {
      worktreePath: '/fake/wt',
      branch: 'vanguard/t',
      taskId: 't',
      sandbox: {} as IsolatedSandboxProvider,
      home: '/root',
      localRepoPath: '/r',
      wm: {} as WorktreeManager,
      log: { info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) },
    } as unknown as import('../core/taskcell.js').RunContext;

    await pushToExistingBranch(fakeCtx, { prHeadRef: 'my-branch', remote: 'upstream', runner });
    expect(calls[0]?.args).toEqual(['push', '--no-verify', 'upstream', 'HEAD:refs/heads/my-branch']);
  });
});

describe('runRevisePullRequest — skills', () => {
  it("injects the --skills dir plus the repo's .github/vanguard-skills into the revise sandbox", async () => {
    const bundled = await mkdtemp(join(tmpdir(), 'vg-revise-skills-'));
    const outPath = join(bundled, 'out.md');
    try {
      for (const dir of [join(bundled, 'skills', 'code-review'), join(repo, '.github', 'vanguard-skills', 'deploy')]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'SKILL.md'), '---\nname: s\ndescription: d\n---\n');
      }
      const sandbox = makeSandbox();
      const copied: string[] = [];
      sandbox.copyIn = async (_hostPath: string, to: string): Promise<void> => {
        copied.push(to);
      };
      const gh: GhRunner = async (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
        if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
        if (args[0] === 'api' && args[1] === 'graphql' && args.some((a) => a.startsWith('query=') && a.includes('reviewThreads'))) return makeFeedbackJson();
        throw new Error(`unexpected gh call in dry-run: ${args.join(' ')}`);
      };
      await runRevisePullRequest('7', {
        repoPath: repo,
        repoSlug: 'o/r',
        gh,
        _sandbox: sandbox,
        _agent: agentThatCompletes([]),
        _worktrees: new WorktreeManager(repo),
        _baseBranch: 'feature-branch',
        provider: 'claude',
        out: outPath,
        skillsDir: join(bundled, 'skills'),
      });
      expect(copied).toEqual(expect.arrayContaining(['/root/.claude/skills/code-review', '/root/.claude/skills/deploy']));
    } finally {
      await rm(bundled, { recursive: true, force: true });
    }
  });
});

it('T10: all-untrusted feedback explains itself on the PR and hands the labels back, without a push', async () => {
  const push = vi.fn(async () => '');
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'pr' && args[1] === 'diff') return '';
    if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson().replaceAll('"alice"', '"mallory"').replaceAll('COLLABORATOR', 'NONE');
    if (args[0] === 'pr' && args[1] === 'review') return '';
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error('Unexpected mutation: ' + args.join(' '));
  });
  const logs: string[] = [];
  const result = await runRevisePullRequest('7', { repoPath: repo, repoSlug: 'o/r', gh, _pushRunner: push, log: (line) => logs.push(line) });
  expect(result).toMatchObject({ addressed: 0, committed: false, pushed: false, undrafted: false, ignoredFeedback: [{ author: 'mallory', association: 'NONE' }] });
  expect(push).not.toHaveBeenCalled();
  // The maintainer sees why, and the PR leaves vanguard:revising for a human.
  const notice = gh.mock.calls.map(([args]) => args).find((args) => args[0] === 'pr' && args[1] === 'review' && args.includes('--comment'));
  expect(notice?.at(-1)).toContain('@mallory (NONE)');
  expect(notice?.at(-1)).not.toContain('Vanguard');
  const editCall = gh.mock.calls.map(([args]) => args).find((args) => args[0] === 'pr' && args[1] === 'edit');
  expect(editCall?.join(' ')).toContain('vanguard:needs-human-review');
  expect(editCall?.join(' ')).toContain('vanguard:revising');
  // Still no thread reply/resolve mutation and no undraft.
  expect(gh.mock.calls.every(([args]) => !(args.includes('ready') || args.some((arg) => arg.includes('mutation'))))).toBe(true);
  expect(logs.filter((line) => /ignored feedback from @mallory \(NONE\)/.test(line))).toHaveLength(1);
});

it('T11: a rate-limited provider with no fallback says so on the PR and drops the in-flight label', async () => {
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'pr' && args[1] === 'diff') return '';
    if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson();
    if (args[0] === 'pr' && args[1] === 'review') return '';
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error('Unexpected mutation: ' + args.join(' '));
  });
  const rateLimited: AgentProvider = {
    name: 'claude-code',
    async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      yield { text: 'starting' };
      throw new AgentError('claude exited 1: API error 429 rate_limit_error');
    },
  };
  await expect(
    runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: rateLimited,
      _worktrees: new WorktreeManager(repo),
      _baseBranch: 'feature-branch',
      provider: 'claude',
    }),
  ).rejects.toThrow(/429/);
  // The maintainer learns the run died on a transient limit, and the retry path (`needs revision`)
  // is left intact — only the in-flight label goes.
  const notice = gh.mock.calls.map(([args]) => args).find((args) => args[0] === 'pr' && args[1] === 'review' && args.includes('--comment'));
  expect(notice?.at(-1)).toContain('rate limit');
  expect(notice?.at(-1)).toContain('needs revision');
  const editCall = gh.mock.calls.map(([args]) => args).find((args) => args[0] === 'pr' && args[1] === 'edit');
  expect(editCall?.join(' ')).toContain('--remove-label vanguard:revising');
  expect(editCall?.join(' ')).not.toContain('needs-human-review');
});

it('a non-AgentError carrying GitHub\'s "API rate limit exceeded" posts no 429 notice', async () => {
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'pr' && args[1] === 'diff') return '';
    if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson();
    if (args[0] === 'pr' && args[1] === 'review') return '';
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error('Unexpected mutation: ' + args.join(' '));
  });
  const notGithubRateLimited: AgentProvider = {
    name: 'claude-code',
    async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      yield { text: 'starting' };
      // Not an AgentError — e.g. a `gh` call failing with GitHub's own wording — so it must never be
      // mistaken for a provider rate limit, even though the text matches that wording exactly.
      throw new Error('gh: API rate limit exceeded for user');
    },
  };
  await expect(
    runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: makeSandbox(),
      _agent: notGithubRateLimited,
      _worktrees: new WorktreeManager(repo),
      _baseBranch: 'feature-branch',
      provider: 'claude',
    }),
  ).rejects.toThrow(/API rate limit exceeded/);
  expect(gh.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'review')).toBe(false);
  expect(gh.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'edit')).toBe(false);
});

it('--out calls neither gh pr review nor gh pr edit when the agent is rate-limited', async () => {
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'pr' && args[1] === 'diff') return '';
    if (args[0] === 'api' && args[1] === 'graphql') return makeFeedbackJson();
    if (args[0] === 'pr' && args[1] === 'review') return '';
    if (args[0] === 'pr' && args[1] === 'edit') return '';
    throw new Error('Unexpected mutation: ' + args.join(' '));
  });
  const rateLimited: AgentProvider = {
    name: 'claude-code',
    async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      yield { text: 'starting' };
      throw new AgentError('claude exited 1: API error 429 rate_limit_error');
    },
  };
  await expect(
    runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      out: join(repo, 'preview.md'),
      _sandbox: makeSandbox(),
      _agent: rateLimited,
      _worktrees: new WorktreeManager(repo),
      _baseBranch: 'feature-branch',
      provider: 'claude',
    }),
  ).rejects.toThrow(/429/);
  expect(gh.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'review')).toBe(false);
  expect(gh.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'edit')).toBe(false);
});

it('uses the fallback model for the failed stage and subsequent stages', async () => {
  const primaryInputs: AgentRunInput[] = [];
  const fallbackInputs: AgentRunInput[] = [];
  const primary = agentThatCompletes(primaryInputs);
  primary.run = async function* (input): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    primaryInputs.push(input);
    throw new AgentError('HTTP 429');
  };
  const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue({
    agent: primary, fallbackAgent: agentThatCompletes(fallbackInputs),
    secrets: {}, proxySecrets: {}, injectAnthropicAuth: false,
  });
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'api' && args[1] === 'graphql' && !args.some((arg) => arg.includes('mutation'))) return makeFeedbackJson();
    return '';
  });
  try {
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, out: join(repo, 'preview.md'),
      _sandbox: makeSandbox(), _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch',
      provider: 'claude', fallbackProvider: 'codex', fallbackModel: 'fallback-model',
    });
    expect(result.dryRunOut).toBeDefined();
    expect(primaryInputs).toHaveLength(1);
    expect(fallbackInputs).toHaveLength(3);
    expect(fallbackInputs.every((input) => input.model === 'fallback-model')).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('keeps an explicit --review-model when the reviewer stage falls back to the same provider', async () => {
  const primaryInputs: AgentRunInput[] = [];
  const fallbackInputs: AgentRunInput[] = [];
  const primary = agentThatCompletes(primaryInputs);
  // `--review-provider` equal to `--provider`: a separate agent instance on the SAME provider, whose
  // fallback is the primary agent. --fallback-provider can never be the primary itself (selectAgents
  // rejects that), so this is the one shape in which the reviewer's fallback can serve --review-model.
  const reviewer = agentThatCompletes([]);
  reviewer.run = async function* (): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    throw new AgentError('HTTP 429');
  };
  const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue({
    agent: primary, reviewAgent: reviewer, fallbackAgent: agentThatCompletes(fallbackInputs, 'codex'),
    secrets: {}, proxySecrets: {}, injectAnthropicAuth: false,
  });
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'api' && args[1] === 'graphql' && !args.some((arg) => arg.includes('mutation'))) return makeFeedbackJson();
    return '';
  });
  try {
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, out: join(repo, 'preview.md'),
      _sandbox: makeSandbox(), _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch',
      provider: 'claude', reviewProvider: 'claude', fallbackProvider: 'codex',
      fallbackModel: 'fallback-model', reviewModel: 'review-pin',
    });
    expect(result.dryRunOut).toBeDefined();
    // Implementer and simplifier run on the primary (no model pinned); the reviewer's fallback lands
    // there too, carrying --review-model rather than the codex-bound --fallback-model.
    expect(fallbackInputs).toHaveLength(0);
    expect(primaryInputs.map((input) => input.model)).toEqual([undefined, 'review-pin', undefined]);
  } finally {
    spy.mockRestore();
  }
});

it('drops an explicit --review-model when the fallback runs on another provider', async () => {
  const primaryInputs: AgentRunInput[] = [];
  const fallbackInputs: AgentRunInput[] = [];
  const primary = agentThatCompletes(primaryInputs);
  primary.run = async function* (input): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    primaryInputs.push(input);
    throw new AgentError('HTTP 429');
  };
  const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue({
    // A Codex fallback cannot serve the Claude model name --review-model pinned for the reviewer.
    agent: primary, fallbackAgent: agentThatCompletes(fallbackInputs, 'codex'),
    secrets: {}, proxySecrets: {}, injectAnthropicAuth: false,
  });
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'api' && args[1] === 'graphql' && !args.some((arg) => arg.includes('mutation'))) return makeFeedbackJson();
    return '';
  });
  try {
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, out: join(repo, 'preview.md'),
      _sandbox: makeSandbox(), _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch',
      provider: 'claude', fallbackProvider: 'codex', fallbackModel: 'fallback-model', reviewModel: 'review-pin',
    });
    expect(result.dryRunOut).toBeDefined();
    expect(fallbackInputs).toHaveLength(3);
    expect(fallbackInputs.map((input) => input.model)).toEqual(['fallback-model', 'fallback-model', 'fallback-model']);
  } finally {
    spy.mockRestore();
  }
});

it('leaves the reviewer fallback on the fallback provider default when neither model is set', async () => {
  const primaryInputs: AgentRunInput[] = [];
  const fallbackInputs: AgentRunInput[] = [];
  const primary = agentThatCompletes(primaryInputs);
  primary.run = async function* (input): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    primaryInputs.push(input);
    throw new AgentError('HTTP 429');
  };
  const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue({
    agent: primary, fallbackAgent: agentThatCompletes(fallbackInputs, 'codex'),
    secrets: {}, proxySecrets: {}, injectAnthropicAuth: false,
  });
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'api' && args[1] === 'graphql' && !args.some((arg) => arg.includes('mutation'))) return makeFeedbackJson();
    return '';
  });
  try {
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, out: join(repo, 'preview.md'),
      _sandbox: makeSandbox(), _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch',
      provider: 'claude', fallbackProvider: 'codex', reviewModel: 'review-pin',
    });
    expect(result.dryRunOut).toBeDefined();
    expect(fallbackInputs).toHaveLength(3);
    expect(fallbackInputs.every((input) => input.model === undefined)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('keeps the primary model when a cross-provider reviewer falls back', async () => {
  const primaryInputs: AgentRunInput[] = [];
  const fallbackInputs: AgentRunInput[] = [];
  const primary = agentThatCompletes(primaryInputs);
  const reviewer = agentThatCompletes([], 'codex');
  reviewer.run = async function* (_input): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    throw new AgentError('HTTP 429');
  };
  const spy = vi.spyOn(registry, 'selectAgents').mockReturnValue({
    agent: primary, reviewAgent: reviewer, fallbackAgent: agentThatCompletes(fallbackInputs),
    secrets: {}, proxySecrets: {}, injectAnthropicAuth: false,
  });
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view') return makePrViewJson();
    if (args[0] === 'api' && args[1] === 'graphql' && !args.some((arg) => arg.includes('mutation'))) return makeFeedbackJson();
    return '';
  });
  try {
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, out: join(repo, 'preview.md'),
      _sandbox: makeSandbox(), _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch',
      provider: 'claude', fallbackProvider: 'codex', fallbackModel: 'fallback-model', providerModel: 'sonnet', reviewProvider: 'codex', reviewModel: 'gpt-5',
    });
    expect(result.dryRunOut).toBeDefined();
    expect(fallbackInputs).toHaveLength(0);
    expect(primaryInputs.map((input) => input.model)).toEqual(['sonnet', 'sonnet', 'sonnet']);
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// Gate-config signal on a revise push (#627)
// ---------------------------------------------------------------------------

describe('runRevisePullRequest — gate-config signal', () => {
  /** Sandbox whose agent writes a gate-config file (plus the usual fix.txt) into the worktree. */
  function makeGateConfigSandbox(): IsolatedSandboxProvider {
    return {
      ...(makeSandbox() as unknown as Record<string, unknown>),
      copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
        if (sandboxPath !== '/workspace') return;
        await mkdir(hostPath, { recursive: true });
        await writeFile(join(hostPath, 'fix.txt'), 'fix applied');
        await writeFile(join(hostPath, 'vitest.config.ts'), 'export default { coverage: { lines: 0 } };\n');
      },
    } as unknown as IsolatedSandboxProvider;
  }

  function makeGh(ghCalls: string[][], commentBodies: string[], opts: { failLabelFlip?: boolean } = {}): GhRunner {
    return async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'comment') {
        const bodyIdx = args.indexOf('--body');
        if (bodyIdx !== -1) commentBodies.push(args[bodyIdx + 1] ?? '');
        return '';
      }
      if (args[0] === 'pr' && args[1] === 'edit') {
        if (opts.failLabelFlip === true && args.includes('vanguard:gate-config-changed')) throw new Error('label flip refused');
        return '';
      }
      return '';
    };
  }

  function run(gh: GhRunner, sandbox: IsolatedSandboxProvider): ReturnType<typeof runRevisePullRequest> {
    return runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      _sandbox: sandbox,
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async () => '',
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });
  }

  it('labels and discloses a gate-config change pushed in a revise round', async () => {
    const ghCalls: string[][] = [];
    const commentBodies: string[] = [];

    const result = await run(makeGh(ghCalls, commentBodies), makeGateConfigSandbox());

    expect(result.pushed).toBe(true);
    const summary = commentBodies.find((b) => b.includes('## Revision Summary'));
    expect(summary).toContain('## Gate config changed');
    expect(summary).toContain('vitest.config.ts');
    expect(ghCalls.some((a) => a[0] === 'label' && a[1] === 'create' && a.includes('vanguard:gate-config-changed'))).toBe(true);
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--add-label') && a.includes('vanguard:gate-config-changed'))).toBe(true);
  });

  it('stays silent on a revise round that touches no gate config', async () => {
    const ghCalls: string[][] = [];
    const commentBodies: string[] = [];

    await run(makeGh(ghCalls, commentBodies), makeSandbox());

    expect(commentBodies.every((b) => !b.includes('## Gate config changed'))).toBe(true);
    expect(ghCalls.some((a) => a.includes('vanguard:gate-config-changed'))).toBe(false);
  });

  it('reports a failed gate-config label flip instead of handing the PR back unflagged', async () => {
    const ghCalls: string[][] = [];
    const commentBodies: string[] = [];

    await expect(run(makeGh(ghCalls, commentBodies, { failLabelFlip: true }), makeGateConfigSandbox())).rejects.toThrow('label flip refused');
    // The disclosure still went out, and the round never reached the hand-back: the PR keeps
    // `vanguard:revising` rather than silently returning for review without the gate label.
    expect(commentBodies.some((b) => b.includes('## Gate config changed'))).toBe(true);
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'ready')).toBe(false);
    expect(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--remove-label'))).toBe(false);
  });
});

describe('runRevisePullRequest — taskcell GitHub App', () => {
  const KEYS = ['TASKCELL_APP_CLIENT_ID', 'TASKCELL_APP_PRIVATE_KEY', 'VANGUARD_PUSH_TOKEN'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const run = async (status: number): Promise<{ readyEnvs: Array<Record<string, string> | undefined>; pushEnvs: Array<Record<string, string> | undefined>; logs: string[]; fetched: string[] }> => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    process.env.TASKCELL_APP_CLIENT_ID = 'Iv1.test';
    process.env.TASKCELL_APP_PRIVATE_KEY = privateKey;
    const fetched: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      fetched.push(`${init?.method} ${url}`);
      if (status !== 200) return new Response('{}', { status });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (String(url).endsWith('/installation')) return new Response(JSON.stringify({ id: 9 }), { status: 200 });
      n += 1;
      return new Response(JSON.stringify({ token: `ghs_app_token_${n}_Zx9Qw8Er7Ty6Ui5Op4` }), { status: 201 });
    });
    const readyEnvs: Array<Record<string, string> | undefined> = [];
    const pushEnvs: Array<Record<string, string> | undefined> = [];
    const logs: string[] = [];
    const gh: GhRunner = async (args, env) => {
      if (args[0] === 'pr' && args[1] === 'view' && args.some((a) => a.includes('headRefName'))) return makePrViewJson();
      if (args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/fix.txt';
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (query.includes('reviewThreads')) return makeFeedbackJson();
        return JSON.stringify({ data: {} });
      }
      if (args[0] === 'pr' && args[1] === 'ready') { readyEnvs.push(env); return ''; }
      if ((args[0] === 'pr' && (args[1] === 'comment' || args[1] === 'edit')) || (args[0] === 'label' && args[1] === 'create')) return '';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    await runRevisePullRequest('7', {
      repoPath: repo,
      repoSlug: 'o/r',
      gh,
      log: (line: string) => logs.push(line),
      _sandbox: makeSandbox(),
      _agent: agentThatCompletes([]),
      _worktrees: new WorktreeManager(repo),
      _pushRunner: async (file, args, _cwd, env) => { if (file === 'git' && args[0] === 'push') pushEnvs.push(env); return ''; },
      _baseBranch: 'feature-branch',
      provider: 'claude',
    });
    return { readyEnvs, pushEnvs, logs, fetched };
  };

  it('pushes and undrafts with freshly minted App tokens, revokes each, and labels the logs by the credential used', async () => {
    const { readyEnvs, pushEnvs, logs, fetched } = await run(200);
    expect(Object.values(pushEnvs[0] ?? {})).toContain(`AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_app_token_1_Zx9Qw8Er7Ty6Ui5Op4').toString('base64')}`);
    expect(readyEnvs[0]).toEqual({ GH_TOKEN: 'ghs_app_token_2_Zx9Qw8Er7Ty6Ui5Op4' });
    expect(fetched.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
    expect(logs.some((l) => /pushed -> feature-branch \(taskcell App token\)/.test(l))).toBe(true);
    expect(logs.some((l) => /undraft -> pr ready \(taskcell App token\)/.test(l))).toBe(true);
  });

  it('a failed mint without a PAT pushes and undrafts with the ambient credential, and the logs say so', async () => {
    delete process.env.VANGUARD_PUSH_TOKEN;
    const { readyEnvs, pushEnvs, logs } = await run(500);
    expect(pushEnvs).toEqual([undefined]);
    expect(readyEnvs).toEqual([undefined]);
    expect(logs.some((l) => /push token unavailable, using the ambient credential/.test(l))).toBe(true);
    expect(logs.some((l) => /pushed -> feature-branch$/.test(l))).toBe(true);
    expect(logs.some((l) => /undraft -> pr ready$/.test(l))).toBe(true);
  });
});

describe('runRevisePullRequest base conflicts', () => {
  let origin: string;

  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
  });

  const commitAll = async (msg: string): Promise<void> => {
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg], { cwd: repo });
  };

  /** feature-branch and main both change `file`; main is published to a local origin. */
  async function diverge(file: string): Promise<void> {
    origin = await mkdtemp(join(tmpdir(), 'vg-origin-'));
    await execa('git', ['init', '--bare', '-b', 'main'], { cwd: origin });
    await execa('git', ['remote', 'add', 'origin', origin], { cwd: repo });
    await execa('git', ['checkout', 'feature-branch'], { cwd: repo });
    await writeFile(join(repo, file), 'feature line\n');
    await commitAll('feature change');
    await execa('git', ['checkout', 'main'], { cwd: repo });
    await writeFile(join(repo, file), 'main line\n');
    await commitAll('main change');
    await execa('git', ['push', 'origin', 'main'], { cwd: repo });
  }

  async function run(sandboxFiles: Record<string, string>, opts: { body?: string; noop?: boolean; out?: string } = {}): Promise<{
    result: Awaited<ReturnType<typeof runRevisePullRequest>>;
    ghCalls: string[][];
    pushed: string[];
    parents: string[];
    prompt: string;
    sandboxCalls: string[];
    tree: string;
  }> {
    const ghCalls: string[][] = [];
    const pushed: string[] = [];
    const parents: string[] = [];
    const sandboxCalls: string[] = [];
    let tree = '';
    const inputs: AgentRunInput[] = [];
    const base = makeGh();
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'review') return '';
      if (args[0] === 'api' && opts.body !== undefined && (args.find((a) => a.startsWith('query=')) ?? '').includes('reviewThreads')) {
        return makeFeedbackJson().replace('Please rename this.', opts.body);
      }
      return base(args);
    };
    const sandbox = makeSandbox();
    const copyOut = sandbox.copyFileOut.bind(sandbox);
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command: string, options?: Parameters<typeof exec>[1]) => { if (command.includes('-delete')) sandboxCalls.push('wipe'); return exec(command, options); };
    sandbox.copyIn = async () => { sandboxCalls.push('copyIn'); };
    sandbox.copyFileOut = async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (opts.noop === true) return mkdir(hostPath, { recursive: true }).then(() => undefined);
      await copyOut(sandboxPath, hostPath);
      if (sandboxPath === '/workspace') for (const [f, c] of Object.entries(sandboxFiles)) await writeFile(join(hostPath, f), c);
    };
    const result = await runRevisePullRequest('7', {
      repoPath: repo, repoSlug: 'o/r', gh, _sandbox: sandbox, _agent: agentThatCompletes(inputs),
      _worktrees: new WorktreeManager(repo), _baseBranch: 'feature-branch', provider: 'claude',
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      _pushRunner: async (_f, args, cwd) => {
        if (args[0] === 'push') {
          tree = (await execa('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd })).stdout;
          pushed.push(args.join(' '));
          parents.push((await execa('git', ['rev-list', '--merges', '--count', 'HEAD'], { cwd })).stdout);
        }
        return '';
      },
    });
    return { result, ghCalls, pushed, parents, prompt: inputs[0]?.prompt ?? '', sandboxCalls, tree };
  }

  const comments = (calls: string[][]): string => calls.filter((a) => a[1] === 'comment' || a[1] === 'review').map((a) => a.join(' ')).join('\n');

  it('clean branch: merges nothing, pushes an ordinary commit, no Merged base section', async () => {
    await diverge('shared.txt');
    // Undo the shared edit on the feature side so only main touches shared.txt: the branch merges cleanly.
    await execa('git', ['checkout', 'feature-branch'], { cwd: repo });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'revert', '--no-edit', 'HEAD'], { cwd: repo });
    await execa('git', ['checkout', 'main'], { cwd: repo });
    const { result, pushed, parents, ghCalls, prompt } = await run({});
    expect(result.pushed).toBe(true);
    expect(result.conflictUnresolved).toBeUndefined();
    expect(pushed).toHaveLength(1);
    expect(parents[0]).toBe('0'); // no merge commit in the pushed history
    expect(prompt).not.toContain('mid-merge');
    expect(comments(ghCalls)).not.toContain('Merged base');
  });

  it('conflicting branch: merges the base, the agent resolves, one merge commit is pushed and the summary lists the files', async () => {
    await diverge('shared.txt');
    const { result, pushed, parents, ghCalls, prompt } = await run({ 'shared.txt': 'both lines\n' });
    expect(prompt).toContain('mid-merge with its base `main`');
    expect(prompt).toContain('shared.txt');
    expect(result.pushed).toBe(true);
    expect(result.conflictUnresolved).toBeUndefined();
    expect(pushed).toHaveLength(1);
    expect(parents[0]).toBe('1'); // the base was merged, history not rewritten
    const text = comments(ghCalls);
    expect(text).toContain('### Merged base');
    expect(text).toContain('Merged `main` into the branch; resolved conflicts in: `shared.txt`');
  });

  it('conflict the agent could not resolve: nothing pushed, "could not resolve" comment, needs revision kept', async () => {
    await diverge('shared.txt');
    const { result, pushed, ghCalls } = await run({ 'shared.txt': '<<<<<<< HEAD\nfeature line\n=======\nmain line\n>>>>>>> FETCH_HEAD\n' });
    expect(result.conflictUnresolved).toEqual(['shared.txt']);
    expect(result.pushed).toBe(false);
    expect(pushed).toEqual([]);
    expect(comments(ghCalls)).toMatch(/Could not resolve the conflict with main: `shared\.txt`/);
    expect(ghCalls.some((a) => a[1] === 'ready')).toBe(false);
    const edits = ghCalls.filter((a) => a[0] === 'pr' && a[1] === 'edit');
    expect(edits.some((a) => a.includes('vanguard:revising') && a.includes('--remove-label'))).toBe(true);
    expect(edits.some((a) => a.includes('needs revision'))).toBe(false);
  });

  it('no-op revision on a conflict finding: nothing pushed, not reported as success', async () => {
    origin = await mkdtemp(join(tmpdir(), 'vg-origin-')); // satisfies afterEach; no remote, so the probe is skipped
    const { result, pushed, ghCalls } = await run({}, { body: 'The branch conflicts with main. Rebase on main and resolve the conflicts.', noop: true });
    expect(result.pushed).toBe(false);
    expect(result.conflictUnresolved).toEqual([]);
    expect(pushed).toEqual([]);
    expect(comments(ghCalls)).toContain('Could not resolve the conflict with main');
    expect(ghCalls.some((a) => a[1] === 'ready')).toBe(false);
  });

  it('refreshes the sandbox from the merged worktree (wipe, then copyIn) and the merge commit drops files the base deleted', async () => {
    await diverge('shared.txt');
    await execa('git', ['checkout', 'main'], { cwd: repo });
    await execa('git', ['rm', '-q', 'README.md'], { cwd: repo });
    await commitAll('main deletes README');
    await execa('git', ['push', 'origin', 'main'], { cwd: repo });
    const { result, sandboxCalls, tree } = await run({ 'shared.txt': 'both lines\n' });
    expect(result.pushed).toBe(true);
    expect(sandboxCalls).toEqual(['copyIn', 'wipe', 'copyIn']); // prepare, then wipe + re-copy after the merge
    expect(tree).not.toContain('README.md');
    expect(tree).toContain('shared.txt');
  });

  it('a revision diff on a conflicted branch carries the resolution, not the base-only changes', async () => {
    await diverge('shared.txt');
    await execa('git', ['checkout', 'main'], { cwd: repo });
    await writeFile(join(repo, 'baseonly.txt'), 'b\n');
    await commitAll('base only');
    await execa('git', ['push', 'origin', 'main'], { cwd: repo });
    const { ghCalls } = await run({ 'shared.txt': 'both lines\n' });
    expect(comments(ghCalls)).not.toContain('baseonly.txt');
  });

  it('a modify/delete conflict is held for a human before the agent runs', async () => {
    origin = await mkdtemp(join(tmpdir(), 'vg-origin-'));
    await execa('git', ['init', '--bare', '-b', 'main'], { cwd: origin });
    await execa('git', ['remote', 'add', 'origin', origin], { cwd: repo });
    await execa('git', ['checkout', 'feature-branch'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'changed on the PR\n');
    await commitAll('feature edits README');
    await execa('git', ['checkout', 'main'], { cwd: repo });
    await execa('git', ['rm', '-q', 'README.md'], { cwd: repo });
    await commitAll('main deletes README');
    await execa('git', ['push', 'origin', 'main'], { cwd: repo });
    const { result, pushed, prompt, ghCalls } = await run({});
    expect(prompt).toBe('');
    expect(result.conflictUnresolved).toEqual(['README.md']);
    expect(pushed).toEqual([]);
    expect(comments(ghCalls)).toContain('Could not resolve the conflict with main: `README.md`');
  });

  it('--out: an unresolved conflict is written to the preview file and nothing is posted', async () => {
    await diverge('shared.txt');
    const out = join(repo, 'preview', 'out.md');
    const { result, ghCalls, pushed } = await run({ 'shared.txt': '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m\n' }, { out });
    expect(result.conflictUnresolved).toEqual(['shared.txt']);
    expect(await readFile(out, 'utf8')).toContain('Could not resolve the conflict with main');
    expect(pushed).toEqual([]);
    expect(ghCalls.some((a) => a[1] === 'comment' || a[1] === 'review' || a[1] === 'edit')).toBe(false);
  });

  it('a no-op round on a cleanly merging branch is not reported as a conflict even if a comment says "conflicts"', async () => {
    await diverge('shared.txt');
    await execa('git', ['checkout', 'feature-branch'], { cwd: repo });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'revert', '--no-edit', 'HEAD'], { cwd: repo });
    await execa('git', ['checkout', 'main'], { cwd: repo });
    const { result, ghCalls } = await run({}, { body: 'This conflicts with our naming convention.', noop: true });
    expect(result.conflictUnresolved).toBeUndefined();
    expect(comments(ghCalls)).not.toContain('Could not resolve');
  });
});
