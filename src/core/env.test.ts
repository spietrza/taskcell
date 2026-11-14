import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from './env.js';

/** Every variable that used to be `VANGUARD_<suffix>` (without the dynamic HUB_AUTH_* family, listed in full). */
const SUFFIXES = [
  'APPROVER_AUDIT_SEED', 'APPROVER_STOP', 'CHAT_ALLOWED_ORIGINS', 'CLI_VERSION_CHECK', 'DECISION_MODEL', 'DECISION_PROBE',
  'DECISION_TOKEN', 'DECISION_URL', 'HUB_ADMIN_GITHUB_LOGINS', 'HUB_ALLOWED_HOSTS', 'HUB_ALLOW_ADD', 'HUB_ALLOW_FLEET',
  'HUB_AUTH_GITHUB_CLIENT_ID', 'HUB_AUTH_GITHUB_CLIENT_SECRET', 'HUB_AUTH_GITLAB_CLIENT_ID', 'HUB_AUTH_GITLAB_CLIENT_SECRET',
  'HUB_AUTH_GITLAB_ISSUER', 'HUB_AUTH_GOOGLE_CLIENT_ID', 'HUB_AUTH_GOOGLE_CLIENT_SECRET', 'HUB_AUTH_SECRET', 'HUB_BROWSE_ANYWHERE', 'HUB_BROWSE_ROOT',
  'HUB_CLONE_HOSTS', 'HUB_CONFIG_DIR', 'HUB_EXIT_ON_STDIN_EOF', 'HUB_HOST', 'HUB_MAX_QUEUE', 'HUB_PORT', 'HUB_PUBLIC_URL',
  'HUB_SECRET', 'HUB_SERVER_MODE', 'HUB_SIGNUP_ALLOW', 'HUB_TOKEN_FILE', 'HUB_UI_DIR', 'HUB_WATCH_INTERVAL_MS', 'HUB_WATCH_POLL',
  'LOG_LEVEL', 'MAX_SANDBOXES', 'OPENAI_BASE_URL', 'OTEL', 'OTLP_ENDPOINT', 'OTLP_HEADERS', 'OVERLAP_HOLD_HOURS', 'OWNER_LABEL',
  'PNPM_STORE', 'PNPM_STORE_DIR', 'PUSH_TOKEN', 'SANDBOX_CAP_ADD', 'SANDBOX_CAP_DROP', 'SANDBOX_CPUS', 'SANDBOX_IMAGE',
  'SANDBOX_INIT', 'SANDBOX_MEMORY_MB', 'SANDBOX_NO_NEW_PRIVILEGES', 'SANDBOX_PIDS', 'SANDBOX_READONLY', 'SIDECAR',
  'SIDECAR_MEMORY_MB', 'SKIP_IMAGE_CHECK', 'USAGE_CAP_PCT', 'VERIFY_CMD', 'VISUAL_PROOF_CMD',
];

describe('readEnv', () => {
  it.each(SUFFIXES)('honours the old VANGUARD_%s name and prefers TASKCELL_%s', (suffix) => {
    const oldName = `VANGUARD_${suffix}`;
    const newName = `TASKCELL_${suffix}`;
    expect(readEnv(newName, {})).toBeUndefined();
    expect(readEnv(newName, { [oldName]: 'old' })).toBe('old');
    expect(readEnv(newName, { [newName]: 'new' })).toBe('new');
    expect(readEnv(newName, { [oldName]: 'old', [newName]: 'new' })).toBe('new');
  });

  it('treats an empty new value as unset', () => {
    expect(readEnv('TASKCELL_APPROVER_STOP', { TASKCELL_APPROVER_STOP: '', VANGUARD_APPROVER_STOP: '1' })).toBe('1');
    expect(readEnv('TASKCELL_APPROVER_STOP', { TASKCELL_APPROVER_STOP: '' })).toBe('');
  });
});

describe('direct TASKCELL_* / VANGUARD_* environment access', () => {
  // `file: NAME` of every access that does not go through readEnv. A new one skips the old-name fallback:
  // read it with readEnv, or add it here when the variable never had a VANGUARD_ name (or is only written).
  const ALLOWED = [
    'cli/args.ts: TASKCELL_USAGE_CAP_PCT', // written: --usage-cap hands the value to the stage that reads it with readEnv
    'cli/index.ts: TASKCELL_SIDECAR', // written for the sidecar entrypoints
    'core/audit.ts: TASKCELL_AUDIT_RETENTION_DAYS', // new with the audit log: no old name
    'core/push-token.ts: TASKCELL_APP_CLIENT_ID', // the GitHub App credentials are new: no old name
    'core/push-token.ts: TASKCELL_APP_PRIVATE_KEY',
    'core/secret-scan.ts: TASKCELL_APP_PRIVATE_KEY',
  ];

  it('happens only in env.ts and the listed places', () => {
    const src = join(import.meta.dirname, '..');
    const found = new Set<string>();
    for (const entry of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      const file = entry.replaceAll('\\', '/');
      if (!/\.tsx?$/.test(file) || /\.(test|fixture)\.tsx?$/.test(file) || file === 'core/env.ts') continue;
      for (const m of readFileSync(join(src, entry), 'utf8').matchAll(/\benv(?:\.|\[['"])((?:TASKCELL|VANGUARD)_[A-Z0-9_]+)/g)) found.add(`${file}: ${m[1]}`);
    }
    expect([...found].sort()).toEqual(ALLOWED);
  });
});
