// Durable per-run event log: every `api:event` the hub publishes for a run is appended as one JSONL
// line to `<state dir>/runs/<taskId>/events-<start>.jsonl`, so a run's history survives a hub restart
// and a busy run pushing events out of EventBus's 500-event ring. The `id` is the SSE `id:` the bus
// assigned, so a client can read history with `readRunEvents` and then continue on the live stream
// (skipping ids it already has) without a gap or a duplicate.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextNoSymlink, sanitizeTimestamp } from '../core/run-store.js';
import { appendAudit, BOT_ACTOR, localAdapter, STREAMS, type AuditAdapter, type AuditContext } from '../core/audit.js';
import { parseJsonlLines } from '../core/stats.js';
import { assertStatePath, isSafeTaskId, stateDir } from '../core/state-path.js';

/** Per-run size cap (bytes): a runaway run's events are dropped past it, the run itself carries on. */
export const MAX_RUN_EVENT_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EVENTS_LIMIT = 500;
export const MAX_EVENTS_LIMIT = 2000;

/** What the audit envelope (actor, subject, prev, hash) adds to a line, counted against the size cap. */
const ENVELOPE_BYTES = 400;
const FILE_PREFIX = 'events-';
const FILE_SUFFIX = '.jsonl';
/** A run's log file name; sanitized ISO times are fixed-width, so name order is time order. */
const logFileName = (timestamp: string): string => `${FILE_PREFIX}${sanitizeTimestamp(timestamp)}${FILE_SUFFIX}`;

export interface RunLogEvent {
  id: number;
  ts: string;
  event: string;
  data: unknown;
}

export interface RunEventsPage {
  events: RunLogEvent[];
  /** Pass as `after` for the next page; equals the request's `after` when `events` is empty. */
  nextAfter: number;
  hasMore: boolean;
  /** The run hit the size cap: events after the marker were dropped. */
  truncated: boolean;
}

/** Appends one run's events to its file (a telemetry stream: chained, never fatal). Writes are chained so lines stay in publish order. */
export class RunEventLog {
  private chain: Promise<void> = Promise.resolve();
  private bytes = 0;
  private capped = false;
  private adapter: AuditAdapter | undefined;
  /** The task id is only known once `run-start` arrives; events before it are held, then flushed in order. */
  private held: RunLogEvent[] = [];
  private taskId: string | undefined;

  constructor(
    private readonly repoPath: string,
    private readonly startedAt: string = new Date().toISOString(),
    private readonly maxBytes: number = MAX_RUN_EVENT_LOG_BYTES,
    /** Who ran it and which hub run this is (the persistent run id); defaults to the factory bot. */
    private readonly context: AuditContext = { actor: BOT_ACTOR },
  ) {}

  append(entry: RunLogEvent, taskId?: string): void {
    if (this.taskId === undefined && taskId !== undefined && isSafeTaskId(taskId)) this.taskId = taskId;
    if (this.taskId === undefined) {
      this.held.push(entry);
      return;
    }
    const batch = [...this.held, entry];
    this.held = [];
    for (const e of batch) this.chain = this.chain.then(() => this.write(e));
  }

  /** Resolves once every queued write has settled. Never rejects. */
  flush(): Promise<void> {
    return this.chain;
  }

  private file(): AuditAdapter {
    this.adapter ??= localAdapter({
      file: join(stateDir(this.repoPath), 'runs', this.taskId as string, logFileName(this.startedAt)),
      repoPath: this.repoPath,
    });
    return this.adapter;
  }

  private async write(entry: RunLogEvent): Promise<void> {
    if (this.capped) return;
    // appendAudit never rejects for a telemetry stream: a failing log must never fail the run.
    const size = Buffer.byteLength(JSON.stringify(entry)) + ENVELOPE_BYTES;
    if (this.bytes + size > this.maxBytes) {
      this.capped = true;
      await appendAudit(STREAMS['run-events'], this.file(), { truncated: true, ts: entry.ts, maxBytes: this.maxBytes }, this.context);
      return;
    }
    this.bytes += size;
    await appendAudit(STREAMS['run-events'], this.file(), { ...entry }, this.context);
  }
}

/** The newest `events-*.jsonl` for a task, or with `timestamp` (an ISO time, e.g. a run record's from
 * `list_runs`) the newest one started at or before it: the log opens when the hub accepts the run, a
 * moment before the runner stamps its record, so the record's run is the last log begun by then. */
async function eventsFile(repoPath: string, taskId: string, timestamp: string | undefined): Promise<string | undefined> {
  const dir = join(stateDir(repoPath), 'runs', taskId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const limit = timestamp === undefined ? undefined : logFileName(timestamp);
  const match = names
    .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX) && (limit === undefined || n <= limit))
    .sort()
    .pop();
  return match === undefined ? undefined : join(dir, match);
}

/** Read a run's persisted events with `id > after`, at most `limit`, in order. A missing log is an empty page. */
export async function readRunEvents(
  repoPath: string,
  taskId: string,
  opts: { timestamp?: string; after?: number; limit?: number } = {},
): Promise<RunEventsPage> {
  const after = opts.after !== undefined && Number.isFinite(opts.after) ? opts.after : 0;
  const limit = Math.min(MAX_EVENTS_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_EVENTS_LIMIT)));
  const empty: RunEventsPage = { events: [], nextAfter: after, hasMore: false, truncated: false };
  const file = await eventsFile(repoPath, taskId, opts.timestamp);
  if (file === undefined) return empty;
  await assertStatePath(repoPath, file);
  const text = await readTextNoSymlink(file);
  const events: RunLogEvent[] = [];
  let hasMore = false;
  let truncated = false;
  for (const parsed of parseJsonlLines(text)) {
    const rec = parsed as Partial<RunLogEvent> & { truncated?: boolean };
    if (rec.truncated === true) {
      truncated = true;
      continue;
    }
    if (typeof rec.id !== 'number' || rec.id <= after) continue;
    if (events.length >= limit) {
      hasMore = true;
      break;
    }
    // The audit envelope (actor, prev, hash) is for `audit verify`; readers get the event as published.
    events.push({ id: rec.id, ts: rec.ts as string, event: rec.event as string, data: rec.data });
  }
  return { events, nextAfter: events.at(-1)?.id ?? after, hasMore, truncated };
}
