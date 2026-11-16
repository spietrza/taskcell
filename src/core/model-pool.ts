import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir } from './state-path.js';
import { parseProviderRateLimitReset } from './rate-limit-marker.js';

/**
 * Model pools per stage: `--provider-model claude/sonnet:3, codex/gpt-5.6-sol:1`. Each entry is
 * `provider/model[:weight]`; a run picks one by weight from a stable hash of its task id, skips
 * entries that are cooling down after a provider limit, and falls back to the next entry, then to
 * the `--fallback-provider` list. A value with no comma and no `:<weight>` suffix is NOT a pool:
 * it is the single model it always was (so `openrouter/auto` or `anthropic/claude-sonnet-4.6` keep
 * meaning a model id). Write `codex/gpt-5.6-sol:1` to pin one entry to a provider.
 */
export interface PoolEntry {
  provider: string;
  model: string;
  weight: number;
}

/** Why a stage ran the model it ran: recorded on the run record and the metric line, read by `taskcell stats`. */
export type ModelPick = 'config' | 'rotation' | 'skip-limit' | 'fallback' | 'label' | 'flow';

export class ModelPoolError extends Error {}

const WEIGHT_RE = /:(\d+)\s*$/;
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** True when `value` uses the pool syntax (a comma, or a `:<weight>` suffix); otherwise it is one plain model. */
export function isPoolSyntax(value: string): boolean {
  return value.includes(',') || WEIGHT_RE.test(value);
}

/**
 * Parse `provider/model[:weight], …`. Weight defaults to 1 and must be a positive integer. `isProvider`
 * decides which provider names exist (built-ins + repo customs); an unknown one is refused by name.
 * Throws ModelPoolError with a message naming the bad entry.
 */
export function parseModelPool(value: string, isProvider: (name: string) => boolean, flag = 'model pool'): PoolEntry[] {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.every((p) => p === '')) throw new ModelPoolError(`${flag}: empty pool.`);
  return parts.map((part) => {
    if (part === '') throw new ModelPoolError(`${flag}: empty entry in "${value}".`);
    const weightMatch = WEIGHT_RE.exec(part);
    const weight = weightMatch !== null ? Number(weightMatch[1]) : 1;
    const body = weightMatch !== null ? part.slice(0, weightMatch.index).trim() : part;
    const slash = body.indexOf('/');
    if (slash <= 0 || slash === body.length - 1) {
      throw new ModelPoolError(`${flag}: entry "${part}" must be provider/model[:weight], e.g. claude/sonnet:3.`);
    }
    const provider = body.slice(0, slash);
    const model = body.slice(slash + 1);
    if (!PROVIDER_RE.test(provider) || !isProvider(provider)) throw new ModelPoolError(`${flag}: unknown provider "${provider}" in entry "${part}".`);
    if (!MODEL_RE.test(model)) throw new ModelPoolError(`${flag}: entry "${part}" has an invalid model name.`);
    if (!Number.isSafeInteger(weight) || weight < 1) throw new ModelPoolError(`${flag}: entry "${part}" needs a positive integer weight.`);
    return { provider, model, weight };
  });
}

/** Parse when it is a pool, else undefined (a plain model keeps today's behaviour). */
export function poolOf(value: string | undefined, isProvider: (name: string) => boolean, flag?: string): PoolEntry[] | undefined {
  return value !== undefined && isPoolSyntax(value) ? parseModelPool(value, isProvider, flag) : undefined;
}

/** Stable 32-bit hash of a task id (sha256 prefix): the same task always lands on the same entry. */
export function taskHash(taskId: string): number {
  return createHash('sha256').update(taskId).digest().readUInt32BE(0);
}

/** Index of the entry picked by weight for `taskId`. */
export function pickIndex(entries: readonly PoolEntry[], taskId: string): number {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let slot = taskHash(taskId) % total;
  for (const [i, e] of entries.entries()) {
    if (slot < e.weight) return i;
    slot -= e.weight;
  }
  return entries.length - 1;
}

export const entryKey = (e: { provider: string; model?: string }): string => `${e.provider}/${e.model ?? ''}`;

export interface PoolCandidate {
  provider: string;
  model?: string;
  pick: ModelPick;
}

