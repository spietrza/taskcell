import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { tmpRepo } from './test-kit.js';
import { fallbackFlags, fundableChain, loneEntryRefused, resolveFallbackChain } from './fallback-chain.js';
import { saveTeams } from './teams.js';

async function setup(teamChain?: { provider: string; model?: string }[]): Promise<{ configDir: string; repo: string }> {
  const configDir = await mkdtemp(join(tmpdir(), 'vg-fallback-'));
  const repo = await tmpRepo();
  await saveTeams(configDir, [{ id: 'default', name: 'Default', members: [], repositories: [] }, { id: 't', name: 'T', members: [], repositories: [repo], ...(teamChain !== undefined ? { fallbackChain: teamChain } : {}) }]);
  return { configDir, repo };
}

describe('resolveFallbackChain', () => {
  test('the project chain beats the team default; absent uses the team; [] means none', async () => {
    const { configDir, repo } = await setup([{ provider: 'cursor' }]);
    expect(await resolveFallbackChain(configDir, repo, { fallbackChain: [{ provider: 'codex', model: 'gpt-6-sol' }] })).toEqual({ chain: [{ provider: 'codex', model: 'gpt-6-sol' }], source: 'project' });
    expect(await resolveFallbackChain(configDir, repo, {})).toEqual({ chain: [{ provider: 'cursor' }], source: 'team' });
    expect(await resolveFallbackChain(configDir, repo, { fallbackChain: [] })).toEqual({ chain: [], source: 'project' });
  });

  test('no team default and no project chain is none', async () => {
    const { configDir, repo } = await setup();
    expect(await resolveFallbackChain(configDir, repo, {})).toEqual({ chain: [], source: 'none' });
  });

  test('malformed entries are dropped silently, never failing the run', async () => {
    const { configDir, repo } = await setup();
    const cfg = { fallbackChain: [{ provider: 'codex' }, { provider: 'nope' }, { provider: 'meridian' }, { provider: 'claude' }, { provider: 'codex' }, { provider: 'cursor', model: 'bad,model' }, null] } as never;
    expect((await resolveFallbackChain(configDir, repo, cfg)).chain).toEqual([{ provider: 'codex' }]);
  });
});

describe('fallbackFlags', () => {
  test('joins providers and models; empty model slots stay; all-empty models are omitted', () => {
    expect(fallbackFlags([])).toEqual({});
    expect(fallbackFlags([{ provider: 'codex' }, { provider: 'cursor' }])).toEqual({ fallbackProvider: 'codex,cursor' });
    expect(fallbackFlags([{ provider: 'codex', model: 'gpt-6-sol' }, { provider: 'cursor' }])).toEqual({ fallbackProvider: 'codex,cursor', fallbackModel: 'gpt-6-sol,' });
  });
});

