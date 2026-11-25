import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Shared cool-down file format: `{ "<key>": "<ISO time the key may be used again>" }`. Used by the model pool
 * (`.taskcell/model-pool-cooldowns.json`, keyed `provider/model`) and the hub's credentials
 * (`credential-cooldowns.json`, keyed `credential:<scope>:<id>`).
 */

/** Keys that hit a limit, with the time they may be used again. Expired, malformed and non-string entries are dropped. */
export async function readCooldownFile(file: string, now: Date = new Date()): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return map;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const until = new Date(value);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) map.set(key, until);
  }
  return map;
}

/** Record `key` cooling until `until` (a later reset wins). Atomic tmp+rename; `prepare(path)` runs before each path is written. */
export async function recordCooldownFile(
  file: string,
  key: string,
  until: Date,
  opts: { now?: Date; prepare?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const current = await readCooldownFile(file, opts.now);
  const prior = current.get(key);
  if (prior === undefined || prior.getTime() < until.getTime()) current.set(key, until);
  await opts.prepare?.(file);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await opts.prepare?.(tmp);
  await writeFile(tmp, `${JSON.stringify(Object.fromEntries([...current].map(([k, d]) => [k, d.toISOString()])), null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
