// First-run setup detection: is `gh` / `glab` logged in, is a Linear key present, is a model credential present.
// Reports booleans only — a secret value is never read into the result.
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

export async function detectSetup(
  credentials: CredentialsSummary,
  env: NodeJS.ProcessEnv = process.env,
  probe: SetupProbe = defaultProbe,
): Promise<SetupStatus> {
  const [gh, glab] = await Promise.all([probe('gh'), probe('glab')]);
  const has = (p: 'claude' | 'codex'): boolean => credentials.providers.some((c) => c.provider === p && (c.set || c.env));
  return {
    tools: [
      { id: 'gh', state: gh },
      { id: 'glab', state: glab },
      { id: 'linear', state: (env.LINEAR_API_KEY ?? '') !== '' ? 'ready' : 'needs-login' },
    ],
    models: { claude: has('claude'), codex: has('codex') },
  };
}
