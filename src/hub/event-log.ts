// Durable per-run event log: every `api:event` the hub publishes is also appended, one JSON line per
// event, to `<state dir>/runs/<taskId>/<timestamp>.events.jsonl` next to the run's other records, so a
// run's history survives a hub restart and a busy run pushing events out of the EventBus ring.
import { constants } from 'node:fs';
import { open as openFile, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir, isSafeTaskId } from '../core/state-path.js';
import { injectedSecretValues, redactForPublish, withRegisteredSecretValues } from '../core/secret-scan.js';
import { parseSanitizedTimestampMs, readTextNoSymlink, runsRoot, sanitizeTimestamp } from '../core/run-store.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunEventLine, RunEventsPage } from '../wire.js';

/** Suffix of a run's event log; src/hub/watch.ts ignores these (an append is not a snapshot change). */
export const EVENTS_FILE_SUFFIX = '.events.jsonl';
/** Per-run size cap: past it events are dropped (one marker line), the run itself carries on. */
export const MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 5000;
/** The pipeline stamps its run record just before emitting `run-start`, whose receipt names the log:
 * a record's log starts within this window after the record's timestamp. */
const RECORD_TO_LOG_WINDOW_MS = 60_000;
/** Create-only, never through a symlink: a planted file or link at the log's path fails the open. */
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

interface RunLog {
  repoPath: string;
  /** Injected credential values, snapshotted once per run like `beginRun` does. */
  secretValues: string[];
  /** Lines seen before the file is open (bounded by the cap). */
  pending: string[];
  pendingBytes: number;
  /** Set once the file is open and `pending` is drained; every append goes through this one handle. */
  handle?: FileHandle;
  /** `run-start` seen: the file is being opened. */
  opening: boolean;
  bytes: number;
  /** Cap hit, or the file could not be opened: later events are dropped. */
  dead: boolean;
}

function toLine(log: RunLog, id: number, ts: string, event: string, data: unknown): string {
  const redacted = redactForPublish(JSON.stringify({ id, ts, event, data }), withRegisteredSecretValues(log.secretValues));
  try {
    JSON.parse(redacted);
    return redacted;
  } catch {
    // A pattern matched across a JSON boundary: keep the line valid, with the masked text as data.
    return JSON.stringify({ id, ts, event, data: redacted });
  }
}

export interface EventLog {
  /** Feed one bus entry. Only `api:event` entries are persisted. Never throws. */
  record(entry: { id: number; event: string; data: unknown }): void;
  /** Resolves once every write queued so far has settled (tests, shutdown). */
  flush(): Promise<void>;
  /** Shutdown: flush, then close the handle of any run that never reached a terminal event. */
  close(): Promise<void>;
}

export function createEventLog(maxBytes: number = MAX_EVENT_LOG_BYTES): EventLog {
  /** The hub runs one run at a time, so one live log and one write chain suffice. */
  const runs = new Map<string, RunLog>();
  // A disk error must never fail the run, so every queued write swallows its own failure.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    chain = chain.then(work).catch(() => undefined);
  };

  function fail(log: RunLog, why: string): void {
    log.dead = true;
    log.pending = [];
    console.warn(`taskcell: run event log disabled for ${log.repoPath}: ${why}`);
  }

  async function write(log: RunLog, handle: FileHandle, line: string): Promise<void> {
    if (log.dead) return;
    const text = `${line}\n`;
    const size = Buffer.byteLength(text);
    if (log.bytes + size > maxBytes) {
      log.dead = true;
      await handle.write(`${JSON.stringify({ truncated: true, ts: new Date().toISOString(), maxBytes })}\n`);
      return;
    }
    log.bytes += size;
    await handle.write(text);
  }

  function open(log: RunLog, taskId: string, startedAt: string): void {
    log.opening = true;
    if (!isSafeTaskId(taskId)) return fail(log, `unsafe task id ${JSON.stringify(taskId)}`);
    const dir = join(runsRoot(log.repoPath), taskId);
    const file = join(dir, `${sanitizeTimestamp(startedAt)}${EVENTS_FILE_SUFFIX}`);
    enqueue(async () => {
      let handle: FileHandle;
      try {
        await ensureStateDir(log.repoPath, dir);
        await assertStatePath(log.repoPath, file);
        handle = await openFile(file, OPEN_FLAGS);
      } catch (e) {
        return fail(log, e instanceof Error ? e.message : String(e));
      }
      // Drain inside this step (events may land meanwhile), then hand over: later appends queue behind it.
      try {
        for (let line = log.pending.shift(); line !== undefined; line = log.pending.shift()) await write(log, handle, line);
      } finally {
        log.handle = handle; // even after a failed write, so the terminal step still closes it
      }
    });
  }

  /** Queued after the open step, so the handle (if any) is set by the time this runs. */
  function detach(runId: string, log: RunLog): void {
    runs.delete(runId);
    enqueue(async () => {
      await log.handle?.close();
    });
  }

  async function flush(): Promise<void> {
    // Loop: the open step queues the pending lines after the chain was first read.
    for (;;) {
      const seen = chain;
      await seen;
      if (chain === seen) return;
    }
  }

  function accept(runId: string, repoPath: string): RunLog {
    const log: RunLog = { repoPath, secretValues: injectedSecretValues(), pending: [], pendingBytes: 0, opening: false, bytes: 0, dead: false };
    runs.set(runId, log);
    return log;
  }

  return {
    record(entry): void {
      if (entry.event !== 'api:event') return;
      try {
        const { runId, event } = entry.data as { runId?: unknown; event?: { type?: unknown; repoPath?: unknown; taskId?: unknown } };
        if (typeof runId !== 'string' || event === null || typeof event !== 'object') return;
        const ts = new Date().toISOString();
        const log = event.type === 'run-accepted' && typeof event.repoPath === 'string' ? accept(runId, event.repoPath) : runs.get(runId);
        if (log === undefined) return; // a queued run: nothing to attach to until it is accepted
        if (!log.dead) {
          const line = toLine(log, entry.id, ts, entry.event, entry.data);
          const handle = log.handle;
          if (handle !== undefined) {
            enqueue(() => write(log, handle, line));
          } else {
            // Bounded: once the buffer passes the cap the drain will hit it and write the marker anyway.
            if (log.pendingBytes <= maxBytes) {
              log.pendingBytes += Buffer.byteLength(line) + 1;
              log.pending.push(line);
            }
            if (event.type === 'run-start' && typeof event.taskId === 'string' && !log.opening) open(log, event.taskId, ts);
          }
        }
        if (event.type === 'run-end' || event.type === 'run-error' || event.type === 'run-cancelled') detach(runId, log);
      } catch {
        // never break the hub's publish path
      }
    },
    flush,
    async close(): Promise<void> {
      for (const [runId, log] of runs) detach(runId, log);
      await flush();
    },
  };
}

