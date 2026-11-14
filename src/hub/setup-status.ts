// First-run setup detection: is `gh` / `glab` logged in, is a Linear key present, is a model credential a run can use present.
// Reports booleans only — a secret value is never read into the result.
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { CredentialsSummary, SetupStatus, SetupToolState } from '../wire.js';

export type SetupProbe = (file: string) => Promise<SetupToolState>;

const defaultProbe: SetupProbe = async (file) => {
  try {
    await execa(file, ['auth', 'status'], { timeout: 10_000 });
    return 'ready';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'needs-login';
  }
};

/** Whether the Codex CLI's auth file exists (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`). Never read. */
async function hasCodexSignIn(env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  try {
    await access(join(home, 'auth.json'));
    return true;
  } catch {
    return false;
  }
}

export async function detectSetup(
  credentials: CredentialsSummary,
  env: NodeJS.ProcessEnv = process.env,
  probe: SetupProbe = defaultProbe,
): Promise<SetupStatus> {
  const [gh, glab, codexSignIn] = await Promise.all([probe('gh'), probe('glab'), hasCodexSignIn(env)]);
  const has = (p: 'claude' | 'codex'): boolean => credentials.providers.some((c) => c.provider === p && (c.set || c.env));
  return {
    tools: [
      { id: 'gh', state: gh },
      { id: 'glab', state: glab },
      { id: 'linear', state: (env.LINEAR_API_KEY ?? '') !== '' ? 'ready' : 'needs-login' },
    ],
    // The sign-in file alone runs nothing: a hub run takes Codex credentials from these variables only.
    models: { claude: has('claude'), codex: has('codex') || ['CODEX_AUTH_JSON', 'CODEX_API_KEY'].some((n) => (env[n] ?? '') !== '') },
    codexSignInFile: codexSignIn,
  };
}
