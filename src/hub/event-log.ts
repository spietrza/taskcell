// Durable per-run event log: every `api:event` the hub publishes is also appended, one JSON line per
// event, to `<state dir>/runs/<taskId>/<timestamp>.events.jsonl` next to the run's other records, so a
// run's history survives a hub restart and a busy run pushing events out of the EventBus ring.
import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir, isSafeTaskId } from '../core/state-path.js';
import { injectedSecretValues, redactForPublish, withRegisteredSecretValues } from '../core/secret-scan.js';
import { readTextNoSymlink, runsRoot, sanitizeTimestamp } from '../core/run-store.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunEventLine, RunEventsPage } from '../wire.js';

/** Suffix of a run's event log; src/hub/watch.ts ignores these (an append is not a snapshot change). */
export const EVENTS_FILE_SUFFIX = '.events.jsonl';
/** Per-run size cap: past it events are dropped (one marker line), the run itself carries on. */
export const MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 5000;

interface RunLog {
  repoPath: string;
  startedAt: string;
  /** Injected credential values, snapshotted once per run like `beginRun` does. */
  secretValues: string[];
  /** Lines seen before `run-start` names the task dir (bounded by the cap). */
  pending: string[];
  pendingBytes: number;
  file?: string;
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

  function append(log: RunLog, line: string): void {
    const file = log.file;
    if (file === undefined || log.dead) return;
    const text = `${line}\n`;
    const size = Buffer.byteLength(text);
    if (log.bytes + size > maxBytes) {
      log.dead = true;
      const marker = `${JSON.stringify({ truncated: true, ts: new Date().toISOString(), maxBytes })}\n`;
      enqueue(() => appendFile(file, marker));
      return;
    }
    log.bytes += size;
    enqueue(() => appendFile(file, text));
  }

  function open(log: RunLog, taskId: string): void {
    if (!isSafeTaskId(taskId)) return fail(log, `unsafe task id ${JSON.stringify(taskId)}`);
    const dir = join(runsRoot(log.repoPath), taskId);
    const file = join(dir, `${sanitizeTimestamp(log.startedAt)}${EVENTS_FILE_SUFFIX}`);
    enqueue(async () => {
      try {
        await ensureStateDir(log.repoPath, dir);
        await assertStatePath(log.repoPath, file);
      } catch (e) {
        return fail(log, e instanceof Error ? e.message : String(e));
      }
      log.file = file;
      for (const line of log.pending.splice(0)) append(log, line);
    });
  }

  return {
    record(entry): void {
      if (entry.event !== 'api:event') return;
      try {
        const { runId, event } = entry.data as { runId?: unknown; event?: { type?: unknown; repoPath?: unknown; taskId?: unknown } };
        if (typeof runId !== 'string' || event === null || typeof event !== 'object') return;
        const ts = new Date().toISOString();
        let log = runs.get(runId);
        if (event.type === 'run-accepted' && typeof event.repoPath === 'string') {
          log = { repoPath: event.repoPath, startedAt: ts, secretValues: injectedSecretValues(), pending: [], pendingBytes: 0, bytes: 0, dead: false };
          runs.set(runId, log);
        }
        if (log === undefined) return; // a queued run: nothing to attach to until it is accepted
        if (!log.dead) {
          const line = toLine(log, entry.id, ts, entry.event, entry.data);
          if (log.file !== undefined) {
            append(log, line);
          } else {
            // Bounded: once the buffer passes the cap the flush will hit it and write the marker anyway.
            if (log.pendingBytes <= maxBytes) {
              log.pendingBytes += Buffer.byteLength(line) + 1;
              log.pending.push(line);
            }
            if (event.type === 'run-start' && typeof event.taskId === 'string' && !log.dead) open(log, event.taskId);
          }
        }
        if (event.type === 'run-end' || event.type === 'run-error' || event.type === 'run-cancelled') {
          runs.delete(runId);
        }
      } catch {
        // never break the hub's publish path
      }
    },
    async flush(): Promise<void> {
      // Loop: the open step queues the pending lines after the chain was first read.
      for (;;) {
        const seen = chain;
        await seen;
        if (chain === seen) return;
      }
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

/**
 * One page of a run's persisted events with `id > after`, oldest first. `timestamp` is a run record's
 * timestamp (`RunSummary.timestamp`): it resolves to the newest log that started at or before it,
 * because the hub opens a run's log before the pipeline stamps the record. Omitted, the task's newest
 * log. The page reports the resolved log's `timestamp`, so a caller can pin it across pages. Read-only.
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
  const bound = opts.timestamp === undefined ? undefined : sanitizeTimestamp(opts.timestamp);
  const name = bound === undefined ? logs.at(-1) : logs.filter((f) => f.slice(0, -EVENTS_FILE_SUFFIX.length) <= bound).at(-1);
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
  return { events, hasMore, truncated, timestamp: name.slice(0, -EVENTS_FILE_SUFFIX.length) };
}
