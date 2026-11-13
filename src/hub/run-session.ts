// Port of the run-state machine in apps/desktop/src-tauri/src/sidecar.rs (api_create_run and its
// supporting functions: emit_event, finish_run, resolve_terminal, has_terminal, buffer eviction) —
// minus the child process and its pipe mutex, since the hub calls the sidecar's typed deps IN-PROCESS.
// See that file for the original Rust implementation and its "why" comments.
import { cancelCurrent } from '../sidecar/cancel.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { RunEventLog } from './run-events.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from '../sidecar/sidecar.js';

/**
 * Single-in-flight only, for now. Documents the gate rather than driving it: the session holds one
 * `active` slot, so supporting more needs that slot turned into a set AND src/sidecar/cancel.ts's
 * module-global AbortController replaced with a per-run registry (wave 2).
 * Raising the hub's throughput beyond this slot is `VANGUARD_MAX_SANDBOXES`'s job, not the queue's
 * (the queue below only changes what happens to a SECOND caller while this one slot is busy).
 */
export const MAX_CONCURRENT_RUNS = 1;
/** Completed runs kept in the backlog buffer before eviction. */
const RETAINED_RUNS = 4;
/** Per-run event cap (crash guard) — a real run emits ~dozens; beyond this the oldest are dropped. */
const MAX_EVENTS_PER_RUN = 2000;
/** `VANGUARD_HUB_MAX_QUEUE` default — how many callers may wait behind the one running slot before
 * `createRun` starts refusing with a bad-request instead of growing the queue without bound. */
export const DEFAULT_MAX_QUEUE = 10;

interface QueuedRun {
  runId: string;
  params: CreateRunParams;
  resolve: (result: CreateRunResult) => void;
  reject: (error: unknown) => void;
  hooks?: RunHooks;
  /** Waited in the queue first: its admission was already reported by `onQueued`. */
  wasQueued?: boolean;
}

interface BufferedEvent {
  runId: string;
  event: unknown;
}

function eventType(entry: BufferedEvent): string | undefined {
  const event = entry.event as { type?: unknown } | null;
  return typeof event?.type === 'string' ? event.type : undefined;
}

export interface RunHooks {
  onStarted?: (runId: string) => void;
  onQueued?: (runId: string) => void;
  onRefused?: (runId: string) => void;
}

export interface RunSession {
  /** `hooks` report the run's admission, each at most once, before it ends: `onStarted` once a run that
   * did not queue passes the start-time check, `onQueued` when it waits, `onRefused` when that check
   * (the allowlist re-check) refuses it — including a queued run's, once promoted. */
  createRun(params: CreateRunParams, hooks?: RunHooks): Promise<CreateRunResult>;
  activeRun(): { runId: string; repoPath: string } | null;
  /** Runs waiting behind the active one, in start order — `position` is 1-based (1 = next to run). */
  queued(): { runId: string; repoPath: string; position: number }[];
  backlog(runId: string): unknown[];
  /** `runId` given: cancel exactly that run, active or queued. Omitted: cancel the active run (the
   * pre-queue call shape every existing caller still uses). Unknown/already-settled id is a no-op. */
  cancel(runId?: string): void;
}

function maxQueueLimit(): number {
  const raw = process.env.VANGUARD_HUB_MAX_QUEUE;
  // Unset or blank falls back to the default — `Number('')` is 0, which would silently disable queueing.
  const env = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(env) && env >= 0 ? Math.floor(env) : DEFAULT_MAX_QUEUE;
}

/**
 * Create one run session bound to a single `SidecarDeps` + event publisher. One instance is shared
 * by every RPC call for the hub's lifetime (or per-repo, in a future multi-slot wave 2) — it owns the
 * single-in-flight gate, the FIFO queue behind it, the event ring buffers, and the cancel-flag
 * bookkeeping. The queue lives only in this in-memory array: a hub restart drops every queued run
 * (see docs/hub.md) — same as the active run and the event buffers above.
 *
 * `assertStart` re-checks a run's params right before it starts (the hub passes its repo allowlist
 * check): a queued run may start long after `createRun`, and its project may have been unbound since.
 */
