import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeIssueRun, PoolEntryLimited, CredentialLimited, coolRescuedCredential, stagePicks } from './run-execution.js';
import { UsageCapError } from '../core/usage-cap.js';
import type { IssueRunExecution } from './run-execution.js';
import { planIssueRun } from './run-plan.js';
import { runCredentialContext } from './agent-session.js';
import type { NewPrTarget, ReviewHost, RunIssueDeps, Tracker } from './source-adapter.js';
import type { RunContext } from '../core/taskcell.js';
import type { Task } from '../tasks/fetcher.js';
import type { RunEvent } from '../pipeline/events.js';
import type { AgentProvider, AgentRunInput, AgentRunOutput, AgentTurn } from '../agents/provider.js';
import type { SkillRegistry } from '../context/skill-registry.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import { AgentError, ProviderLimitError } from '../core/errors.js';
import { readCooldowns } from '../core/model-pool.js';

// Execution against fakes only: a fake Tracker, a fake ReviewHost, a fake sandbox session and a scripted agent. No module is mocked.

const task: Task = { id: 'group/project#1', title: 'Add a thing', description: '', labels: [], children: [], comments: [] };
const PR_URL = 'https://github.com/group/project/pull/7';
const SECRET_DIFF = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const t = 'ghp_${'a1B2'.repeat(9)}';\n`;
const TOUCH_DIFF = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+hello\n';

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
  prepare: Mock<() => void>;
  /** Arguments of each `gh pr create` the fake command runner saw. */
  prCreates: string[][];
  /** `execExits` are consumed one per sandbox command, then `execExit` applies: a gate can go red, then green. */
  state: { dirty: boolean; diff: string; execExit: number; execExits: number[]; failWith?: Error };
}

/** `openPr`: deliver as a real new-pr target over a recording command runner (nothing is pushed), else a local branch. */
function fakes(openPr = false): Fakes {
  const targets: NewPrTarget[] = [];
  const prCreates: string[][] = [];
  const state: Fakes['state'] = { dirty: false, diff: '', execExit: 0, execExits: [] };
  // Only the verify command (pnpm …) is scripted; copy-back's own housekeeping commands succeed silently.
  const exec = vi.fn(async (cmd: string) => (String(cmd).startsWith('pnpm ') ? { exitCode: state.execExits.shift() ?? state.execExit, stdout: 'boom', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }));
  const tracker: Tracker = {
    prepare: vi.fn(async () => ({ task })),
    taskId: () => 'gl-1',
    closeIssueOnMerge: true,
    stages: () => [],
    signalSecretBlock: vi.fn(async () => {}),
    signalBaseRed: vi.fn(async () => {}),
    linkPr: vi.fn(async () => {}),
  };
  const runner = async (file: string, args: string[]): Promise<string> => {
    if (file === 'gh' && args[0] === 'pr') {
      prCreates.push(args);
      return `${PR_URL}\n`;
    }
    return '';
  };
  const host: ReviewHost = {
    kind: 'gh',
    newPrTarget: (pr) => {
      targets.push(pr);
      return openPr ? { kind: 'new-pr', ...pr, cli: 'gh', runner } : { kind: 'local-branch' };
    },
    publishVerdict: vi.fn(async () => {}),
    addFailureLabel: vi.fn(async () => {}),
    addGateConfigLabel: vi.fn(async () => {}),
  };
  return { tracker, host, targets, exec, prepare: vi.fn<() => void>(), prCreates, state };
}

const STAGES: PipelineStage[] = [
  { name: 'implementer', promptTemplate: 'IMPLEMENT', maxTurns: 30, stageCostFraction: 0.6, stageCostFloorUsd: 0.25 },
  { name: 'reviewer', promptTemplate: 'REVIEW', maxTurns: 20 },
];

const BLOCKING = '<findings>' + JSON.stringify({ findings: [{ severity: 'high', kind: 'correctness', title: 'unchecked null deref', evidence: 'src/a.ts:10' }] }) + '</findings>';

type Reply = Partial<AgentRunOutput> | Error;

/** An agent that records every call and answers each one from `reply` (the call's input and its 0-based index). */
function scriptedAgent(reply: (input: AgentRunInput, n: number) => Reply = () => ({})): { agent: AgentProvider; calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = [];
  const agent: AgentProvider = {
    name: 'claude',
    async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      const n = calls.push(input) - 1;
      const r = reply(input, n);
      if (r instanceof Error) throw r;
      yield { text: 'working' };
      return { finalText: 'done <promise>COMPLETE</promise>', turns: 1, sessionId: `sess-${n}`, ...r };
    },
  };
  return { agent, calls };
}

interface RunOptions {
  stages?: PipelineStage[];
  agent?: AgentProvider;
  skillIds?: string[];
  exhausted?: Set<string>;
}

async function run(f: Fakes, deps: Partial<RunIssueDeps> = {}, events: RunEvent[] = [], opts: RunOptions = {}): Promise<Awaited<ReturnType<typeof executeIssueRun>>> {
  const all: RunIssueDeps = { repoPath: repo, onEvent: (e) => events.push(e), ...deps };
  const exhausted = opts.exhausted ?? new Set<string>();
  const plan = await planIssueRun({
    fetchedTask: (await f.tracker.prepare('group/project#1')).task,
    deps: all,
    baseStages: opts.stages ?? [],
    tracker: f.tracker,
    skillIds: opts.skillIds ?? [],
    cooldowns: await readCooldowns(all.repoPath),
    exhausted,
  });
  const ctx = {
    taskId: 'gl-1',
    sandbox: { exec: f.exec, exists: async () => true, copyFileOut: async (_from: string, to: string) => { await mkdir(to, { recursive: true }); } },
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
      changedPaths: async () => ['x.txt'],
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as RunContext;
  const session: IssueRunExecution['session'] = {
    agents: { agent: opts.agent ?? ({ name: 'claude' } as AgentProvider), secrets: {}, proxySecrets: {}, injectAnthropicAuth: false },
    credentials: runCredentialContext(all),
    prepare: async () => {
      f.prepare();
      return ctx;
    },
  };
  const skills = { ids: () => [], inject: async () => {} } as unknown as SkillRegistry;
  return executeIssueRun({ issueRef: 'group/project#1', plan, session, skills, tracker: f.tracker, host: f.host, exhausted });
}

let fileSeq = 0;
/** A change the real `git commit` in the shared worktree can pick up (each test needs a new file). */
async function dirtyTree(f: Fakes): Promise<void> {
  f.state.dirty = true;
  f.state.diff = TOUCH_DIFF;
  await writeFile(join(worktree, `x${fileSeq++}.txt`), 'hello\n');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

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

const verifyDeps = { verifyCmd: 'pnpm test' } as const;
const verifyRuns = (f: Fakes): number => f.exec.mock.calls.filter(([cmd]) => String(cmd) === 'pnpm test').length;
const isReview = (i: AgentRunInput): boolean => i.prompt.includes('REVIEW');
/** The PR body the opened PR was created with. */
const bodyOf = (f: Fakes): string => f.targets[0]!.body({ commitLeaks: [], facts: { configBlock: undefined } as never });

describe('executeIssueRun: repair loop', () => {
  it('a red verify resumes the implementer session and the reviewer then runs once, on the repaired tree', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    f.state.execExits = [1, 0];
    const { agent, calls } = scriptedAgent();
    const result = await run(f, verifyDeps, [], { stages: STAGES, agent });
    expect(result.prUrl).toBe(PR_URL);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({ resumeSessionId: 'sess-0' });
    expect(isReview(calls[2]!)).toBe(true);
    // Red, then green: the repaired tree is the one the reviewer saw, so no third verify and no re-review.
    expect(verifyRuns(f)).toBe(2);
    expect(f.host.addFailureLabel).not.toHaveBeenCalled();
    expect(f.host.publishVerdict).toHaveBeenCalledTimes(1);
    expect(f.targets[0]).toMatchObject({ draft: false });
    expect(bodyOf(f)).toContain(`Closes ${task.id}`);
  });

  it('a green verify never resumes the implementer and never re-reviews', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    const { agent, calls } = scriptedAgent();
    await run(f, verifyDeps, [], { stages: STAGES, agent });
    // The implementer once and the reviewer once: no repair round, no re-review.
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => !isReview(c))).toHaveLength(1);
    expect(isReview(calls[1]!)).toBe(true);
    expect(verifyRuns(f)).toBe(1);
  });

  it('a verify that stays red exhausts the cap, skips the reviewer and ships a labelled partial draft', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    f.state.execExit = 1;
    const { agent, calls } = scriptedAgent();
    const result = await run(f, { ...verifyDeps, maxRepairIterations: 1 }, [], { stages: STAGES, agent });
    expect(result).toMatchObject({ prUrl: PR_URL, verificationFailed: true });
    // The implementer and exactly one repair; the reviewer never ran on a red tree.
    expect(calls).toHaveLength(2);
    expect(calls.some(isReview)).toBe(false);
    expect(f.host.publishVerdict).not.toHaveBeenCalled();
    expect(f.host.addFailureLabel).toHaveBeenCalledWith(PR_URL, 'verify');
    expect(f.targets[0]).toMatchObject({ draft: true });
    expect(bodyOf(f)).not.toContain(`Closes ${task.id}`);
  });

  it('hands the reviewer\'s blocking findings back to the implementer, then publishes the re-review (#673)', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    const { agent, calls } = scriptedAgent((input, n) => (isReview(input) && n === 1 ? { finalText: BLOCKING } : isReview(input) ? { finalText: 'No blocking issues.' } : {}));
    const result = await run(f, verifyDeps, [], { stages: STAGES, agent });
    expect(result.prUrl).toBe(PR_URL);
    // implement, review (blocking), one repair on the implementer's session carrying the finding, re-review.
    expect(calls).toHaveLength(4);
    expect(calls[2]).toMatchObject({ resumeSessionId: 'sess-0' });
    expect(calls[2]!.prompt).toContain('unchecked null deref');
    expect(calls[2]!.prompt).toContain('src/a.ts:10');
    expect(isReview(calls[3]!)).toBe(true);
    // The verdict is the re-review's, never the stale blocking one.
    const verdict = vi.mocked(f.host.publishVerdict).mock.calls[0]![0];
    expect(verdict.reviewerOutcome?.result.finalText).toBe('No blocking issues.');
    // The body carries the re-review's verdict line, once.
    expect(bodyOf(f).match(/^Review: PASS \(0 findings\)$/gm)).toHaveLength(1);
  });

  it('a re-review that fails publishes a masked, incomplete verdict on a draft', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakes(true);
    await dirtyTree(f);
    const token = `ghp_${'a'.repeat(36)}`;
    const { agent } = scriptedAgent((input, n) => {
      if (isReview(input) && n === 1) return { finalText: BLOCKING };
      if (isReview(input)) return new AgentError(`usage limit reached for token ${token}`);
      return {};
    });
    const result = await run(f, verifyDeps, [], { stages: STAGES, agent });
    // Gate-green work still ships, as a draft: nothing reviewed what ships.
    expect(result.prUrl).toBe(PR_URL);
    expect(f.targets[0]).toMatchObject({ draft: true });
    const text = vi.mocked(f.host.publishVerdict).mock.calls[0]![0].reviewerOutcome?.result.finalText ?? '';
    expect(text).toContain('Review unavailable:');
    // A provider error can quote a credential: the verdict comment carries the reason, masked.
    expect(text).toContain('[REDACTED-GH]');
    expect(text).not.toContain(token);
    const body = bodyOf(f);
    expect(body.match(/^Review: INCOMPLETE \(0 findings\)$/gm)).toHaveLength(1);
    expect(body).not.toContain(token);
    expect(f.prCreates.flat().join('\n')).not.toContain(token);
  });

  it('flags the re-review as stopped by a provider limit only for the limit error itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rereviewOf = async (error: Error): Promise<{ stoppedBy?: string; taskId?: string }> => {
      const f = fakes(true);
      await dirtyTree(f);
      const { agent } = scriptedAgent((input, n) => (isReview(input) ? (n === 1 ? { finalText: BLOCKING } : error) : {}));
      await run(f, verifyDeps, [], { stages: STAGES, agent });
      return vi.mocked(f.host.publishVerdict).mock.calls[0]![0].reviewerOutcome?.result ?? {};
    };
    const limited = await rereviewOf(new ProviderLimitError("You've hit your session limit · resets 9pm (UTC)"));
    expect(limited.stoppedBy).toBe('provider-limit');
    // The synthetic outcome carries the run's task id (what the real stages use), not the issue's: stats key on it.
    expect(limited.taskId).toBe('gl-1');
    expect((await rereviewOf(new AgentError('crashed after adding handling for usage limit reached'))).stoppedBy).toBeUndefined();
    expect((await rereviewOf(new AgentError('process crashed; stdout tail: rate_limit_error status code 429'))).stoppedBy).toBeUndefined();
  });
});

describe('executeIssueRun: verdict publishing', () => {
  it('posts one verdict on the opened PR: the pushed head, the reviewer\'s outcome, its provider and the gate flag', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    const { agent } = scriptedAgent((input) => (isReview(input) ? { finalText: 'No blocking issues.' } : {}));
    await run(f, { reviewGate: true }, [], { stages: STAGES, agent });
    expect(f.host.publishVerdict).toHaveBeenCalledTimes(1);
    expect(f.host.publishVerdict).toHaveBeenCalledWith(expect.objectContaining({ prUrl: PR_URL, attribution: 'claude', gate: true, reviewerOutcome: expect.objectContaining({ name: 'reviewer' }) }));
    const body = bodyOf(f);
    expect(body.match(/^Review: PASS \(0 findings\)$/gm)).toHaveLength(1);
    expect(body.indexOf('## Proof of work')).toBeGreaterThan(-1);
    expect(body.indexOf('Review:')).toBeGreaterThan(body.indexOf('## Proof of work'));
    expect(f.tracker.linkPr).toHaveBeenCalledWith('group/project#1', task, PR_URL);
  });

  it('a reviewer that still blocks after the repairs puts CHANGES with its finding count below the proof of work', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    const { agent } = scriptedAgent((input) => (isReview(input) ? { finalText: BLOCKING } : {}));
    await run(f, verifyDeps, [], { stages: STAGES, agent });
    const body = bodyOf(f);
    expect(body.match(/^Review: CHANGES \(1 finding\)$/gm)).toHaveLength(1);
    expect(body.indexOf('Review:')).toBeGreaterThan(body.indexOf('## Proof of work'));
  });

  it('a white-label run posts no verdict and no link-back', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    await run(f, { commitAuthor: { name: 'A', email: 'a@x' } }, [], { stages: STAGES, agent: scriptedAgent().agent });
    expect(f.host.publishVerdict).not.toHaveBeenCalled();
    expect(f.tracker.linkPr).not.toHaveBeenCalled();
  });

  it('a flow without a reviewer has no verdict to post', async () => {
    const f = fakes(true);
    await dirtyTree(f);
    await run(f, {}, [], { stages: [STAGES[0]!], agent: scriptedAgent().agent });
    expect(f.host.publishVerdict).not.toHaveBeenCalled();
    expect(bodyOf(f)).not.toContain('Review:');
    expect(f.tracker.linkPr).toHaveBeenCalledTimes(1);
  });
});

describe('executeIssueRun: model pool limits', () => {
  const POOL = 'claude/sonnet:1, claude/opus:1';
  const limitAgent = (): ReturnType<typeof scriptedAgent> => scriptedAgent(() => new ProviderLimitError("You've hit your usage limit"));

  it('a limit on the picked entry cools it and asks for a re-run; the re-run lands on the next entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pool-retry-'));
    try {
      const exhausted = new Set<string>();
      const first = limitAgent();
      const stopped = run(fakes(), { repoPath: dir, providerModel: POOL }, [], { stages: [STAGES[0]!], agent: first.agent, exhausted });
      await expect(stopped).rejects.toBeInstanceOf(PoolEntryLimited);
      expect(exhausted.size).toBe(1);
      const out = [...exhausted][0]!;
      expect([...(await readCooldowns(dir)).keys()]).toEqual([out]);

      const f = fakes();
      const second = scriptedAgent();
      await run(f, { repoPath: dir, providerModel: POOL }, [], { stages: [STAGES[0]!], agent: second.agent, exhausted });
      const models = [first.calls[0]!.model, second.calls[0]!.model];
      expect(models.sort()).toEqual(['opus', 'sonnet']);
      expect(`claude/${first.calls[0]!.model}`).toBe(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the limit escapes (not a retry) once the only entry is out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pool-out-'));
    try {
      const run1 = run(fakes(), { repoPath: dir, providerModel: 'claude/sonnet:1' }, [], { stages: [STAGES[0]!], agent: limitAgent().agent });
      await expect(run1).rejects.toBeInstanceOf(ProviderLimitError);
      await expect(run1).rejects.not.toBeInstanceOf(PoolEntryLimited);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a simplifier limit cools the run-level entry, not the flow implementer pool named like the tier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pool-flow-'));
    try {
      const stages: PipelineStage[] = [
        { ...STAGES[0]!, model: 'codex/gpt-6-sol:1, claude/sonnet:1' },
        { name: 'simplifier', promptTemplate: 'SIMPLIFY', maxTurns: 10 },
        STAGES[1]!,
      ];
      const f = fakes();
      await dirtyTree(f);
      const { agent } = scriptedAgent((input) => (input.prompt.includes('SIMPLIFY') ? new ProviderLimitError("You've hit your usage limit") : {}));
      const stopped = run(f, { repoPath: dir, provider: 'claude', providerModel: 'claude/opus:1' }, [], { stages, agent });
      await expect(stopped).rejects.toBeInstanceOf(ProviderLimitError);
      // The run-level pool is out, so no restart on a flow-pool re-route.
      await expect(stopped).rejects.not.toBeInstanceOf(PoolEntryLimited);
      expect([...(await readCooldowns(dir)).keys()]).toEqual(['claude/opus']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('planIssueRun ordering', () => {
  it('the model pool resolves to one entry before agent selection reads the options', async () => {
    const plan = await planIssueRun({
      fetchedTask: task,
      deps: { repoPath: repo, providerModel: 'claude/sonnet:1, claude/opus:1' },
      baseStages: STAGES,
      tracker: fakes().tracker,
      skillIds: [],
      cooldowns: new Map(),
      exhausted: new Set(),
    });
    // `choice` is what selectAgents receives: a single resolved entry, never the pool spec.
    expect(['sonnet', 'opus']).toContain(plan.choice.providerModel);
    expect(plan.choice.provider).toBe('claude');
    expect(plan.routing.pooled).toBe(true);
  });
});

describe('stagePicks: the entries a limit moved the stage past', () => {
  const res = { taskId: 't', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '' } as const;

  it('an in-run fallback names the primary that hit its limit, with its reset time', () => {
    const picks = { implementer: { provider: 'claude', model: 'sonnet', pick: 'config' as const }, fallback: { provider: 'codex', pick: 'fallback' as const } };
    const out = stagePicks([{ name: 'implementer', result: res, providerName: 'codex', primaryLimitResetAt: '2026-06-06T11:00:00.000Z' }], picks, 'claude');
    expect(out.implementer).toEqual({ provider: 'codex', pick: 'fallback', skipped: [{ entry: 'claude/sonnet', until: '2026-06-06T11:00:00.000Z' }] });
  });

  it('a re-routed implementer keeps the skipped entries; a stage on its own plain pick has none', () => {
    const skipped = [{ entry: 'claude/', until: '2026-06-06T11:00:00.000Z' }];
    const picks = { implementer: { provider: 'cursor', pick: 'skip-limit' as const, skipped } };
    const out = stagePicks([{ name: 'implementer', result: res, providerName: 'cursor' }, { name: 'reviewer', result: res, providerName: 'codex' }], picks, 'cursor');
    expect(out.implementer).toEqual({ provider: 'cursor', pick: 'skip-limit', skipped });
    expect(out.reviewer).toEqual({ provider: 'codex', pick: 'config' });
  });
});
