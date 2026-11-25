import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { tmpRepo } from './test-kit.js';
import { chainForRun, fallbackFlags, fundableChain, loneEntryRefused, resolveFallbackChain } from './fallback-chain.js';
import type { CredentialService } from './credentials.js';
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
    expect(await fundableChain(chain, repo, { source: 'user', env: { CODEX_API_KEY: 'k' } }, { CURSOR_API_KEY: 'host' })).toEqual({ kept: [{ provider: 'codex' }], dropped: ['cursor/m1'], unreachable: [] });
    expect(await fundableChain(chain, repo, { source: 'instance', env: { CODEX_API_KEY: 'k' } }, { CURSOR_API_KEY: 'host' })).toEqual({ kept: chain, dropped: [], unreachable: [] });
  });

  test('a repo custom is funded by its keyEnv', async () => {
    const repo = await tmpRepo();
    await mkdir(join(repo, '.taskcell'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify({ customProviders: [{ name: 'acme', baseUrl: 'https://llm.acme.test', keyEnv: 'ACME_KEY' }] }));
    const chain = [{ provider: 'acme' }];
    expect(await fundableChain(chain, repo, { source: 'user', env: { ACME_KEY: 'k' } }, {})).toEqual({ kept: chain, dropped: [], unreachable: [] });
    expect(await fundableChain(chain, repo, { source: 'user', env: {} }, { ACME_KEY: 'host' })).toEqual({ kept: [], dropped: ['acme'], unreachable: [] });
  });

  test('a funded plain-http custom is unreachable through the egress proxy and is not kept', async () => {
    const repo = await tmpRepo();
    await mkdir(join(repo, '.taskcell'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify({ customProviders: [{ name: 'lan', baseUrl: 'http://10.0.0.5:8080', keyEnv: 'LAN_KEY' }] }));
    expect(await fundableChain([{ provider: 'lan' }], repo, { source: 'user', env: { LAN_KEY: 'k' } }, {})).toEqual({ kept: [], dropped: [], unreachable: ['lan'] });
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

describe('chainForRun', () => {
  const recorder = (): { calls: unknown[][]; credentials: CredentialService } => {
    const calls: unknown[][] = [];
    const credentials = { resolveForRun: async (...args: unknown[]) => (calls.push(args), { source: 'instance' as const, env: {} }) } as unknown as CredentialService;
    return { calls, credentials };
  };

  test('a client-picked provider is the Engine: the chain is resolved and credentialed against it, not the saved default', async () => {
    const { configDir, repo } = await setup();
    const cfg = { provider: 'claude', fallbackChain: [{ provider: 'codex' }, { provider: 'cursor' }] };
    const saved = recorder();
    expect((await chainForRun({ configDir, repoPath: repo, cfg, user: undefined, provider: undefined, credentials: saved.credentials })).flags).toEqual({ fallbackProvider: 'codex,cursor' });
    expect(saved.calls[0]!.slice(1, 3)).toEqual([undefined, ['codex', 'cursor']]);
    // Picking codex makes the codex entry the Engine itself: it leaves the chain and the credential is asked for codex.
    const picked = recorder();
    expect((await chainForRun({ configDir, repoPath: repo, cfg, user: undefined, provider: 'codex', credentials: picked.credentials })).flags).toEqual({ fallbackProvider: 'cursor' });
    expect(picked.calls[0]!.slice(1, 3)).toEqual(['codex', ['cursor']]);
  });

  test('a custom entry passes its keyEnv names to the credential resolver', async () => {
    const { configDir, repo } = await setup();
    await mkdir(join(repo, '.taskcell'), { recursive: true });
    await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify({ customProviders: [{ name: 'acme', baseUrl: 'https://llm.acme.test', keyEnv: 'ACME_KEY' }] }));
    const r = recorder();
    await chainForRun({ configDir, repoPath: repo, cfg: { fallbackChain: [{ provider: 'codex' }, { provider: 'acme' }] }, user: undefined, provider: undefined, credentials: r.credentials });
    expect(r.calls[0]![3]).toEqual({ acme: ['ACME_KEY'] });
  });
});