/**
 * The run's ordered candidates: the weighted pick (`rotation`), then the rest of the pool in listed
 * order after it (`skip-limit`), then the fallback list (`fallback`). Entries still cooling down are
 * moved to the end, so a fresh run starts on a pool entry that has quota; when every entry is cooling
 * the order is kept (the run fails on the limit as before). The first candidate's pick reads
 * `skip-limit` when the rotation pick was cooling.
 */
export function orderCandidates(
  pool: readonly PoolEntry[],
  taskId: string,
  fallbacks: ReadonlyArray<{ provider: string; model?: string }>,
  cooling: (key: string) => boolean,
): PoolCandidate[] {
  const start = pickIndex(pool, taskId);
  const rotated = [...pool.slice(start), ...pool.slice(0, start)];
  const all: PoolCandidate[] = [
    ...rotated.map((e, i): PoolCandidate => ({ provider: e.provider, model: e.model, pick: i === 0 ? 'rotation' : 'skip-limit' })),
    ...fallbacks.map((f): PoolCandidate => ({ provider: f.provider, ...(f.model !== undefined ? { model: f.model } : {}), pick: 'fallback' })),
  ];
  const fresh = all.filter((c) => !cooling(entryKey(c)));
  if (fresh.length === 0) return all;
  // Only all[0] carries 'rotation', so a cooled pick leaves the next fresh one reading skip-limit/fallback.
  return [...fresh, ...all.filter((c) => cooling(entryKey(c)))];
}

/** Default cool-down when a limit names no reset: parseProviderRateLimitReset's own one hour. */
export function cooldownUntil(message: string, now: Date = new Date()): Date {
  return parseProviderRateLimitReset(message, now);
}

const COOLDOWN_FILE = 'model-pool-cooldowns.json';

function cooldownPath(repoPath: string): string {
  return join(repoPath, '.taskcell', COOLDOWN_FILE);
}

/** Entries that hit a limit, keyed `provider/model`, with the ISO time they may be picked again. Expired entries are dropped. */
export async function readCooldowns(repoPath: string, now: Date = new Date()): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(cooldownPath(repoPath), 'utf8'));
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

/** Record that `provider/model` hit a limit until `until` (best-effort; a later reset time wins). */
export async function recordCooldown(repoPath: string, entry: { provider: string; model?: string }, until: Date, now: Date = new Date()): Promise<void> {
  const current = await readCooldowns(repoPath, now);
  const key = entryKey(entry);
  const prior = current.get(key);
  if (prior === undefined || prior.getTime() < until.getTime()) current.set(key, until);
  const file = cooldownPath(repoPath);
  await ensureStateDir(repoPath, join(repoPath, '.taskcell'));
  await assertStatePath(repoPath, file);
  const tmp = `${file}.${process.pid}.tmp`;
  await assertStatePath(repoPath, tmp);
  await writeFile(tmp, `${JSON.stringify(Object.fromEntries([...current].map(([k, d]) => [k, d.toISOString()])), null, 2)}\n`);
  await rename(tmp, file);
}

/** `--fallback-provider codex,cursor` + `--fallback-model gpt-5.6-sol,` → ordered list (an empty model slot = that provider's default). */
export function parseFallbackList(providers: string | undefined, models: string | undefined): Array<{ provider: string; model?: string }> {
  if (providers === undefined) return [];
  const names = providers.split(',').map((s) => s.trim());
  const modelList = models !== undefined ? models.split(',').map((s) => s.trim()) : [];
  if (names.some((n) => n === '')) throw new ModelPoolError('--fallback-provider: empty entry in the list.');
  if (modelList.length > names.length) throw new ModelPoolError('--fallback-model lists more models than --fallback-provider lists providers.');
  return names.map((provider, i) => {
    const model = modelList[i];
    return { provider, ...(model !== undefined && model !== '' ? { model } : {}) };
  });
}

/**
 * The rotation key of a task: its trailing issue number when it has one (`123`, `#123`,
 * `owner/repo#123` and `gh-owner-repo-123` all hash alike), so implement, resume and revise of
 * one issue pick the same entry; otherwise the id itself (Linear `ENG-12` keeps its team prefix).
 */
export function poolTaskKey(id: string): string {
  return /#(\d+)$/.exec(id)?.[1] ?? id;
}
