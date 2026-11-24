import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';
import { readEnv } from '../core/env.js';

/** Parse `hub`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseHubCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath, allowedHosts, adminGithubLogins } = ctx;
  const hostRaw = typeof values.host === 'string' ? values.host : readEnv('TASKCELL_HUB_HOST');
  const host = hostRaw !== undefined && hostRaw.trim() !== '' ? hostRaw : DEFAULT_HUB_HOST;

  const portRaw = typeof values.port === 'string' ? values.port : undefined;
  let port: number;
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return fail(`--port expects an integer between 1 and 65535, got "${portRaw}".`);
    }
    port = parsed;
  } else {
    const envPort = Number(readEnv('TASKCELL_HUB_PORT'));
    port = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : DEFAULT_HUB_PORT;
  }

  const tokenFileRaw = typeof values['token-file'] === 'string' ? values['token-file'] : readEnv('TASKCELL_HUB_TOKEN_FILE');
  const tokenFile = tokenFileRaw !== undefined && tokenFileRaw.trim() !== '' ? tokenFileRaw : undefined;
  if (positionals[1] === 'rotate-token') {
    if (tokenFile === undefined) return fail('hub rotate-token requires --token-file <path> (or TASKCELL_HUB_TOKEN_FILE).');
    return { kind: 'hub-rotate-token', tokenFile };
  }
  if (positionals[1] !== undefined) return fail(`Unknown hub subcommand '${positionals[1]}'. Expected: rotate-token.`);

  return {
    kind: 'hub',
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    repoPath,
    host,
    port,
    ...(typeof values['ui-dir'] === 'string' ? { uiDir: values['ui-dir'] } : {}),
    open: values['no-open'] !== true,
    ...(values.demo === true ? { demo: true } : {}),
    ...(allowedHosts?.length ? { allowedHosts } : {}),
    ...(adminGithubLogins?.length ? { adminGithubLogins } : {}),
  };
}
