import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createEventLog, readRunEvents } from './event-log.js';
import { EventBus } from './events.js';
import { runsRoot } from '../core/run-store.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'event-log-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const api = (event: unknown): { runId: string; event: unknown } => ({ runId: 'run-0', event });

function publishRun(bus: EventBus, extra: unknown[] = []): void {
  bus.publish('vanguard:changed', { x: 1 }); // non-run events are not logged
  bus.publish('api:event', api({ type: 'run-accepted', repoPath: repo }));
  bus.publish('api:event', api({ type: 'run-start', taskId: 'T-1', flow: 'f', provider: 'p', stages: [] }));
  for (const e of extra) bus.publish('api:event', api(e));
  bus.publish('api:event', api({ type: 'run-end' }));
}

function wire(maxBytes?: number): { bus: EventBus; log: ReturnType<typeof createEventLog> } {
  const log = createEventLog(maxBytes);
  return { bus: new EventBus({ onPublish: log.record }), log };
}

describe('event log', () => {
  test('events of a finished run are readable in order, also from a fresh reader (restart)', async () => {
    const { bus, log } = wire();
    publishRun(bus, [{ type: 'stage-start', name: 'a', index: 0, of: 1 }]);
    await log.flush();
    // a "restarted" hub holds no state: reading only touches the files
    const page = await readRunEvents(repo, 'T-1');
    expect(page.events.map((e) => (e.data as { event: { type: string } }).event.type)).toEqual([
      'run-accepted',
      'run-start',
      'stage-start',
      'run-end',
    ]);
    expect(page.events.map((e) => e.id)).toEqual([2, 3, 4, 5]);
    expect(page.events.every((e) => e.event === 'api:event' && typeof e.ts === 'string')).toBe(true);
  });

  test('paginates by id with after/limit', async () => {
    const { bus, log } = wire();
    publishRun(bus);
    await log.flush();
    const first = await readRunEvents(repo, 'T-1', { limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual([2, 3]);
    expect(first.hasMore).toBe(true);
    const rest = await readRunEvents(repo, 'T-1', { after: 3, limit: 2 });
    expect(rest.events.map((e) => e.id)).toEqual([4]);
    expect(rest.hasMore).toBe(false);
  });

  test('history joined with the live stream has no gap and no duplicate', async () => {
    const { bus, log } = wire();
    publishRun(bus);
    await log.flush();
    const history = await readRunEvents(repo, 'T-1', { limit: 2 });
    const last = history.events.at(-1)!.id;
    bus.publish('api:event', api({ type: 'warning', message: 'live' }));
    const chunks: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      writeHead: () => res,
      write: (c: string) => (chunks.push(c), true),
    });
    bus.subscribe({ headers: { 'last-event-id': String(last) } } as unknown as IncomingMessage, res as unknown as ServerResponse);
    bus.publish('api:event', api({ type: 'warning', message: 'live2' }));
    const live = [...chunks.join('').matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const seen = [...history.events.map((e) => e.id), ...live];
    expect(seen).toEqual([2, 3, 4, 5, 6]); // ring replays 4,5 after the boundary; 6 is live
    expect((await readRunEvents(repo, 'T-1', { after: last })).events.map((e) => e.id)).toEqual([4]);
  });

  test('a secret in a payload is redacted in the file', async () => {
    const { bus, log } = wire();
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    publishRun(bus, [{ type: 'warning', message: `leaked ${token}` }]);
    await log.flush();
    const dir = join(runsRoot(repo), 'T-1');
    const [name] = await readdir(dir);
    const text = await readFile(join(dir, name!), 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('leaked');
  });

  test('the cap drops later events with one marker and never throws', async () => {
    const { bus, log } = wire(600);
    publishRun(bus, Array.from({ length: 20 }, (_, i) => ({ type: 'warning', message: `w${i}` })));
    await log.flush();
    const dir = join(runsRoot(repo), 'T-1');
    const [name] = await readdir(dir);
    const text = await readFile(join(dir, name!), 'utf8');
    expect(text.split('\n').filter((l) => l.includes('"truncated":true'))).toHaveLength(1);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(600 + 100); // cap + the marker line
    const page = await readRunEvents(repo, 'T-1');
    expect(page.truncated).toBe(true);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThan(5); // ~150 bytes a line: far fewer than the 22 published
  });

  test('a run record timestamp resolves to its log (started just after it), never a neighbouring run', async () => {
    const { bus, log } = wire();
    publishRun(bus);
    await log.flush();
    const dir = join(runsRoot(repo), 'T-1');
    const [name] = await readdir(dir);
    const started = name!.slice(0, -'.events.jsonl'.length);
    const recordTs = new Date(Date.now() - 1000).toISOString(); // the pipeline stamps its record just before run-start
    const page = await readRunEvents(repo, 'T-1', { timestamp: recordTs });
    expect(page.timestamp).toBe(started);
    expect(page.events.length).toBe(3);
    expect((await readRunEvents(repo, 'T-1', { timestamp: started })).timestamp).toBe(started); // pinned
    // a later record without a log (a CLI run) and a much older one belong to no log
    expect((await readRunEvents(repo, 'T-1', { timestamp: new Date(Date.now() + 5000).toISOString() })).events).toEqual([]);
    expect((await readRunEvents(repo, 'T-1', { timestamp: '2000-01-01T00:00:00.000Z' })).events).toEqual([]);
    await expect(readRunEvents(repo, 'T-1', { timestamp: 'nope' })).rejects.toThrow('timestamp');
  });

  test('a log that cannot be opened is dropped with a warning, bounded, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus, log } = wire(300);
    bus.publish('api:event', api({ type: 'run-accepted', repoPath: repo }));
    bus.publish('api:event', api({ type: 'run-start', taskId: '../evil', flow: 'f', provider: 'p', stages: [] }));
    for (let i = 0; i < 50; i += 1) bus.publish('api:event', api({ type: 'warning', message: 'x'.repeat(50) }));
    bus.publish('api:event', api({ type: 'run-end' }));
    await log.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await readdir(runsRoot(repo)).catch(() => [])).toEqual([]);
    warn.mockRestore();
  });

  test('unknown task returns an empty page; traversal is refused', async () => {
    expect(await readRunEvents(repo, 'nope')).toEqual({ events: [], hasMore: false, truncated: false });
    await expect(readRunEvents(repo, '../x')).rejects.toThrow();
  });
});
