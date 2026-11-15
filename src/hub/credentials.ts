// Provider credentials (server mode): ONE encrypted file store (AES-256-GCM, `credentials.enc.json` in the hub
// config dir; its key is `TASKCELL_HUB_SECRET` when set, else `credentials.key` beside it) holding named provider
// env credentials per scope — the `instance` scope or one `user:<hub (Better Auth) user id>` — and the switch that
// decides which scope a run draws on. Values are write-only: nothing here, and no RPC built on it, ever returns one
// except to the run that uses it (`RunCredential.env`, never persisted). The retired `credentials.enc` (key from
// `TASKCELL_HUB_SECRET`) is migrated into the `instance` scope on start.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunCredential } from '../wire.js';
import type { HubUser } from './auth.js';

const LEGACY_MAGIC = 'VHC1';

/** The env var each legacy `credentials.enc` provider slot held. */
const LEGACY_ENV: Record<string, string> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  codex: 'OPENAI_API_KEY',
  zai: 'ZAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function decryptLegacy(secret: string, blob: Buffer): Record<string, unknown> {
  const key = Buffer.from(secret.trim(), 'base64');
  if (key.length !== 32) throw new Error('TASKCELL_HUB_SECRET must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)');
  try {
    if (blob.length < 4 + 12 + 16 || blob.subarray(0, 4).toString() !== LEGACY_MAGIC) throw new Error('bad magic');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('credentials.enc cannot be decrypted: TASKCELL_HUB_SECRET is wrong or the file is corrupt');
  }
}

export interface CredentialMigrationResult {
  moved: string[];
  skipped: string[];
}

/** One-time migration of the retired `.vanguard-hub/credentials.enc` (keyed by `TASKCELL_HUB_SECRET`) into the
 * `instance` scope of the scoped store. A name already saved in the scoped store wins. The legacy file is deleted
 * only after every write was read back; partial work is safe to resume. Throws (file kept) on any failure. */
export async function migrateLegacyCredentials(configDir: string, store: ScopedCredentialStore, secret: string | undefined): Promise<CredentialMigrationResult> {
  const file = join(configDir, '.vanguard-hub', 'credentials.enc');
  let blob: Buffer;
  try {
    blob = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { moved: [], skipped: [] };
    throw e;
  }
  if (secret === undefined || secret.trim() === '') {
    throw new Error('credentials.enc is no longer read: set TASKCELL_HUB_SECRET once so it can be migrated into the credential store');
  }
  const legacy = decryptLegacy(secret, blob);
  const existing = await store.values('instance');
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const [provider, value] of Object.entries(legacy)) {
    if (!Object.hasOwn(LEGACY_ENV, provider)) continue;
    const name = LEGACY_ENV[provider]!;
    if (typeof value !== 'string') throw new Error(`credentials.enc contains a non-string value for ${name}`);
    if (value === '') continue;
    if (existing[name] !== undefined) {
      skipped.push(name);
      continue;
    }
    await store.put('instance', name, value);
    moved.push(name);
  }
  const verified = await store.values('instance');
  for (const name of moved) {
    const provider = Object.keys(LEGACY_ENV).find((key) => LEGACY_ENV[key] === name)!;
    if (verified[name] !== legacy[provider]) {
      throw new Error(`credentials.enc migration could not verify ${name}`);
    }
  }
  await unlink(file);
  return { moved: moved.sort(), skipped: skipped.sort() };
}

export type { HubUser };

export const CREDENTIAL_POLICIES = ['off', 'user-first', 'user-only'] as const;
export type CredentialPolicy = (typeof CREDENTIAL_POLICIES)[number];

/** Only provider credential variables are storable: an arbitrary name could overlay PATH or a
 * GitHub token in a run's environment. */
export const CREDENTIAL_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_AUTH_JSON',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'CURSOR_API_KEY',
  'MERIDIAN_API_KEY',
] as const;

