import { describe, it, expect } from 'vitest';
import { routeModelPools, resolveFlowStagePools } from './model-pool-routing.js';
import { stagePicks } from './source-adapter.js';
import { isProviderName } from '../agents/registry.js';
import { pickIndex, parseModelPool } from '../core/model-pool.js';
import type { PipelineStage } from '../pipeline/pipeline.js';

const ctx = { isProvider: isProviderName, cooling: (): boolean => false };
const POOL = 'claude/sonnet:1, codex/gpt-6-sol:1';
const pool = parseModelPool(POOL, isProviderName);
const idFor = (provider: string): string => {
  for (let i = 0; ; i += 1) if (pool[pickIndex(pool, String(i))]!.provider === provider) return String(i);
};

describe('routeModelPools', () => {
  it('leaves a single model and a single fallback untouched', () => {
    const opts = { provider: 'claude', providerModel: 'sonnet', fallbackProvider: 'codex', fallbackModel: 'gpt-6-sol' };
    expect(routeModelPools(opts, '7', ctx)).toEqual({ options: opts, picks: {}, pooled: false });
  });

  it('rotation picks the implementer; the other pool entry becomes the in-run fallback', () => {
    const r = routeModelPools({ providerModel: POOL }, idFor('codex'), ctx);
    expect(r.options).toMatchObject({ provider: 'codex', providerModel: 'gpt-6-sol', fallbackProvider: 'claude', fallbackModel: 'sonnet' });
    expect(r.picks.implementer).toEqual({ provider: 'codex', model: 'gpt-6-sol', pick: 'rotation' });
    expect(r.picks.fallback).toEqual({ provider: 'claude', model: 'sonnet', pick: 'skip-limit' });
  });

  it('skips an entry that is cooling down after a limit, and the fallback list comes after the pool', () => {
    const r = routeModelPools({ providerModel: POOL, fallbackProvider: 'cursor' }, idFor('codex'), { ...ctx, cooling: (k: string) => k === 'codex/gpt-6-sol' });
    expect(r.options).toMatchObject({ provider: 'claude', providerModel: 'sonnet', fallbackProvider: 'cursor' });
    expect(r.picks.implementer?.pick).toBe('skip-limit');
  });

  it('every pool entry cooling: the fallback list serves the run', () => {
    const r = routeModelPools({ providerModel: POOL, fallbackProvider: 'cursor', fallbackModel: 'auto' }, '1', { ...ctx, cooling: (k: string) => k !== 'cursor/auto' });
    expect(r.options).toMatchObject({ provider: 'cursor', providerModel: 'auto' });
    expect(r.picks.implementer).toEqual({ provider: 'cursor', model: 'auto', pick: 'fallback' });
  });

  it('a fallback list without a pool rotates nothing but chains the fallbacks', () => {
    const r = routeModelPools({ provider: 'claude', fallbackProvider: 'codex,cursor' }, '1', { ...ctx, cooling: (k: string) => k === 'codex/' });
    expect(r.options).toMatchObject({ provider: 'claude', fallbackProvider: 'cursor' });
    expect(r.picks.implementer?.pick).toBe('config');
  });

  it('a taskcell:model label beats the pool', () => {
    const r = routeModelPools({ providerModel: POOL }, idFor('claude'), { ...ctx, labelModel: 'opus' });
    expect(r.options).toMatchObject({ provider: 'claude', providerModel: 'opus' });
    expect(r.picks.implementer).toEqual({ provider: 'claude', model: 'opus', pick: 'label' });
  });

  it('review and escalate pools resolve too; escalate keeps to the implementer provider', () => {
    const r = routeModelPools({ provider: 'claude', providerModel: 'sonnet', reviewModel: 'codex/gpt-6-sol:1', escalateModel: 'claude/opus:1, codex/gpt-6-sol:5' }, '9', ctx);
    expect(r.options).toMatchObject({ reviewProvider: 'codex', reviewModel: 'gpt-6-sol', escalateModel: 'opus' });
  });
});

describe('stagePicks', () => {
  it('names the fallback when the fallback provider ran the stage', () => {
    const res = { taskId: 't', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '' } as const;
    const picks = { implementer: { provider: 'codex', model: 'gpt-6-sol', pick: 'rotation' as const }, fallback: { provider: 'claude', model: 'sonnet', pick: 'skip-limit' as const } };
    expect(stagePicks([{ name: 'implementer', result: res, providerName: 'claude', model: 'sonnet' }], picks, 'codex')).toEqual({
      implementer: { provider: 'claude', model: 'sonnet', pick: 'skip-limit', skipped: [{ entry: 'codex/gpt-6-sol' }] },
    });
    expect(stagePicks([{ name: 'implementer', result: res, providerName: 'codex', model: 'gpt-6-sol' }], picks, 'codex').implementer?.pick).toBe('rotation');
  });
});

describe('resolveFlowStagePools', () => {
  it('resolves a flow stage pool to one entry, pinning another provider', () => {
    const stages: PipelineStage[] = [{ name: 'implementer', promptTemplate: 'x', model: POOL, modelFromFlow: true }];
    const r = resolveFlowStagePools(stages, idFor('codex'), { runProvider: 'claude', isProvider: isProviderName, cooling: () => false });
    expect(r.stages[0]?.model).toBe(pool[pickIndex(pool, `${idFor('codex')}#implementer`)]!.model);
    expect(Object.keys(r.picks)).toEqual(['implementer']);
    const plain: PipelineStage[] = [{ name: 'reviewer', promptTemplate: 'x', model: 'opus' }];
    expect(resolveFlowStagePools(plain, '1', { runProvider: 'claude', isProvider: isProviderName, cooling: () => false }).stages).toEqual(plain);
  });
});