describe('fundableChain', () => {
  test('keeps entries with a key in the credential and drops the rest; a user run never borrows host keys', async () => {
    const repo = await tmpRepo();
    const chain = [{ provider: 'codex' }, { provider: 'cursor', model: 'm1' }];
    expect(await fundableChain(chain, repo, { source: 'user', env: { CODEX_API_KEY: 'k' } }, { CURSOR_API_KEY: 'host' })).toEqual({ kept: [{ provider: 'codex' }], dropped: ['cursor/m1'] });
    expect(await fundableChain(chain, repo, { source: 'instance', env: { CODEX_API_KEY: 'k' } }, { CURSOR_API_KEY: 'host' })).toEqual({ kept: chain, dropped: [] });
  });

  test('a repo custom is funded by its keyEnv', async () => {
    const repo = await tmpRepo();
    await mkdir(join(repo, '.taskcell'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify({ customProviders: [{ name: 'acme', baseUrl: 'https://llm.acme.test', keyEnv: 'ACME_KEY' }] }));
    const chain = [{ provider: 'acme' }];
    expect(await fundableChain(chain, repo, { source: 'user', env: { ACME_KEY: 'k' } }, {})).toEqual({ kept: chain, dropped: [] });
    expect(await fundableChain(chain, repo, { source: 'user', env: {} }, { ACME_KEY: 'host' })).toEqual({ kept: [], dropped: ['acme'] });
  });
});

describe('loneEntryRefused', () => {
  test('a lone entry on the Engine or its transport slot is refused; a different transport or a longer list is not', async () => {
    const repo = await tmpRepo();
    expect(await loneEntryRefused([{ provider: 'zai' }], repo, 'claude')).toBe(true);
    expect(await loneEntryRefused([{ provider: 'claude', model: 'sonnet' }], repo, undefined)).toBe(true);
    expect(await loneEntryRefused([{ provider: 'codex' }], repo, 'claude')).toBe(false);
    expect(await loneEntryRefused([{ provider: 'zai' }, { provider: 'codex' }], repo, 'claude')).toBe(false);
  });

  test('resolve keeps a lone same-transport entry, so the run drops it with a warning', async () => {
    const { configDir, repo } = await setup();
    expect((await resolveFallbackChain(configDir, repo, { fallbackChain: [{ provider: 'zai' }] })).chain).toEqual([{ provider: 'zai' }]);
  });
});

describe('chainForRun paid fallback', () => {
  test('off parks on the subscription credential; on moves to the paid key', async () => {
    const { configDir, repo } = await setup();
    const { createCredentialService } = await import('./credentials.js');
    const { recordCooldown } = await import('../core/model-pool.js');
    const { chainForRun } = await import('./fallback-chain.js');
    const credentials = createCredentialService(configDir);
    await credentials.putInstance('CLAUDE_CODE_OAUTH_TOKEN', 'oat');
    await credentials.putInstance('ANTHROPIC_API_KEY', 'sk-paid');
    await recordCooldown(repo, { provider: 'claude' }, new Date(Date.now() + 3_600_000));
    const run = (): ReturnType<typeof chainForRun> => chainForRun({ configDir, repoPath: repo, cfg: {}, user: undefined, provider: undefined, credentials });
    const off = (await run()).credential;
    expect(off?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat');
    expect(off?.paid).toBeUndefined();
    await credentials.setPaidFallback('instance', true);
    const on = (await run()).credential;
    expect(on?.env).toEqual({ ANTHROPIC_API_KEY: 'sk-paid' });
    expect(on?.paid?.reason).toContain('claude');
  });
});

describe('paid fallback RPCs', () => {
  test('gates: instance switch is manager-only, user switch needs a sign-in and per-user credentials, enabled must be boolean', async () => {
    const { makeCtx, dispatchRpc } = await import('./test-kit.js');
    const { createCredentialService } = await import('./credentials.js');
    const { ctx } = await makeCtx(await tmpRepo());
    const credentials = createCredentialService(ctx.configDir);
    const alice = { id: 'alice', email: 'a@x.io', name: 'A' };
    const base = { ...ctx, userCredentials: credentials };
    const asAlice = { ...base, user: alice };
    const caller = { user: alice, owner: false };
    await expect(dispatchRpc(asAlice, 'set_instance_paid_fallback', { enabled: true }, caller)).rejects.toThrow(/owner or a hub admin/);
    expect(await dispatchRpc(asAlice, 'get_paid_fallback', {}, caller)).toEqual({ user: false });
    await expect(dispatchRpc(base, 'set_user_paid_fallback', { enabled: true }, { user: undefined as never, owner: false })).rejects.toThrow(/Sign in/);
    await expect(dispatchRpc(asAlice, 'set_user_paid_fallback', { enabled: true }, caller)).rejects.toThrow(/turned off/);
    await credentials.setPolicy('user-first');
    await expect(dispatchRpc(asAlice, 'set_user_paid_fallback', { enabled: 'yes' }, caller)).rejects.toThrow(/boolean/);
    await dispatchRpc(asAlice, 'set_user_paid_fallback', { enabled: true }, caller);
    expect(await dispatchRpc(asAlice, 'get_paid_fallback', {}, caller)).toEqual({ user: true });
    await dispatchRpc(base, 'set_instance_paid_fallback', { enabled: true });
    expect(await dispatchRpc(base, 'get_paid_fallback', {})).toMatchObject({ instance: true });
  });
});

describe('chainForRun paid fallback: scope isolation', () => {
  const alice = { id: 'alice', email: 'a@x.io', name: 'A' };
  async function seeded(): Promise<{ configDir: string; repo: string; credentials: import('./credentials.js').CredentialService; run: () => Promise<{ credential: import("./../wire.js").RunCredential | undefined }> }> {
    const { configDir, repo } = await setup();
    const { createCredentialService } = await import('./credentials.js');
    const { recordCooldown } = await import('../core/model-pool.js');
    const { chainForRun } = await import('./fallback-chain.js');
    const credentials = createCredentialService(configDir);
    await credentials.setPolicy('user-first');
    await credentials.putInstance('CLAUDE_CODE_OAUTH_TOKEN', 'inst-oat');
    await credentials.putInstance('ANTHROPIC_API_KEY', 'inst-paid');
    await recordCooldown(repo, { provider: 'claude' }, new Date(Date.now() + 3_600_000));
    return { configDir, repo, credentials, run: async () => ({ credential: (await chainForRun({ configDir, repoPath: repo, cfg: {}, user: alice, provider: undefined, credentials })).credential }) };
  }

  test('a user run with its switch on but no own paid key never gets the instance key, even with the instance switch on', async () => {
    const { credentials, run } = await seeded();
    await credentials.store.put(`user:${alice.id}`, 'CLAUDE_CODE_OAUTH_TOKEN', 'alice-oat');
    await credentials.setPaidFallback(alice, true);
    await credentials.setPaidFallback('instance', true);
    const { credential } = await run();
    expect(credential?.source).toBe('user');
    expect(credential?.paid).toBeUndefined();
    expect(JSON.stringify(credential?.env)).not.toContain('inst-paid');
  });

  test('an instance run with the instance switch off is never switched, even with the starter\'s own switch on', async () => {
    const { credentials, run } = await seeded();
    await credentials.setPaidFallback(alice, true);
    const { credential } = await run();
    expect(credential?.source).toBe('instance');
    expect(credential?.paid).toBeUndefined();
    expect(credential?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('inst-oat');
  });

  test('a user run with its own paid key moves to that key, not the instance one', async () => {
    const { credentials, run } = await seeded();
    await credentials.store.put(`user:${alice.id}`, 'CLAUDE_CODE_OAUTH_TOKEN', 'alice-oat');
    await credentials.store.put(`user:${alice.id}`, 'ANTHROPIC_API_KEY', 'alice-paid');
    await credentials.setPaidFallback(alice, true);
    const { credential } = await run();
    expect(credential?.env).toEqual({ ANTHROPIC_API_KEY: 'alice-paid' });
    expect(credential?.paid).toBeDefined();
  });
});
