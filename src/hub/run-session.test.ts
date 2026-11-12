import { describe, expect, test, vi } from 'vitest';
import { createRunSession, MAX_CONCURRENT_RUNS } from './run-session.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from '../sidecar/sidecar.js';
import type { RunEvent } from '../pipeline/events.js';

function fakeDeps(createRun: SidecarDeps['createRun']): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: unimplemented,
    createRun,
    createTask: unimplemented,
    listFlows: unimplemented,
    listProviders: unimplemented,
    readFlow: unimplemented,
    writeFlow: unimplemented,
    deleteFlow: unimplemented,
    listTasks: unimplemented,
    fetchSpec: unimplemented,
    listRepoFiles: unimplemented,
    readRepoFile: unimplemented,
    listRuns: unimplemented,
    readRun: unimplemented,
  };
}

function collectPublished(): { name: string; payload: unknown }[] {
  return [];
}

describe('run-session', () => {
  test('T-42 run-accepted is the first event and carries repoPath', async () => {
    const published: { name: string; payload: unknown }[] = collectPublished();
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      return { prUrl: 'https://pr/1' };
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    expect(published[0]?.payload).toMatchObject({ event: { type: 'run-accepted', repoPath: '/repo' } });
  });

  test('T-43 blank/absent repoPath is rejected before a runId is minted', async () => {
    const deps = fakeDeps(async () => ({}));
    const published: unknown[] = [];
    const session = createRunSession(deps, (_n, p) => published.push(p));
    await expect(session.createRun({ issueRef: '1', repoPath: '  ' } as CreateRunParams)).rejects.toThrow(
      /repoPath is required/,
    );
    expect(published).toHaveLength(0);
    expect(session.activeRun()).toBeNull();
  });

  test('T-44 a second run is queued, starts after the first ends, both return a runId', async () => {
    let resolveFirst: ((r: CreateRunResult) => void) | undefined;
    let calls = 0;
    const published: { runId: string; event: { type: string } }[] = [];
    const deps = fakeDeps(
      () =>
        new Promise<CreateRunResult>((resolve) => {
          calls += 1;
          if (calls === 1) resolveFirst = resolve;
          else resolve({});
        }),
    );
    const session = createRunSession(deps, (_n, p) => published.push(p as (typeof published)[number]));
    const firstPromise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const firstActive = session.activeRun();
    expect(firstActive).not.toBeNull();
    const secondPromise = session.createRun({ issueRef: '2', repoPath: '/repo2' } as CreateRunParams);
    await Promise.resolve();
    expect(session.activeRun()).toEqual(firstActive);
    expect(session.queued()).toEqual([{ runId: 'run-1', repoPath: '/repo2', position: 1 }]);
    expect(published.at(-1)).toEqual({ runId: 'run-1', event: { type: 'run-queued', position: 1, repoPath: '/repo2' } });
    expect(calls).toBe(1);
    resolveFirst?.({});
    await firstPromise;
    await secondPromise;
    expect(calls).toBe(2);
    expect(session.queued()).toEqual([]);
    expect(published.some((p) => p.runId === 'run-1' && p.event.type === 'run-accepted')).toBe(true);
    expect(MAX_CONCURRENT_RUNS).toBe(1);
  });

  test('T-44b cancelling a queued run removes it, emits run-cancelled, leaves the active run alone', async () => {
    let resolveFirst: ((r: CreateRunResult) => void) | undefined;
    const published: { runId: string; event: { type: string } }[] = [];
    const deps = fakeDeps(() => new Promise<CreateRunResult>((resolve) => { resolveFirst ??= resolve; }));
    const session = createRunSession(deps, (_n, p) => published.push(p as (typeof published)[number]));
    const firstPromise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const queuedPromise = session.createRun({ issueRef: '2', repoPath: '/repo' } as CreateRunParams);
    session.cancel('run-1');
    await expect(queuedPromise).rejects.toThrow(/cancelled/);
    expect(published.at(-1)).toEqual({ runId: 'run-1', event: { type: 'run-cancelled' } });
    expect(session.queued()).toEqual([]);
    expect(session.activeRun()?.runId).toBe('run-0');
    resolveFirst?.({});
    await firstPromise;
  });

  test('T-44d a cancelled queued run is evicted like any settled run (no unbounded buffer)', async () => {
    const session = createRunSession(fakeDeps(() => new Promise<CreateRunResult>(() => {})), () => {});
    void session.createRun({ issueRef: '0', repoPath: '/repo' } as CreateRunParams);
    for (let i = 1; i <= 5; i += 1) {
      const p = session.createRun({ issueRef: String(i), repoPath: '/repo' } as CreateRunParams);
      p.catch(() => {});
      session.cancel(`run-${i}`);
    }
    // RETAINED_RUNS=4: the first cancelled queued run's buffer is gone, the last one's is kept.
    expect(session.backlog('run-1')).toEqual([]);
    expect(session.backlog('run-5').length).toBeGreaterThan(0);
  });

  test('T-44e a queued run keeps one run-queued while waiting, and starts with run-accepted at index 0', async () => {
    let resolveFirst: ((r: CreateRunResult) => void) | undefined;
    const deps = fakeDeps(
      () =>
        new Promise<CreateRunResult>((resolve) => {
          if (resolveFirst === undefined) resolveFirst = resolve;
          else resolve({});
        }),
    );
    const session = createRunSession(deps, () => {});
    const first = session.createRun({ issueRef: '0', repoPath: '/repo' } as CreateRunParams);
    const second = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const third = session.createRun({ issueRef: '2', repoPath: '/repo3' } as CreateRunParams);
    third.catch(() => {});
    session.cancel('run-1'); // republishes run-2's position
    expect(session.backlog('run-2')).toEqual([{ runId: 'run-2', event: { type: 'run-queued', position: 1, repoPath: '/repo3' } }]);
    await expect(second).rejects.toThrow(/cancelled/);
    resolveFirst?.({});
    await first;
    await third;
    const backlog = session.backlog('run-2') as { event: { type: string } }[];
    expect(backlog[0]?.event.type).toBe('run-accepted');
    expect(backlog.some((e) => e.event.type === 'run-queued')).toBe(false);
  });

  test('T-44f the start-time check runs when a queued run starts and fails it with run-error', async () => {
    let resolveFirst: ((r: CreateRunResult) => void) | undefined;
    let calls = 0;
    const deps = fakeDeps(
      () =>
        new Promise<CreateRunResult>((resolve) => {
          calls += 1;
          resolveFirst = resolve;
        }),
    );
    let revoked = false;
    const session = createRunSession(deps, () => {}, async (p) => {
      if (revoked && p.repoPath === '/gone') throw new Error('not an allowed project');
    });
    const first = session.createRun({ issueRef: '0', repoPath: '/repo' } as CreateRunParams);
    const queued = session.createRun({ issueRef: '1', repoPath: '/gone' } as CreateRunParams);
    await Promise.resolve();
    revoked = true; // the project is unbound while its run waits
    resolveFirst?.({});
    await first;
    await expect(queued).rejects.toThrow(/not an allowed project/);
    expect(calls).toBe(1);
    const backlog = session.backlog('run-1') as { event: { type: string } }[];
    expect(backlog.at(-1)?.event).toEqual({ type: 'run-error', message: 'not an allowed project' });
    expect(backlog.some((e) => e.event.type === 'run-accepted')).toBe(false); // refused, never announced
  });

  test('T-44h a stale cancel(id) for a finished run leaves the promoted next run running', async () => {
    const resolvers: ((r: CreateRunResult) => void)[] = [];
    const deps = fakeDeps(() => new Promise<CreateRunResult>((resolve) => resolvers.push(resolve)));
    const session = createRunSession(deps, () => {});
    const first = session.createRun({ issueRef: '0', repoPath: '/repo' } as CreateRunParams);
    const second = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    second.catch(() => {});
    resolvers[0]?.({});
    await first;
    expect(session.activeRun()?.runId).toBe('run-1');
    session.cancel('run-0'); // a late Stop click on the run that already ended
    expect(session.activeRun()?.runId).toBe('run-1');
    resolvers[1]?.({});
    await expect(second).resolves.toEqual({});
    expect((session.backlog('run-1') as { event: { type: string } }[]).some((e) => e.event.type === 'run-cancelled')).toBe(false);
  });

  test('T-44i a cancel during the start-time check ends the run as cancelled without starting it', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const deps = fakeDeps(async () => {
      calls += 1;
      return {};
    });
    const session = createRunSession(deps, () => {}, () => new Promise<void>((resolve) => (release = resolve)));
    const run = session.createRun({ issueRef: '0', repoPath: '/repo' } as CreateRunParams);
    session.cancel('run-0');
    release?.();
    await expect(run).rejects.toThrow(/cancelled/);
    expect(calls).toBe(0);
    expect((session.backlog('run-0') as { event: { type: string } }[]).at(-1)?.event).toEqual({ type: 'run-cancelled' });
  });

  test('T-44g a blank VANGUARD_HUB_MAX_QUEUE falls back to the default instead of disabling the queue', () => {
    vi.stubEnv('VANGUARD_HUB_MAX_QUEUE', '');
    try {
      const session = createRunSession(fakeDeps(() => new Promise<CreateRunResult>(() => {})), () => {});
      void session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
      void session.createRun({ issueRef: '2', repoPath: '/repo' } as CreateRunParams).catch(() => {});
      expect(session.queued()).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('T-44j a second queued run for the same project is refused, naming the queued one', async () => {
    const session = createRunSession(fakeDeps(() => new Promise<CreateRunResult>(() => {})), () => {});
    void session.createRun({ issueRef: '0', repoPath: '/repo' } as CreateRunParams);
    void session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams).catch(() => {});
    await expect(session.createRun({ issueRef: '2', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow(
      '/repo already has a queued run (run-1)',
    );
    void session.createRun({ issueRef: '3', repoPath: '/other' } as CreateRunParams).catch(() => {});
    expect(session.queued().map((q) => q.repoPath)).toEqual(['/repo', '/other']);
  });

  test('T-44c past the cap createRun is rejected with a message naming the limit', async () => {
    vi.stubEnv('VANGUARD_HUB_MAX_QUEUE', '1');
    try {
      const session = createRunSession(fakeDeps(() => new Promise<CreateRunResult>(() => {})), () => {});
      void session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
      void session.createRun({ issueRef: '2', repoPath: '/repo' } as CreateRunParams).catch(() => {});
      await expect(session.createRun({ issueRef: '3', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow(
        'queue is full (max 1 queued runs)',
      );
      expect(session.queued()).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('T-45 success emits exactly one terminal (run-end from the stream, none synthesized)', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end', prUrl: 'https://pr/9' } as RunEvent);
      return { prUrl: 'https://pr/9' };
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const terminals = published.filter((p) => {
      const t = (p.payload as { event?: { type?: string } }).event?.type;
      return t === 'run-end' || t === 'run-error' || t === 'run-cancelled';
    });
    expect(terminals).toHaveLength(1);
    expect((terminals[0]?.payload as { event: { type: string } }).event.type).toBe('run-end');
  });

  test('T-46 a thrown outcome synthesizes run-error', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async () => {
      throw new Error('boom');
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await expect(session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow('boom');
    const terminal = published.at(-1)?.payload as { event: { type: string; message?: string } };
    expect(terminal.event).toEqual({ type: 'run-error', message: 'boom' });
  });

  test('T-47 a cancelled run synthesizes run-cancelled', async () => {
    const published: { name: string; payload: unknown }[] = [];
    let onEventRef: ((e: RunEvent) => void) | undefined;
    const deps = fakeDeps(
      (_params, onEvent) =>
        new Promise<CreateRunResult>((_resolve, reject) => {
          onEventRef = onEvent;
          setTimeout(() => reject(new Error('aborted')), 0);
        }),
    );
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    const promise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    await Promise.resolve();
    session.cancel();
    void onEventRef;
    await expect(promise).rejects.toThrow('aborted');
    const terminal = published.at(-1)?.payload as { event: { type: string } };
    expect(terminal.event).toEqual({ type: 'run-cancelled' });
  });

  test('T-48 no second terminal after a streamed run-end followed by a teardown throw', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      throw new Error('teardown blew up after run-end');
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await expect(session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow();
    const terminals = published.filter((p) => {
      const t = (p.payload as { event?: { type?: string } }).event?.type;
      return t === 'run-end' || t === 'run-error' || t === 'run-cancelled';
    });
    expect(terminals).toHaveLength(1);
    expect((terminals[0]?.payload as { event: { type: string } }).event.type).toBe('run-end');
  });

  test('T-49 buffer eviction drops index 1 and retains run-accepted', async () => {
    const deps = fakeDeps(async (_params, onEvent) => {
      for (let i = 0; i < 2010; i += 1) onEvent({ type: 'cost', usdSpent: i } as unknown as RunEvent);
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    const session = createRunSession(deps, () => {});
    // Read the minted runId SYNCHRONOUSLY, right after the call: createRun runs synchronously up to
    // its first internal `await`, so `activeRun()` is already populated with no need to yield first
    // (yielding here races against the run's own completion for a deps fake with no internal awaits).
    const promise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const runId = session.activeRun()?.runId ?? '';
    await promise;
    const backlog = session.backlog(runId) as { event: { type: string } }[];
    expect(backlog.length).toBe(2000);
    expect(backlog[0]?.event.type).toBe('run-accepted');
  });

  test('T-50 RETAINED_RUNS eviction of completed runs', async () => {
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    const session = createRunSession(deps, () => {});
    const runIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const promise = session.createRun({ issueRef: String(i), repoPath: '/repo' } as CreateRunParams);
      const id = session.activeRun()?.runId;
      await promise;
      if (id !== undefined) runIds.push(id);
    }
    // The first two of six runs should have been evicted (RETAINED_RUNS=4).
    expect(session.backlog(runIds[0] as string)).toEqual([]);
    expect(session.backlog(runIds[1] as string)).toEqual([]);
    expect(session.backlog(runIds[5] as string).length).toBeGreaterThan(0);
  });

  test('T-51 active is cleared on a throw', async () => {
    const deps = fakeDeps(async () => {
      throw new Error('boom');
    });
    const session = createRunSession(deps, () => {});
    await expect(session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow();
    expect(session.activeRun()).toBeNull();
  });

  test('T-52 a finished runs stale cancel flag cannot land on the next runs terminal', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    // cancel() while idle must not affect the NEXT run.
    session.cancel();
    published.length = 0;
    await session.createRun({ issueRef: '2', repoPath: '/repo' } as CreateRunParams);
    const terminal = published.at(-1)?.payload as { event: { type: string } };
    expect(terminal.event.type).toBe('run-end');
  });

  test('T-53 cancel() while idle is a no-op', () => {
    const session = createRunSession(fakeDeps(async () => ({})), () => {});
    expect(() => session.cancel()).not.toThrow();
    expect(session.activeRun()).toBeNull();
  });
});


describe('run-session event log', () => {
  /** A session whose run emits run-start then run-end for T-9. */
  const endingSession = (): ReturnType<typeof createRunSession> => {
    let id = 0;
    const deps = fakeDeps(async (_p, onEvent) => {
      onEvent({ type: 'run-start', taskId: 'T-9', flow: 'f', provider: 'p', stages: [] } as RunEvent);
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    return createRunSession(deps, () => ++id);
  };

  test('a run persists its events, readable after it settles', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readRunEvents } = await import('./run-events.js');
    const repo = await mkdtemp(join(tmpdir(), 'run-session-log-'));
    try {
      const session = endingSession();
      await session.createRun({ issueRef: '1', repoPath: repo } as CreateRunParams);
      const page = await readRunEvents(repo, 'T-9');
      expect(page.events.map((e) => (e.data as { event: { type: string } }).event.type)).toEqual(['run-accepted', 'run-start', 'run-end']);
      expect(page.events.map((e) => e.id)).toEqual([1, 2, 3]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('a run completes when its event log cannot be written', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const repo = await mkdtemp(join(tmpdir(), 'run-session-log-'));
    try {
      await writeFile(join(repo, '.taskcell'), 'not a directory'); // the state dir cannot be created
      const session = endingSession();
      await expect(session.createRun({ issueRef: '1', repoPath: repo } as CreateRunParams)).resolves.toBeDefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
