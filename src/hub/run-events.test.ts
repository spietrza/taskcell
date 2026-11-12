import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RunEventLog, readRunEvents } from './run-events.js';
import { EventBus } from './events.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'run-events-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const ev = (id: number, data: unknown = { n: id }) => ({ id, ts: `2026-01-01T00:00:0${id % 10}Z`, event: 'api:event', data });

async function logFile(): Promise<string> {
  const dir = join(repo, '.taskcell', 'runs', 'T-1');
  const [name] = (await readdir(dir)).filter((n) => n.startsWith('events-'));
  return join(dir, name!);
}

describe('run event log', () => {
  test('events of a finished run are readable in order from a fresh reader (restart)', async () => {
    const log = new RunEventLog(repo);
    log.append(ev(1), 'T-1');
    for (let i = 2; i <= 5; i += 1) log.append(ev(i));
    await log.flush();
    const page = await readRunEvents(repo, 'T-1');
    expect(page.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(page.hasMore).toBe(false);
  });

  test('paginates by after/limit with no gap or duplicate against the live stream', async () => {
    const bus = new EventBus();
    const log = new RunEventLog(repo);
    const publish = (n: number): number => {
      const id = bus.publish('api:event', { n });
      log.append(ev(id, { n }), 'T-1');
      return id;
    };
    for (let i = 0; i < 6; i += 1) publish(i);
    await log.flush();
    const seen: number[] = [];
    let after = 0;
    let page = await readRunEvents(repo, 'T-1', { after, limit: 4 });
    expect(page.hasMore).toBe(true);
    seen.push(...page.events.map((e) => e.id));
    publish(6); // lands while the client pages through history
    await log.flush();
    do {
      after = page.nextAfter;
      page = await readRunEvents(repo, 'T-1', { after, limit: 4 });
      seen.push(...page.events.map((e) => e.id));
    } while (page.hasMore);
    const live = [publish(7), publish(8)]; // delivered on SSE; the client skips ids it already read
    seen.push(...live.filter((id) => id > after));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('redacts a secret in the payload', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const log = new RunEventLog(repo);
    log.append(ev(1, { runId: 'r', event: { type: 'warning', message: `leaked ${token}` } }), 'T-1');
    await log.flush();
    const text = await readFile(await logFile(), 'utf8');
    expect(text).not.toContain(token);
    expect(JSON.parse(text.trim()).data.event.message).toContain('[REDACTED');
  });

  test('past the cap events are dropped with one marker and nothing throws', async () => {
    const log = new RunEventLog(repo, '2026-01-01T00:00:00.000Z', 400);
    log.append(ev(1), 'T-1');
    for (let i = 2; i <= 50; i += 1) log.append(ev(i, { pad: 'x'.repeat(50) }));
    await log.flush();
    const text = await readFile(await logFile(), 'utf8');
    expect(text.split('\n').filter((l) => l.includes('"truncated":true'))).toHaveLength(1);
    const page = await readRunEvents(repo, 'T-1');
    expect(page.truncated).toBe(true);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.length).toBeLessThan(50);
  });

  test('a missing log is an empty page', async () => {
    expect(await readRunEvents(repo, 'nope', { after: 3 })).toEqual({ events: [], nextAfter: 3, hasMore: false, truncated: false });
  });
});
