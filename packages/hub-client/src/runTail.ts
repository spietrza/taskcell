// Follow one run's persisted event log: page it with `after`/`hasMore`, read again only on events of that run,
// start over when the log read is an older run's, and stop once the run ends. Shared by the desktop Inspector and
// the mobile Runs view; it takes any hub client (`call` + `subscribe`) and imports nothing platform-specific.
import type { HubClient } from './client.js';
import type { Commands } from './wire.js';

/** Events per `read_run_events` page: the hub's MAX_EVENTS_LIMIT, so a long backlog takes few reads. */
export const EVENTS_PAGE = 2000;

export type RunLogEvent = Commands['read_run_events']['result']['events'][number];

export interface RunTailClient {
  call: HubClient['call'];
  subscribe: HubClient['subscribe'];
}

export interface RunTailTarget {
  repoPath: string;
  taskId: string;
  /** Picks a finished run's log (its record's time); default the newest. */
  timestamp?: string | undefined;
  /** An active run's last session activity (ms): a log whose run ended before it is an older run's. */
  activeSince?: number | undefined;
  /** Keep only the newest this many events (default all). */
  keep?: number | undefined;
  /** false: read the log to its end once, without following the stream (a finished run). Default true. */
  follow?: boolean | undefined;
}

export interface RunTailHandlers {
  /** The events held so far (all, or the newest `keep`); called whenever the log gained some or was reset. */
  onEvents: (events: RunLogEvent[]) => void;
  /** Fires once when the run's terminal event was read; the stream is then closed and nothing more is read. */
  onEnd: () => void;
  onError: (message: string) => void;
}

export type RunTail = (() => void) & {
  /** Read what the log gained now (a backstop for a missed event); no-op once stopped. */
  refresh: () => void;
};

const TERMINAL = new Set(['run-end', 'run-error', 'run-cancelled']);

const innerEvent = (e: RunLogEvent): { type?: string } | undefined => (e.data as { event?: { type?: string } } | null)?.event;

const runIdOf = (data: unknown): string | undefined => {
  const id = (data as { runId?: unknown } | null)?.runId;
  return typeof id === 'string' ? id : undefined;
};

const isTerminal = (e: RunLogEvent): boolean => TERMINAL.has(e.event) || TERMINAL.has(innerEvent(e)?.type ?? '');

/**
 * Follow a run's event log: each `/events` frame for this run (its repository's `vanguard:changed`, or an
 * `api:event` of its run) reads what the log gained since the last read. A log that ended before `activeSince`
 * is an older run's (the active run's own log is not written yet): it is dropped and read again from the start
 * next time. Returns a function that stops it.
 */
export function tailRun(client: RunTailClient, target: RunTailTarget, handlers: RunTailHandlers): RunTail {
  const { repoPath, taskId, timestamp, activeSince, keep } = target;
  let events: RunLogEvent[] = [];
  let after = 0;
  let stopped = false;
  let busy = false;
  let again = false;
  const runIds = new Set<string>();
  let closeStream: (() => void) | undefined;

  const stop = (): void => {
    stopped = true;
    closeStream?.();
  };
  const read = async (): Promise<void> => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        let more = true;
        while (more && !stopped) {
          const r = await client.call('read_run_events', { repoPath, taskId, after, limit: EVENTS_PAGE, ...(timestamp !== undefined ? { timestamp } : {}) });
          if (stopped) return;
          const end = r.events.find(isTerminal);
          if (end && activeSince !== undefined && Date.parse(end.ts) < activeSince) {
            // An older run's log: drop what it showed and start over, so the active run's log is read from its first event.
            after = 0;
            if (events.length > 0) handlers.onEvents((events = []));
            break;
          }
          after = r.nextAfter;
          more = r.hasMore;
          for (const e of r.events) {
            const id = runIdOf(e.data);
            if (id !== undefined) runIds.add(id);
          }
          if (r.events.length > 0) {
            events = keep === undefined ? [...events, ...r.events] : [...events, ...r.events.slice(-keep)].slice(-keep);
            handlers.onEvents(events);
          }
          if (end) {
            stop();
            handlers.onEnd();
            return;
          }
        }
      } while (again && !stopped);
    } catch (err) {
      if (!stopped) handlers.onError(String(err));
    } finally {
      busy = false;
    }
  };

  /** An `api:event` of this run: one whose runId its log named, or its `run-start` (which names the task). */
  const isThisRun = (payload: unknown): boolean => {
    const id = runIdOf(payload);
    if (id === undefined) return false;
    const inner = (payload as { event?: { type?: unknown; taskId?: unknown } }).event;
    if (inner?.type === 'run-start' && inner.taskId === taskId) runIds.add(id);
    return runIds.has(id);
  };

  if (target.follow !== false) {
    closeStream = client.subscribe({
      onOpen: () => void read(),
      onEvent: (name, payload) => {
        if (name === 'vanguard:changed' ? payload === repoPath : name === 'api:event' && isThisRun(payload)) void read();
      },
      onReset: () => void read(),
      onError: (message, detail) => {
        if (!stopped && !detail?.streamOpen) handlers.onError(message);
      },
    });
  }
  void read();
  return Object.assign(stop, { refresh: () => void read() });
}