function parseLine(line: string): RunEventLine | 'truncated' | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (v.truncated === true) return 'truncated';
    if (typeof v.id === 'number' && typeof v.ts === 'string' && typeof v.event === 'string') {
      return { id: v.id, ts: v.ts, event: v.event, data: v.data };
    }
  } catch {
    // torn or foreign line: skip
  }
  return undefined;
}

/** A log file name's start timestamp (its `sanitizeTimestamp()` prefix). */
function logStart(name: string): string {
  return name.slice(0, -EVENTS_FILE_SUFFIX.length);
}

/** Epoch ms of an ISO timestamp or its `sanitizeTimestamp()` form (a log name prefix). */
function timestampMs(ts: string): number | undefined {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? parseSanitizedTimestampMs(ts) : ms;
}

/**
 * The log of the run whose record carries `timestamp`: the oldest log started at or within
 * `RECORD_TO_LOG_WINDOW_MS` after it. Bounded on both sides, so a record without a log (a CLI run, a
 * log that failed to open) resolves to none rather than to a neighbouring run's log.
 */
function logFor(logs: string[], timestamp: string): string | undefined {
  const at = timestampMs(timestamp);
  if (at === undefined) throw new BadRequestError('invalid timestamp');
  return logs.find((f) => {
    const started = parseSanitizedTimestampMs(logStart(f));
    return started !== undefined && started >= at && started - at <= RECORD_TO_LOG_WINDOW_MS;
  });
}

/**
 * One page of a run's persisted events with `id > after`, oldest first. `timestamp` is a run record's
 * timestamp (`RunSummary.timestamp`) or a page's `timestamp`: it resolves to the oldest log started at
 * or within a minute after it (see `logFor`). Omitted, the task's newest log. The page reports the
 * resolved log's `timestamp`, so a caller can pin it across pages. Read-only.
 */
export async function readRunEvents(
  repoPath: string,
  taskId: string,
  opts: { timestamp?: string; after?: number; limit?: number } = {},
): Promise<RunEventsPage> {
  if (!isSafeTaskId(taskId)) throw new BadRequestError('invalid taskId');
  const after = opts.after ?? 0;
  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  if (!Number.isInteger(after) || after < 0) throw new BadRequestError('after must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1) throw new BadRequestError('limit must be a positive integer');
  const dir = join(runsRoot(repoPath), taskId);
  const empty: RunEventsPage = { events: [], hasMore: false, truncated: false };
  const logs = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(EVENTS_FILE_SUFFIX)).sort();
  const name = opts.timestamp === undefined ? logs.at(-1) : logFor(logs, opts.timestamp);
  if (name === undefined) return empty;
  const text = await readTextNoSymlink(join(dir, name)).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  const events: RunEventLine[] = [];
  let truncated = false;
  let hasMore = false;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const parsed = parseLine(line);
    if (parsed === 'truncated') truncated = true;
    else if (parsed !== undefined && parsed.id > after) {
      if (events.length >= limit) hasMore = true;
      else events.push(parsed);
    }
  }
  return { events, hasMore, truncated, timestamp: logStart(name) };
}
