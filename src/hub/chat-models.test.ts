import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { listChatModels, modelIds } from './chat-models.js';
import { CHAT_MODELS } from '../wire.js';
import type { AppConfig } from './app-config.js';
import { tmpRepo } from './test-kit.js';

const KEY = 'CANARY-provider-key-123';

async function repoWith(cfg: AppConfig): Promise<string> {
  const repo = await tmpRepo();
  await mkdir(join(repo, '.taskcell'), { recursive: true });
  await writeFile(join(repo, '.taskcell', 'app.json'), JSON.stringify(cfg));
  return repo;
}

const okFetch = (body: unknown) => vi.fn(async (..._a: Parameters<typeof fetch>) => new Response(JSON.stringify(body), { status: 200 }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('listChatModels', () => {
  test('without a chat endpoint or provider: the static list, no network', async () => {
    const f = okFetch({});
    const cfg: AppConfig = {};
    expect(await listChatModels(await repoWith(cfg), cfg, f)).toEqual({ source: 'static', models: [...CHAT_MODELS] });
    expect(f).not.toHaveBeenCalled();
  });

  test('a custom endpoint: GET <baseUrl>/v1/models with the keyEnv key, no redirects, ids only', async () => {
    vi.stubEnv('MY_PROXY_KEY', KEY);
    vi.stubEnv('TASKCELL_CHAT_ALLOWED_ORIGINS', 'https://llm.example.com');
    const cfg: AppConfig = { chatBaseUrl: 'https://llm.example.com/api/', customProviders: [{ name: 'proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_KEY' }] };
    const f = okFetch({ data: [{ id: 'glm-5.2' }, { id: 'glm-5.2' }, { id: 'bad id;rm' }, { id: 7 }, { id: 'claude-sonnet-5' }] });
    const out = await listChatModels(await repoWith(cfg), cfg, f);
    expect(out).toEqual({ source: 'endpoint', origin: 'https://llm.example.com', models: ['glm-5.2', 'claude-sonnet-5'] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://llm.example.com/api/v1/models');
    expect((init as RequestInit).redirect).toBe('error');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': KEY });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  test('the project provider: openrouter reads the public list; a custom provider its own endpoint', async () => {
    const or: AppConfig = { provider: 'openrouter' };
    const f = okFetch({ data: [{ id: 'anthropic/claude-sonnet-5' }] });
    expect(await listChatModels(await repoWith(or), or, f)).toMatchObject({ source: 'openrouter', models: ['anthropic/claude-sonnet-5'] });
    expect(f.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models');
    expect((f.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('anthropic-version'); // it would answer its short Anthropic list
    vi.stubEnv('TASKCELL_CHAT_ALLOWED_ORIGINS', 'http://127.0.0.1:3000');
    const custom: AppConfig = { provider: 'zz', customProviders: [{ name: 'zz', baseUrl: 'http://127.0.0.1:3000' }] };
    const g = okFetch({ data: [{ id: 'm1' }] });
    expect(await listChatModels(await repoWith(custom), custom, g)).toMatchObject({ source: 'endpoint', models: ['m1'] });
    expect(g.mock.calls[0]![0]).toBe('http://127.0.0.1:3000/v1/models');
    expect((g.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('x-api-key');
  });

  test('a failure is a short safe error, never the body or the key', async () => {
    vi.stubEnv('MY_PROXY_KEY', KEY);
    vi.stubEnv('TASKCELL_CHAT_ALLOWED_ORIGINS', 'https://llm.example.com');
    const cfg: AppConfig = { chatBaseUrl: 'https://llm.example.com', customProviders: [{ name: 'p', baseUrl: 'https://llm.example.com', keyEnv: 'MY_PROXY_KEY' }] };
    const repo = await repoWith(cfg);
    const denied = vi.fn(async () => new Response(`invalid key ${KEY}`, { status: 401 }));
    const out = await listChatModels(repo, cfg, denied);
    expect(out).toEqual({ source: 'endpoint', origin: 'https://llm.example.com', models: [], error: 'https://llm.example.com answered HTTP 401' });
    const down = vi.fn(async () => {
      throw new TypeError(`fetch failed ${KEY}`);
    });
    expect((await listChatModels(repo, cfg, down)).error).toBe('https://llm.example.com could not be reached');
    vi.stubEnv('MY_PROXY_KEY', '');
    expect((await listChatModels(repo, cfg, denied)).error).toContain('MY_PROXY_KEY is not set on the hub');
  });

  test('a plain-http endpoint is asked without the key (a keyless LAN proxy still lists)', async () => {
    vi.stubEnv('MY_PROXY_KEY', KEY);
    vi.stubEnv('TASKCELL_CHAT_ALLOWED_ORIGINS', 'http://192.168.1.20:3000');
    const cfg: AppConfig = { chatBaseUrl: 'http://192.168.1.20:3000', customProviders: [{ name: 'lan', baseUrl: 'http://192.168.1.20:3000', keyEnv: 'MY_PROXY_KEY' }] };
    const repo = await repoWith(cfg);
    const f = okFetch({ data: [{ id: 'm1' }] });
    expect(await listChatModels(repo, cfg, f)).toMatchObject({ source: 'endpoint', models: ['m1'] });
    expect(JSON.stringify(f.mock.calls[0]![1])).not.toContain(KEY);
    const denied = vi.fn(async () => new Response('no', { status: 401 }));
    expect((await listChatModels(repo, cfg, denied)).error).toContain('MY_PROXY_KEY is sent to https:// endpoints only');
  });

  test('a foreign origin gets no request and no key', async () => {
    vi.stubEnv('SOME_OTHER_SECRET', KEY);
    const cfg: AppConfig = { chatBaseUrl: 'https://attacker.example/', customProviders: [{ name: 'p', baseUrl: 'https://attacker.example', keyEnv: 'SOME_OTHER_SECRET' }] };
    const f = okFetch({ data: [{ id: 'm1' }] });
    const out = await listChatModels(await repoWith(cfg), cfg, f);
    expect(out.models).toEqual([]);
    expect(out.error).toContain('not allowed');
    expect(f).not.toHaveBeenCalled();
  });

  test('an allowed origin is fetched with the key header', async () => {
    vi.stubEnv('SOME_OTHER_SECRET', KEY);
    vi.stubEnv('TASKCELL_CHAT_ALLOWED_ORIGINS', 'https://ok.example');
    const cfg: AppConfig = { chatBaseUrl: 'https://ok.example/', customProviders: [{ name: 'p', baseUrl: 'https://ok.example', keyEnv: 'SOME_OTHER_SECRET' }] };
    const f = okFetch({ data: [{ id: 'm1' }] });
    expect(await listChatModels(await repoWith(cfg), cfg, f)).toMatchObject({ models: ['m1'] });
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  test('a provider whose keyEnv names a credential Taskcell holds is not trusted with it', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', KEY);
    const cfg: AppConfig = { provider: 'evil', customProviders: [{ name: 'evil', baseUrl: 'https://evil.example', keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }] };
    const f = okFetch({ data: [] });
    expect(await listChatModels(await repoWith(cfg), cfg, f)).toEqual({ source: 'static', models: [...CHAT_MODELS] });
    expect(f).not.toHaveBeenCalled();
  });
});

test('modelIds tolerates a malformed body', () => {
  expect(modelIds(null)).toEqual([]);
  expect(modelIds({ data: 'x' })).toEqual([]);
});
