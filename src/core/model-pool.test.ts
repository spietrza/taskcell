import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPoolSyntax,
  parseModelPool,
  poolOf,
  pickIndex,
  orderCandidates,
  parseFallbackList,
  readCooldowns,
  recordCooldown,
  cooldownUntil,
  poolTaskKey,
  ModelPoolError,
} from './model-pool.js';

const known = (n: string): boolean => ['claude', 'codex', 'openrouter', 'cursor'].includes(n);

describe('parseModelPool', () => {
  it('a plain model (no comma, no weight) is not a pool: today\'s behaviour', () => {
    expect(isPoolSyntax('sonnet')).toBe(false);
    expect(isPoolSyntax('openrouter/auto')).toBe(false);
    expect(isPoolSyntax('anthropic/claude-sonnet-4.6')).toBe(false);
    expect(poolOf('sonnet', known)).toBeUndefined();
  });

  it('parses a single weighted entry', () => {
    expect(parseModelPool('codex/gpt-6-sol:1', known)).toEqual([{ provider: 'codex', model: 'gpt-6-sol', weight: 1 }]);
  });

  it('parses weights, a default weight of 1, and a model id with slashes and colons', () => {
    expect(parseModelPool('claude/sonnet:3, codex/gpt-6-sol:1, openrouter/qwen/qwen3:free:2, cursor/auto', known)).toEqual([
      { provider: 'claude', model: 'sonnet', weight: 3 },
      { provider: 'codex', model: 'gpt-6-sol', weight: 1 },
      { provider: 'openrouter', model: 'qwen/qwen3:free', weight: 2 },
      { provider: 'cursor', model: 'auto', weight: 1 },
    ]);
  });

  it('refuses bad entries with a clear message', () => {
    expect(() => parseModelPool('claude/sonnet:3,', known)).toThrow(/empty entry/);
    expect(() => parseModelPool('sonnet:3', known)).toThrow(/must be provider\/model\[:weight\]/);
    expect(() => parseModelPool('claude/:2', known)).toThrow(/must be provider\/model/);
    expect(() => parseModelPool('claude/sonnet:0', known)).toThrow(/positive integer weight/);
    expect(() => parseModelPool('claude/so nnet:1', known)).toThrow(/invalid model name/);
    expect(() => parseModelPool('claude/sonnet:0', known)).toThrow(ModelPoolError);
  });

  it('refuses an unknown provider by name', () => {
    expect(() => parseModelPool('claude/sonnet:3, bogus/x:1', known, '--provider-model')).toThrow('--provider-model: unknown provider "bogus"');
  });
});

describe('rotation', () => {
  const pool = parseModelPool('claude/sonnet:3, codex/gpt-6-sol:1', known);

  it('is stable for one task id', () => {
    const first = pickIndex(pool, 'owner/repo#42');
    for (let i = 0; i < 20; i += 1) expect(pickIndex(pool, 'owner/repo#42')).toBe(first);
  });

  it('follows the weights over many task ids', () => {
    const counts = [0, 0];
    for (let i = 0; i < 4000; i += 1) counts[pickIndex(pool, String(i))]! += 1;
    expect(counts[0]! / 4000).toBeGreaterThan(0.7);
    expect(counts[0]! / 4000).toBeLessThan(0.8);
  });

  it('keys implement and revise of one issue alike', () => {
    expect(poolTaskKey('owner/repo#42')).toBe('42');
    expect(poolTaskKey('#42')).toBe('42');
    expect(poolTaskKey('ENG-12')).toBe('ENG-12');
  });
});

describe('orderCandidates', () => {
  const pool = parseModelPool('claude/sonnet:1, codex/gpt-6-sol:1', known);
  const id = 'task-1';
  const start = pickIndex(pool, id);
  const picked = pool[start]!;
  const other = pool[1 - start]!;
  const fallbacks = [{ provider: 'cursor', model: 'auto' }];

  it('step 1: the rotation pick first, then the rest of the pool, then the fallback list', () => {
    const order = orderCandidates(pool, id, fallbacks, () => false);
    expect(order).toEqual([
      { provider: picked.provider, model: picked.model, pick: 'rotation' },
      { provider: other.provider, model: other.model, pick: 'skip-limit' },
      { provider: 'cursor', model: 'auto', pick: 'fallback' },
    ]);
  });

  it('step 2: a cooling pick is skipped for the next pool entry', () => {
    const order = orderCandidates(pool, id, fallbacks, (k) => k === `${picked.provider}/${picked.model}`);
    expect(order[0]).toEqual({ provider: other.provider, model: other.model, pick: 'skip-limit' });
    expect(order.at(-1)?.provider).toBe(picked.provider);
  });

  it('step 3: every pool entry cooling → the fallback chain; all cooling → the rotation order is kept', () => {
    const poolCooling = (k: string): boolean => k !== 'cursor/auto';
    expect(orderCandidates(pool, id, fallbacks, poolCooling)[0]).toEqual({ provider: 'cursor', model: 'auto', pick: 'fallback' });
    expect(orderCandidates(pool, id, fallbacks, () => true)[0]?.pick).toBe('rotation');
  });
});

describe('parseFallbackList', () => {
  it('pairs providers and models; an empty slot means the provider default', () => {
    expect(parseFallbackList('codex,cursor', 'gpt-6-sol,')).toEqual([{ provider: 'codex', model: 'gpt-6-sol' }, { provider: 'cursor' }]);
    expect(parseFallbackList('codex', undefined)).toEqual([{ provider: 'codex' }]);
    expect(() => parseFallbackList('codex', 'a,b')).toThrow(/more models/);
  });
});

describe('cool-down store', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vg-pool-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('records a limit until its reset and drops it after', async () => {
    const now = new Date('2026-11-16T10:00:00Z');
    await recordCooldown(repo, { provider: 'claude', model: 'sonnet' }, new Date('2026-11-16T12:00:00Z'), now);
    expect([...(await readCooldowns(repo, now)).keys()]).toEqual(['claude/sonnet']);
    expect((await readCooldowns(repo, new Date('2026-11-16T12:00:01Z'))).size).toBe(0);
  });

  it('a missing file is no cool-down; the default cool-down is one hour', async () => {
    expect((await readCooldowns(repo)).size).toBe(0);
    const now = new Date('2026-11-16T10:00:00Z');
    expect(cooldownUntil('something broke', now).toISOString()).toBe('2026-11-16T11:00:00.000Z');
  });
});
