import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as appConfig from '../app-config.js';
import { commands, keyRoutingChanges } from './app-config.js';
import { ForbiddenError } from '../credentials.js';
import { AuditLog } from '../audit.js';
import { dispatchRpc, makeCtx, OWNER, tmpRepo } from '../test-kit.js';
import type { CommandCall } from '../command-kit.js';
import type { Caller } from '../teams.js';

const MEMBER: Caller = { user: { id: 'u2', email: 'u2@x.test', name: 'Member' }, owner: false };
const SAVED = { label: 'ready', chatBaseUrl: 'https://llm.example.com', customProviders: [{ name: 'p', baseUrl: 'https://llm.example.com', keyEnv: 'MY_KEY' }] };

async function repoWithSaved(): Promise<string> {
  const repo = await tmpRepo();
  await mkdir(join(repo, '.taskcell'), { recursive: true });
  await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify(SAVED));
  return repo;
}

/** The handler as dispatch calls it, for a caller whose team holds the repository. */
async function save(repo: string, caller: Caller, config: object): Promise<unknown> {
  const { ctx } = await makeCtx(repo);
  const call = { ctx, args: { repoPath: repo, config }, caller, allow: async (p: string) => p } as unknown as CommandCall;
  return commands.handlers.write_app_config(call);
}

describe('write_app_config key routing', () => {
  test('a member saves other settings, but not chatBaseUrl or customProviders', async () => {
    const repo = await repoWithSaved();
    await expect(save(repo, MEMBER, { ...SAVED, label: 'go' })).resolves.toBeNull();
    await expect(save(repo, MEMBER, { ...SAVED, label: 'go', chatBaseUrl: 'http://169.254.169.254' })).rejects.toBeInstanceOf(ForbiddenError);
    const evil = { ...SAVED, customProviders: [{ name: 'p', baseUrl: 'https://evil.example', keyEnv: 'MY_KEY' }] };
    await expect(save(repo, MEMBER, evil)).rejects.toThrow(/only the hub owner can change customProviders/);
    expect(JSON.parse(await readFile(join(repo, '.taskcell', 'app.json'), 'utf8'))).toMatchObject({ label: 'go' });
    await expect(save(repo, OWNER, evil)).resolves.toBeNull();
  });

  test('blank, null, [] and absent are the same unset value', () => {
    expect(keyRoutingChanges({}, { chatBaseUrl: '', customProviders: [] })).toEqual([]);
    expect(keyRoutingChanges({ chatBaseUrl: null }, {})).toEqual([]);
    expect(keyRoutingChanges({}, { chatBaseUrl: 'https://x.example' })).toEqual(['chatBaseUrl']);
  });

  test('an audited save reads app.json once', async () => {
    const repo = await repoWithSaved();
    const { ctx } = await makeCtx(repo);
    ctx.audit = new AuditLog(ctx.configDir);
    const read = vi.spyOn(appConfig, 'readAppConfig');
    await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { ...SAVED, label: 'go' } });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });
});

describe('list_chat_models', () => {
  test('the hub key goes out on the owner\'s call only', async () => {
    vi.stubEnv('MY_KEY', 'CANARY-key');
    vi.stubEnv('TASKCELL_CHAT_ALLOWED_ORIGINS', 'https://llm.example.com');
    const f = vi.fn(async (..._a: Parameters<typeof fetch>) => new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    try {
      const repo = await repoWithSaved();
      const { ctx } = await makeCtx(repo);
      const list = (caller: Caller): Promise<unknown> =>
        commands.handlers.list_chat_models({ ctx, args: { repoPath: repo }, caller, allow: async (p: string) => p } as unknown as CommandCall);
      await list(MEMBER);
      expect(JSON.stringify(f.mock.calls[0]![1])).not.toContain('CANARY-key');
      await list(OWNER);
      expect(JSON.stringify(f.mock.calls[1]![1])).toContain('CANARY-key');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