export function createRunSession(
  deps: SidecarDeps,
  publish: (name: string, payload: unknown) => number | void,
  assertStart?: (params: CreateRunParams) => Promise<void>,
): RunSession {
  let active: { runId: string; repoPath: string } | null = null;
  let counter = 0;
  const buffer = new Map<string, BufferedEvent[]>();
  /** The running run's durable event log (one active run at a time). */
  let eventLog: { runId: string; log: RunEventLog } | null = null;
  /** Completed-run ids in finish order, for bounded eviction. */
  const order: string[] = [];
  /** A runId for which cancel was requested — its terminal is `run-cancelled`, not `run-error`. */
  let cancelledRunId: string | null = null;
  /** FIFO — index 0 is next to start once the active slot frees up. */
  const queue: QueuedRun[] = [];
  const maxQueue = maxQueueLimit();

  function bufferPush(runId: string, payload: BufferedEvent): void {
    let events = buffer.get(runId);
    if (events === undefined) {
      events = [];
      buffer.set(runId, events);
    }
    events.push(payload);
    if (events.length > MAX_EVENTS_PER_RUN) {
      // Evict the SECOND-oldest, never index 0: index 0 is the run's seeding event (`run-accepted`, or
      // `run-queued` for a run that never started) — the only events allowed to seed a strip
      // re-attach; evicting it would make an over-cap run's re-attach fold nothing.
      events.splice(1, 1);
    }
  }

  function hasTerminal(runId: string): boolean {
    const events = buffer.get(runId);
    if (events === undefined) return false;
    return events.some((e) => {
      const t = eventType(e);
      return t === 'run-end' || t === 'run-error' || t === 'run-cancelled';
    });
  }

  function emit(runId: string, event: unknown): void {
    const payload: BufferedEvent = { runId, event };
    bufferPush(runId, payload);
    let id: number | void = undefined;
    try {
      id = publish('api:event', payload);
    } catch {
      // A broken publisher must not break the run itself.
    }
    if (typeof id === 'number' && eventLog?.runId === runId) {
      const e = event as { type?: unknown; taskId?: unknown } | null;
      const taskId = e?.type === 'run-start' && typeof e.taskId === 'string' ? e.taskId : undefined;
      eventLog.log.append({ id, ts: new Date().toISOString(), event: 'api:event', data: payload }, taskId);
    }
  }

  /** Clear `active` (only if it still names THIS run — a late finish must not disarm a successor that
   * already took over) and evict beyond RETAINED_RUNS. Both callers already read-and-cleared
   * `cancelledRunId` for this run before calling, so there is nothing left to clear here. */
  function finishRun(runId: string): void {
    if (active !== null && active.runId === runId) {
      active = null;
    }
    order.push(runId);
    if (order.length > RETAINED_RUNS) {
      const old = order.shift();
      if (old !== undefined) buffer.delete(old);
    }
  }

  /** Announce a queued run's position. Its buffer holds only the LATEST `run-queued` (replaced, not
   * appended), so re-announcing positions as the queue drains stays O(N), and `execute` can drop it
   * to keep `run-accepted` at index 0 once the run starts. */
  function emitQueued(q: QueuedRun, position: number): void {
    const payload: BufferedEvent = { runId: q.runId, event: { type: 'run-queued', position, repoPath: q.params.repoPath } };
    buffer.set(q.runId, [payload]);
    try {
      publish('api:event', payload);
    } catch {
      // A broken publisher must not break the queue.
    }
  }

  /** Re-announce every still-queued run's position after the queue's shape changes (a start or a
   * cancel) — otherwise a position shown to a client would go stale as runs ahead of it clear. */
  function republishQueue(): void {
    queue.forEach((q, i) => emitQueued(q, i + 1));
  }

  /** Run one entry to completion (mirrors the old single-shot `createRun` body) and settle its
   * promise instead of returning/throwing, since by the time this runs the original `createRun`
   * call has already returned the entry's runId to its caller. Starts the next queued entry, if
   * any, once this slot frees up. */
  async function execute(entry: QueuedRun): Promise<void> {
    const { runId, params, resolve, reject } = entry;
    const repoPath = params.repoPath;
    active = { runId, repoPath }; // hold the slot across the start-time check below

    let result: CreateRunResult | undefined;
    let errMessage: string | undefined;
    try {
      // Before `run-accepted`: a run refused here is never announced as started.
      if (assertStart !== undefined) {
        try {
          await assertStart(params);
        } catch (error) {
          entry.hooks?.onRefused?.(runId);
          throw error;
        }
      }
      // A cancel landing during that await armed no controller yet — honour it here, not in the run.
      if (cancelledRunId === runId) throw new Error('run cancelled');
      if (entry.wasQueued !== true) entry.hooks?.onStarted?.(runId);
      // Drop the queued-phase `run-queued` so `run-accepted` is index 0 — the eviction invariant in
      // bufferPush, and the only event a strip re-attach may adopt from.
      buffer.delete(runId);
      eventLog = { runId, log: new RunEventLog(repoPath) };
      emit(runId, { type: 'run-accepted', repoPath });
      result = await deps.createRun(params, (e) => emit(runId, e));
    } catch (error) {
      errMessage = error instanceof Error ? error.message : String(error);
    }

    try {
      // Was this run cancelled? Read + clear the flag BEFORE finishRun so the terminal below is
      // computed against the pre-cleanup state, mirroring the Rust RunGuard's Drop order (the guard
      // releases `active`/`cancelled` only after the terminal is decided and emitted).
      const wasCancelled = cancelledRunId === runId;
      if (wasCancelled) cancelledRunId = null;

      if (result !== undefined) {
        // The pipeline already streamed `run-end`; no terminal to synthesize.
        await flushLog(runId);
        resolve(result);
      } else {
        const terminal = wasCancelled ? { type: 'run-cancelled' } : { type: 'run-error', message: errMessage ?? 'run failed' };
        // Only synthesize if no terminal was already streamed (e.g. run-end emitted, then a teardown
        // throw) — "exactly one terminal" must hold even on that path.
        if (!hasTerminal(runId)) emit(runId, terminal);
        await flushLog(runId);
        reject(new Error(errMessage ?? 'run failed'));
      }
    } finally {
      if (eventLog?.runId === runId) eventLog = null;
      // Unconditional: a throw above must not leave `active` set and wedge every queued run behind it.
      finishRun(runId);
      startNext();
    }
  }

  /** Settle the run's pending event-log writes (never rejects) so a settled run's log is complete on disk. */
  async function flushLog(runId: string): Promise<void> {
    if (eventLog?.runId === runId) await eventLog.log.flush();
  }

  /** Promote the head of the queue into the active slot, if the slot is free and the queue is
   * non-empty. No-op otherwise. Called after a finish only: a queued cancel never frees the slot. */
  function startNext(): void {
    if (active !== null) return;
    const next = queue.shift();
    if (next === undefined) return;
    republishQueue();
    void execute(next);
  }

  return {
    activeRun: () => active,
    queued: () => queue.map((q, i) => ({ runId: q.runId, repoPath: q.params.repoPath, position: i + 1 })),
    /** The buffered `{runId, event}` payloads for a run, for a re-attaching strip — mirrors Rust's
     * `api_run_backlog`, which returns the same full payloads it buffered (not bare events). */
    backlog: (runId) => buffer.get(runId) ?? [],
    cancel: (runId) => {
      if (runId !== undefined) {
        const index = queue.findIndex((q) => q.runId === runId);
        if (index !== -1) {
          const [removed] = queue.splice(index, 1);
          emit(runId, { type: 'run-cancelled' });
          finishRun(runId); // bounded eviction of its buffer, like any settled run
          removed!.reject(new Error('run cancelled while queued'));
          republishQueue();
          return;
        }
        if (active === null || active.runId !== runId) return; // unknown or already-settled id: no-op
      }
      // Out-of-band, direct — no signals: in-process execution means there is no child to SIGUSR2.
      if (active !== null) cancelledRunId = active.runId;
      cancelCurrent();
    },
    async createRun(params, hooks): Promise<CreateRunResult> {
      // repoPath is required BEFORE minting a runId, so `run-accepted`'s payload is always a string
      // and a rejected call never burns an id.
      const repoPath = params.repoPath;
      if (typeof repoPath !== 'string' || repoPath.trim() === '') {
        throw new BadRequestError('repoPath is required and must be a non-blank string');
      }
      if (active !== null && queue.length >= maxQueue) {
        throw new BadRequestError(
          maxQueue === 0
            ? 'a run is already in flight (queueing is disabled: VANGUARD_HUB_MAX_QUEUE=0)'
            : `the run queue is full (max ${maxQueue} queued runs) — try again once a run finishes`,
        );
      }
      // One queued run per project: the desktop shows one strip per project, so a second queued run
      // there would get no strip (and no Stop) after a reload.
      const waiting = active !== null ? queue.find((q) => q.params.repoPath === repoPath) : undefined;
      if (waiting !== undefined) {
        throw new BadRequestError(`${repoPath} already has a queued run (${waiting.runId}) — cancel it or wait for it to start`);
      }
      const runId = `run-${counter}`;
      counter += 1;
      return new Promise<CreateRunResult>((resolve, reject) => {
        const entry: QueuedRun = { runId, params, resolve, reject, ...(hooks !== undefined ? { hooks } : {}) };
        if (active === null) {
          void execute(entry);
          return;
        }
        entry.wasQueued = true;
        queue.push(entry);
        hooks?.onQueued?.(runId);
        emitQueued(entry, queue.length);
      });
    },
  };
}
