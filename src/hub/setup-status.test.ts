import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { detectSetup, type SetupProbe } from './setup-status.js';

const creds = { enabled: true, providers: [{ provider: 'claude' as const, set: true, last4: 'abcd', env: false }, { provider: 'codex' as const, set: false, env: false }] };

describe('detectSetup', () => {
  test('maps probe results and env to states, booleans only', async () => {
    const probe: SetupProbe = async (file) => (file === 'gh' ? 'ready' : 'missing');
    const r = await detectSetup(creds, { LINEAR_API_KEY: 'lin_secret', CODEX_HOME: '/nonexistent-codex-home' }, probe);
    expect(r.tools).toEqual([
      { id: 'gh', state: 'ready' },
      { id: 'glab', state: 'missing' },
      { id: 'linear', state: 'ready' },
    ]);
    expect(r.models).toEqual({ claude: true, codex: false });
    expect(JSON.stringify(r)).not.toContain('lin_secret');
    expect(JSON.stringify(r)).not.toContain('abcd');
  });

  test('a failing auth status means needs-login; no Linear key likewise', async () => {
    const r = await detectSetup(creds, {}, async () => 'needs-login');
    expect(r.tools.map((t) => t.state)).toEqual(['needs-login', 'needs-login', 'needs-login']);
  });

  test('a Codex auth file counts as a Codex credential; its content is never returned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-home-'));
    await writeFile(join(dir, 'auth.json'), '{"tokens":{"access_token":"tok_super_secret"}}');
    const r = await detectSetup(creds, { CODEX_HOME: dir }, async () => 'ready');
    expect(r.models).toEqual({ claude: true, codex: true });
    expect(JSON.stringify(r)).not.toContain('tok_super_secret');
  });
});
