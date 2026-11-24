import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeIssueRun, CredentialLimited, coolRescuedCredential } from './run-execution.js';
import { ProviderLimitError } from '../core/errors.js';
import { UsageCapError } from '../core/usage-cap.js';
import { readFile, stat } from 'node:fs/promises';
import type { IssueRunExecution } from './run-execution.js';
import { planIssueRun } from './run-plan.js';
import { runCredentialContext } from './agent-session.js';
import type { NewPrTarget, ReviewHost, RunIssueDeps, Tracker } from './source-adapter.js';
import type { RunContext } from '../core/taskcell.js';
import type { Task } from '../tasks/fetcher.js';
import type { RunEvent } from '../pipeline/events.js';
import type { AgentProvider } from '../agents/provider.js';
import type { SkillRegistry } from '../context/skill-registry.js';

// Execution against fakes only: a fake Tracker, a fake ReviewHost and a fake sandbox session. No module is mocked.

const task: Task = { id: 'group/project#1', title: 'Add a thing', description: '', labels: [], children: [], comments: [] };
const SECRET_DIFF = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const t = 'ghp_${'a1B2'.repeat(9)}';\n`;

let repo: string;
let worktree: string;
beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'run-exec-repo-'));
  worktree = await mkdtemp(join(tmpdir(), 'run-exec-wt-'));
  execFileSync('git', ['init', '-q'], { cwd: worktree });
});
afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
});

interface Fakes {
  tracker: Tracker;
  host: ReviewHost;
  targets: NewPrTarget[];
  exec: ReturnType<typeof vi.fn>;
  state: { dirty: boolean; diff: string; execExit: number; failWith?: Error };
}

function fakes(): Fakes {
  const targets: NewPrTarget[] = [];
  const state: Fakes['state'] = { dirty: false, diff: '', execExit: 0 };
  const exec = vi.fn(async () => ({ exitCode: state.execExit, stdout: 'boom', stderr: '' }));
  const tracker: Tracker = {
    prepare: vi.fn(async () => ({ task })),
    taskId: () => 'gl-1',
    stages: () => [],
    signalSecretBlock: vi.fn(async () => {}),
    signalBaseRed: vi.fn(async () => {}),
    linkPr: vi.fn(async () => {}),
  };
  const host: ReviewHost = {
    kind: 'gh',
    newPrTarget: (pr) => { targets.push(pr); return { kind: 'local-branch' }; },
    publishVerdict: vi.fn(async () => {}),
    addFailureLabel: vi.fn(async () => {}),
    addGateConfigLabel: vi.fn(async () => {}),
  };
  return { tracker, host, targets, exec, state };
}

async function run(f: Fakes, deps: Partial<RunIssueDeps> = {}, events: RunEvent[] = []): Promise<Awaited<ReturnType<typeof executeIssueRun>>> {
  const all: RunIssueDeps = { repoPath: repo, onEvent: (e) => events.push(e), ...deps };
  const plan = await planIssueRun({ fetchedTask: (await f.tracker.prepare('group/project#1')).task, deps: all, baseStages: [], tracker: f.tracker, skillIds: [], cooldowns: new Map(), exhausted: new Set() });
  const ctx = {
    taskId: 'gl-1',
    sandbox: { exec: f.exec },
    worktreePath: worktree,
    branch: 'feat/gl-1',
    home: '/home',
    localRepoPath: repo,
    baseBranch: 'main',
    startRef: '0000sha',
    wm: {
      isDirty: async () => {
        if (f.state.failWith !== undefined) throw f.state.failWith;
        return f.state.dirty;
      },
      diff: async () => f.state.diff,
      outgoingDiff: async () => f.state.diff,
      commitMessages: async () => [],
    },
    log: console,
  } as unknown as RunContext;
  const session: IssueRunExecution['session'] = {
    agents: { agent: { name: 'claude' } as AgentProvider, secrets: {}, proxySecrets: {}, injectAnthropicAuth: false },
    credentials: runCredentialContext(all),
    prepare: vi.fn(async () => ctx),
  };
  const skills = { ids: () => [], inject: async () => {} } as unknown as SkillRegistry;
  return executeIssueRun({ issueRef: 'group/project#1', plan, session, skills, tracker: f.tracker, host: f.host, exhausted: new Set() });
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

describe('executeIssueRun', () => {
  it('a clean tree is "no changes": no link-back, run-end emitted', async () => {
    const f = fakes();
    const events: RunEvent[] = [];
    const result = await run(f, {}, events);
    expect(result).toEqual({ task });
    expect(f.tracker.linkPr).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['run-start', 'run-end']);
  });

  it('prepares the session for the planned base branch and task id', async () => {
    const f = fakes();
    const events: RunEvent[] = [];
    await run(f, { baseBranch: 'dev' }, events);
    expect(events[0]).toMatchObject({ type: 'run-start', taskId: 'gl-1', flow: 'default', provider: 'claude', baseBranch: 'dev' });
  });

  it('a red base stops before implementing and tells the tracker', async () => {
    const f = fakes();
    f.state.execExit = 1;
    const result = await run(f, { verifyCmd: 'pnpm install --frozen-lockfile && pnpm test' });
    expect(result).toEqual({ task, baseRed: true });
    expect(f.tracker.signalBaseRed).toHaveBeenCalledTimes(1);
  });

  it('a red base on a white-label run is not signalled on the issue', async () => {
    const f = fakes();
    f.state.execExit = 1;
    const result = await run(f, { verifyCmd: 'pnpm install --frozen-lockfile && pnpm test', commitAuthor: { name: 'A', email: 'a@x' } });
    expect(result.baseRed).toBe(true);
    expect(f.tracker.signalBaseRed).not.toHaveBeenCalled();
  });

  it('a secret in the outgoing diff blocks delivery and is signalled on the issue', async () => {
    const f = fakes();
    f.state.dirty = true;
    f.state.diff = SECRET_DIFF;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run(f);
    expect(result).toEqual({ task, secretBlocked: true });
    expect(f.tracker.signalSecretBlock).toHaveBeenCalledTimes(1);
  });

  it('a white-label secret block stays off the issue', async () => {
    const f = fakes();
    f.state.dirty = true;
    f.state.diff = SECRET_DIFF;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run(f, { commitAuthor: { name: 'A', email: 'a@x' } });
    expect(result.secretBlocked).toBe(true);
    expect(f.tracker.signalSecretBlock).not.toHaveBeenCalled();
  });

  it('a committed change is handed to the host as a draft target (no verify command), titled from the task', async () => {
    const f = fakes();
    f.state.dirty = true;
    f.state.diff = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+hello\n';
    await writeFile(join(worktree, 'x.txt'), 'hello\n');
    const result = await run(f);
    expect(result).toEqual({ task, branch: 'feat/gl-1' });
    expect(f.targets).toHaveLength(1);
    expect(f.targets[0]).toMatchObject({ title: 'Add a thing (group/project#1)', draft: true, bugLabel: false });
    // A local delivery has no PR to link back or label.
    expect(f.tracker.linkPr).not.toHaveBeenCalled();
    expect(f.host.addFailureLabel).not.toHaveBeenCalled();
  });
});

describe('executeIssueRun: skill notes', () => {
  it('a "Skills:" line that is prose surfaces its note as a warning event and in the run record', async () => {
    const f = fakes();
    f.tracker.prepare = vi.fn(async () => ({ task: { ...task, description: 'Skills: TypeScript and SQL, good communication' } }));
    const events: RunEvent[] = [];
    await run(f, {}, events);
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining('it was ignored') });
  });
});

describe('executeIssueRun: credential rotation', () => {
  const limit = (): Error => new ProviderLimitError('usage limit reached');
  /** A run whose first sandbox call hits `error`; `session.prepare` is the first thing the run awaits. */
  async function limited(error: Error, deps: Partial<RunIssueDeps>): Promise<unknown> {
    const f = fakes();
    f.state.failWith = error;
    f.state.dirty = true;
    return run(f, deps).then(() => undefined, (e: unknown) => e);
  }

  it('a provider limit with another account available throws CredentialLimited and cools no pool entry', async () => {
    const hasNext = vi.fn(async () => true);
    const thrown = await limited(limit(), { credentialRotation: { provider: 'claude', hasNext }, credentialName: 'A' });
    expect(thrown).toBeInstanceOf(CredentialLimited);
    expect((thrown as CredentialLimited).until.getTime()).toBeGreaterThan(Date.now());
  });

  it('writes the attempt records with the credential name and the provider-limit stop, and cools no pool entry', async () => {
    await limited(limit(), { credentialRotation: { provider: 'claude', hasNext: async () => true }, credentialName: 'Key A' });
    const metrics = (await readFile(join(repo, '.taskcell', 'runs', 'metrics.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(metrics.some((m) => m.evt === 'run_complete' && m.credential === 'Key A' && m.stoppedBy === 'provider-limit')).toBe(true);
    await expect(stat(join(repo, '.taskcell', 'model-pool-cooldowns.json'))).rejects.toThrow();
  });

  it('a local usage cap never rotates accounts', async () => {
    const cap = new UsageCapError('claude', 90, 80, new Date(Date.now() + 3600_000));
    const thrown = await limited(cap, { credentialRotation: { provider: 'claude', hasNext: async () => true } });
    expect(thrown).toBeInstanceOf(UsageCapError);
  });

  it('with no account left the original limit error escapes (park)', async () => {
    const thrown = await limited(limit(), { credentialRotation: { provider: 'claude', hasNext: async () => false } });
    expect(thrown).toBeInstanceOf(ProviderLimitError);
  });

  it('a limit on another provider does not rotate', async () => {
    const thrown = await limited(limit(), { credentialRotation: { provider: 'codex', hasNext: async () => true } });
    expect(thrown).toBeInstanceOf(ProviderLimitError);
  });
});

describe('coolRescuedCredential', () => {
  const reset = new Date(Date.now() + 3600_000).toISOString();
  it('cools the account when a stage on the rotation provider was rescued by its fallback', async () => {
    const cooled = vi.fn(async () => {});
    await coolRescuedCredential([{ name: 'implementer', primaryLimitResetAt: reset }, { name: 'reviewer' }], () => 'claude', 'claude', cooled);
    expect(cooled).toHaveBeenCalledOnce();
    expect(cooled).toHaveBeenCalledWith(new Date(reset));
  });
  it('does not cool the Claude account for a rescued stage on another provider (e.g. a Codex reviewer)', async () => {
    const cooled = vi.fn(async () => {});
    await coolRescuedCredential([{ name: 'reviewer', primaryLimitResetAt: reset }], (stage) => (stage === 'reviewer' ? 'codex' : 'claude'), 'claude', cooled);
    expect(cooled).not.toHaveBeenCalled();
  });
});
