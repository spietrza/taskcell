// Durable per-run event log: every `api:event` the hub publishes for a run is appended as one JSONL
// line to `<state dir>/runs/<taskId>/events-<start>.jsonl`, so a run's history survives a hub restart
// and a busy run pushing events out of EventBus's 500-event ring. The `id` is the SSE `id:` the bus
// assigned, so a client can read history with `readRunEvents` and then continue on the live stream
// (skipping ids it already has) without a gap or a duplicate.
import { appendFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextNoSymlink, sanitizeTimestamp } from '../core/run-store.js';
import { injectedSecretValues, redactForPublish } from '../core/secret-scan.js';
import { assertStatePath, ensureStateDir, isSafeTaskId, stateDir } from '../core/state-path.js';

/** Per-run size cap (bytes): a runaway run's events are dropped past it, the run itself carries on. */
export const MAX_RUN_EVENT_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_EVENTS_LIMIT = 500;
export const MAX_EVENTS_LIMIT = 2000;

const FILE_PREFIX = 'events-';
const FILE_SUFFIX = '.jsonl';

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

/** Mask secrets in every string of a JSON-like value (structure-preserving, so the line stays valid JSON). */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactForPublish(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]));
  }
  return value;
}

/** Appends one run's events to its file. Writes are chained so lines stay in publish order. */
export class RunEventLog {
  private chain: Promise<void> = Promise.resolve();
  private bytes = 0;
  private capped = false;
  private ready: Promise<string | undefined> | undefined;
  /** The task id is only known once `run-start` arrives; events before it are held, then flushed in order. */
  private held: RunLogEvent[] = [];
  private taskId: string | undefined;

  constructor(
    private readonly repoPath: string,
    private readonly startedAt: string = new Date().toISOString(),
    private readonly maxBytes: number = MAX_RUN_EVENT_LOG_BYTES,
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

  private file(): Promise<string | undefined> {
    this.ready ??= (async () => {
      const dir = await ensureStateDir(this.repoPath, join(stateDir(this.repoPath), 'runs', this.taskId as string));
      const file = join(dir, `${FILE_PREFIX}${sanitizeTimestamp(this.startedAt)}${FILE_SUFFIX}`);
      await assertStatePath(this.repoPath, file);
      return file;
    })().catch(() => undefined);
    return this.ready;
  }

  private async write(entry: RunLogEvent): Promise<void> {
    if (this.capped) return;
    try {
      const file = await this.file();
      if (file === undefined) return;
      const line = `${JSON.stringify({ ...entry, data: redactDeep(entry.data, injectedSecretValues()) })}\n`;
      const size = Buffer.byteLength(line);
      if (this.bytes + size > this.maxBytes) {
        this.capped = true;
        await appendFile(file, `${JSON.stringify({ truncated: true, ts: entry.ts, maxBytes: this.maxBytes })}\n`);
        return;
      }
      this.bytes += size;
      await appendFile(file, line);
    } catch {
      // A failing log must never fail the run.
    }
  }
}

/** The newest `events-*.jsonl` for a task (or the one for `timestamp`, an ISO run-start time). */
async function eventsFile(repoPath: string, taskId: string, timestamp: string | undefined): Promise<string | undefined> {
  const dir = join(stateDir(repoPath), 'runs', taskId);
  if (timestamp !== undefined) {
    const file = join(dir, `${FILE_PREFIX}${sanitizeTimestamp(timestamp)}${FILE_SUFFIX}`);
    return (await stat(file).then(() => true, () => false)) ? file : undefined;
  }
  const names = await readdir(dir).catch(() => [] as string[]);
  const newest = names.filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX)).sort().pop();
  return newest === undefined ? undefined : join(dir, newest);
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
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn final line from a crash mid-write
    }
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
    events.push(rec as RunLogEvent);
  }
  return { events, nextAfter: events.at(-1)?.id ?? after, hasMore, truncated };
}