/** The storable variables each built-in provider reads; meridian and repo customs are not listed. */
export const PROVIDER_NAMES: Record<string, readonly string[]> = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['CODEX_AUTH_JSON', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  zai: ['ZAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

const pick = (env: Record<string, string>, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([k]) => names.includes(k)));

/** The caller is known but not allowed (non-admin) — maps to HTTP 403 (src/hub/server.ts). */
export class ForbiddenError extends BadRequestError {}

type Scope = 'instance' | `user:${string}`;
type Secrets = Record<string, Record<string, string>>;

export class ScopedCredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly secret?: string) {}

  private get file(): string {
    return join(this.dir, 'credentials.enc.json');
  }

  private operatorKey(): Buffer | undefined {
    if (this.secret === undefined || this.secret.trim() === '') return undefined;
    const key = Buffer.from(this.secret.trim(), 'base64');
    if (key.length !== 32) throw new Error('TASKCELL_HUB_SECRET must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)');
    return key;
  }

  private async diskKey(create: boolean): Promise<Buffer> {
    const path = join(this.dir, 'credentials.key');
    try {
      const key = Buffer.from((await readFile(path, 'utf8')).trim(), 'hex');
      if (key.length !== 32) throw new Error('credentials.key must contain a 32-byte hex key');
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    }
    await mkdir(this.dir, { recursive: true });
    const fresh = randomBytes(32);
    try {
      await writeFile(path, `${fresh.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
      return fresh;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const key = Buffer.from((await readFile(path, 'utf8')).trim(), 'hex');
      if (key.length !== 32) throw new Error('credentials.key must contain a 32-byte hex key');
      return key;
    }
  }

  private decrypt(raw: string, key: Buffer): Secrets {
    const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Secrets;
  }

  private async load(): Promise<Secrets> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const operatorKey = this.operatorKey();
    if (operatorKey !== undefined) {
      try {
        return this.decrypt(raw, operatorKey);
      } catch {
        try {
          const legacy = this.decrypt(raw, await this.diskKey(false));
          await this.saveWithKey(legacy, operatorKey);
          return legacy;
        } catch {
          throw new Error('credential store cannot be decrypted: TASKCELL_HUB_SECRET is wrong or the file is corrupt');
        }
      }
    }
    try {
      return this.decrypt(raw, await this.diskKey(false));
    } catch {
      throw new Error('credential store cannot be decrypted: credentials.key is missing or wrong, or the file is corrupt');
    }
  }

  private async saveWithKey(all: Secrets, key: Buffer): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
    const body = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  private async save(all: Secrets): Promise<void> {
    await this.saveWithKey(all, this.operatorKey() ?? await this.diskKey(true));
  }

  /** Serialize read-modify-write cycles so two saves never lose each other's update. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Credential values for a scope (server-internal: only run resolution reads these). */
  values(scope: Scope): Promise<Record<string, string>> {
    return this.serial(async () => ({ ...((await this.load())[scope] ?? {}) }));
  }

  async names(scope: Scope): Promise<string[]> {
    return Object.keys(await this.values(scope)).sort();
  }

  put(scope: Scope, name: string, value: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      all[scope] = { ...(all[scope] ?? {}), [name]: value };
      await this.save(all);
    });
  }

  remove(scope: Scope, name: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      const { [name]: _gone, ...rest } = all[scope] ?? {};
      all[scope] = rest;
      await this.save(all);
    });
  }
}

export const USER_SCOPE = (user: HubUser): Scope => `user:${user.id}`;

export const USER_CREDENTIAL_REQUIRED =
  'This hub only runs on your own provider credentials — add one in Settings → Credentials, then start the run again.';
const userCredentialRequiredFor = (provider: string, names: readonly string[]): string =>
  `This hub only runs on your own provider credentials — you have none for ${provider}; add one in Settings → Credentials (${names.join(' or ')}), then start the run again.`;
const SIGN_IN_REQUIRED = 'Sign in to the hub first — per-user credentials need to know who you are.';

export interface CredentialService {
  isAdmin(user: HubUser | undefined): boolean;
  /** The one gate for every instance-credential RPC and the switch: the hub owner (token holder) or an admin. */
  assertManager(user: HubUser | undefined, owner: boolean): void;
  policy(): Promise<CredentialPolicy>;
  setPolicy(policy: CredentialPolicy): Promise<void>;
  store: ScopedCredentialStore;
  /** Instance credential names and any safe, value-free reason the store or legacy migration needs attention. */
  instanceStatus(): Promise<{ names: string[]; reason?: string }>;
  setMigrationIssue(reason: string | undefined): void;
  putInstance(name: string, value: string): Promise<void>;
  removeInstance(name: string): Promise<void>;
  /** Environment for a provider child that intentionally consumes instance credentials. Never mutates `process.env`. */
  childEnv(provider: string): NodeJS.ProcessEnv;
  /** The credential a run started by `user` uses, per the admin switch. Throws a bad-request —
   * BEFORE the run claims the slot — when `user only` is on and the user has none for `provider`
   * (default claude). Resolved per provider: only that provider's variables are returned. */
  resolveForRun(user: HubUser | undefined, provider?: string): Promise<RunCredential>;
}

export function createCredentialService(configDir: string, adminLogins: readonly string[] = [], secret?: string): CredentialService {
  const store = new ScopedCredentialStore(configDir, secret);
  const admins = new Set(adminLogins.map((l) => l.trim().toLowerCase()).filter(Boolean));
  const policyFile = join(configDir, 'credential-policy.json');
  let migrationIssue: string | undefined;
  let instanceValues: Record<string, string> = {};
  const service: CredentialService = {
    store,
    // A GitHub sign-in carries `login: 'github:<login>'`; GitLab, Google and the token owner never match.
    isAdmin: (user) => {
      const login = user?.login?.toLowerCase();
      return login?.startsWith('github:') === true && admins.has(login.slice('github:'.length));
    },
    assertManager(user, owner) {
      if (!owner && !service.isAdmin(user)) throw new ForbiddenError('only the hub owner or an admin (--admin-github-login) can do this');
    },
    async policy() {
      try {
        const parsed = JSON.parse(await readFile(policyFile, 'utf8')) as { policy?: unknown };
        return (CREDENTIAL_POLICIES as readonly unknown[]).includes(parsed.policy) ? (parsed.policy as CredentialPolicy) : 'off';
      } catch {
        return 'off';
      }
    },
    async setPolicy(policy) {
      await mkdir(configDir, { recursive: true });
      await writeFile(policyFile, JSON.stringify({ policy }), 'utf8');
    },
    async instanceStatus() {
      try {
        instanceValues = await store.values('instance');
        const names = Object.keys(instanceValues).sort();
        return { names, ...(migrationIssue !== undefined ? { reason: migrationIssue } : {}) };
      } catch (error) {
        instanceValues = {};
        return { names: [], reason: error instanceof Error ? error.message : 'credential store cannot be read' };
      }
    },
    setMigrationIssue(reason) {
      migrationIssue = reason;
    },
    async putInstance(name, value) {
      await store.put('instance', name, value);
      instanceValues = { ...instanceValues, [name]: value };
    },
    async removeInstance(name) {
      await store.remove('instance', name);
      const { [name]: _removed, ...rest } = instanceValues;
      instanceValues = rest;
    },
    childEnv(provider) {
      const names = PROVIDER_NAMES[provider] ?? [];
      return { ...process.env, ...pick(instanceValues, names) };
    },
    async resolveForRun(user, provider = 'claude') {
      const policy = await service.policy();
      const names = PROVIDER_NAMES[provider];
      const instance = async (): Promise<RunCredential> => {
        const env = await store.values('instance');
        return { source: 'instance', env: names === undefined ? env : pick(env, names) };
      };
      if (policy === 'off') return instance();
      if (user === undefined) {
        if (policy === 'user-only') throw new BadRequestError(SIGN_IN_REQUIRED);
        return instance();
      }
      const own = await store.values(USER_SCOPE(user));
      // Meridian / custom providers (no `names`): any saved credential makes it a user run (credentialEnv refuses it if unusable).
      const mine = names === undefined ? own : pick(own, names);
      if (Object.keys(mine).length > 0) return { source: 'user', env: mine };
      if (policy === 'user-only') {
        throw new BadRequestError(names === undefined ? USER_CREDENTIAL_REQUIRED : userCredentialRequiredFor(provider, names));
      }
      return instance();
    },
  };
  return service;
}

/** Validate a `{ name, value }` credential save: a known provider variable, a non-blank value. */
export function parseCredentialInput(args: Record<string, unknown>): { name: string; value: string } {
  const { name, value } = args;
  if (typeof name !== 'string' || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) {
    throw new BadRequestError(`name must be one of: ${CREDENTIAL_NAMES.join(', ')}`);
  }
  if (typeof value !== 'string' || value.trim() === '') throw new BadRequestError('value is required and must be a non-blank string');
  return { name, value: value.trim() };
}

export function parseCredentialName(args: Record<string, unknown>): string {
  const { name } = args;
  if (typeof name !== 'string' || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) {
    throw new BadRequestError(`name must be one of: ${CREDENTIAL_NAMES.join(', ')}`);
  }
  return name;
}
