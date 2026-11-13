// Instance-level provider credentials, encrypted at rest (AES-256-GCM) in `.vanguard-hub/credentials.enc`
// under the hub's config dir. The key is `VANGUARD_HUB_SECRET` (32 bytes, base64). Write-only API: callers
// only ever see "set" + the last four characters. A stored value is applied to `process.env` (overriding the
// same variable from the start-up environment), so the next run picks it up and the LLM proxy sidecar
// still injects it — the sandbox never sees it — and it stays in the injected-secret redaction list.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunCredential } from '../wire.js';
import type { HubUser } from './auth.js';

export const CREDENTIAL_PROVIDERS = ['claude', 'codex', 'zai', 'openrouter'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/** The env var each provider's credential overrides. */
export const CREDENTIAL_ENV: Record<CredentialProvider, string> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  codex: 'OPENAI_API_KEY',
  zai: 'ZAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface CredentialStatus {
  provider: CredentialProvider;
  set: boolean;
  /** Last four characters of the stored value; absent when nothing is stored. */
  last4?: string;
  /** Whether the running process also has this provider's variable from the environment. */
  env: boolean;
}

export interface CredentialsSummary {
  enabled: boolean;
  /** Why the store is disabled, or why it cannot be read. Never contains a credential. */
  reason?: string;
  providers: CredentialStatus[];
}

const DISABLED_REASON = 'VANGUARD_HUB_SECRET is not set; provider credentials come from the hub environment';
const MAGIC = 'VHC1';

function parseKey(raw: string | undefined): { key?: Buffer; reason?: string } {
  if (raw === undefined || raw.trim() === '') return { reason: DISABLED_REASON };
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) return { reason: 'VANGUARD_HUB_SECRET must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)' };
  return { key };
}

function encrypt(key: Buffer, data: Record<string, string>): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC), iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, blob: Buffer): Record<string, string> {
  const fail = (): never => {
    throw new Error('credentials.enc cannot be decrypted: VANGUARD_HUB_SECRET is wrong or the file is corrupt');
  };
  if (blob.length < 4 + 12 + 16 || blob.subarray(0, 4).toString() !== MAGIC) return fail();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    const plain = Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Record<string, string>;
  } catch {
    return fail();
  }
}

export class CredentialStore {
  private readonly file: string;
  private readonly key: Buffer | undefined;
  /** Why the store is disabled; only meaningful when `key` is undefined. */
  private readonly reason: string;
  /** Env values as the process started with them, so a deleted credential falls back to them. */
  private readonly original = new Map<string, string | undefined>();
  /** Serialises load-modify-save so concurrent set/delete calls neither lose an update nor share the tmp file. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(configDir: string, secret: string | undefined = process.env.VANGUARD_HUB_SECRET, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.file = join(configDir, '.vanguard-hub', 'credentials.enc');
    const parsed = parseKey(secret);
    this.key = parsed.key;
    this.reason = parsed.reason ?? DISABLED_REASON;
  }

  get enabled(): boolean {
    return this.key !== undefined;
  }

  private requireKey(): Buffer {
    if (this.key === undefined) throw new BadRequestError(this.reason);
    return this.key;
  }

  private async load(): Promise<Record<string, string>> {
    const key = this.requireKey();
    let blob: Buffer;
    try {
      blob = await readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    try {
      return decrypt(key, blob);
    } catch (e) {
      throw new BadRequestError((e as Error).message);
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    const key = this.requireKey();
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, encrypt(key, data), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Make `data` the effective credentials: stored values override the environment, absent ones restore it. */
  private apply(data: Record<string, string>): void {
    for (const provider of CREDENTIAL_PROVIDERS) {
      const name = CREDENTIAL_ENV[provider];
      if (!this.original.has(name)) this.original.set(name, this.env[name]);
      const value = data[provider];
      if (value !== undefined && value !== '') this.env[name] = value;
      else if (this.original.get(name) === undefined) delete this.env[name];
      else this.env[name] = this.original.get(name);
    }
  }

  /** Apply the stored credentials to the environment (hub start). A no-op when disabled. */
  async applyStored(): Promise<void> {
    if (this.key === undefined) return;
    this.apply(await this.load());
  }

  async summary(): Promise<CredentialsSummary> {
    const base = (data: Record<string, string>): CredentialStatus[] =>
      CREDENTIAL_PROVIDERS.map((provider) => {
        const value = data[provider];
        const set = value !== undefined && value !== '';
        const name = CREDENTIAL_ENV[provider];
        const startEnv = this.original.has(name) ? this.original.get(name) : this.env[name];
        // A short value would be revealed whole by its last four characters, so it gets none.
        return { provider, set, ...(set && value.length > 8 ? { last4: value.slice(-4) } : {}), env: startEnv !== undefined };
      });
    if (this.key === undefined) return { enabled: false, reason: this.reason, providers: base({}) };
    try {
      return { enabled: true, providers: base(await this.load()) };
    } catch (e) {
      return { enabled: true, reason: (e as Error).message, providers: base({}) };
    }
  }

  private mutate(change: (data: Record<string, string>) => void): Promise<CredentialsSummary> {
    const next = this.queue.then(async () => {
      const data = await this.load();
      change(data);
      await this.save(data);
      this.apply(data);
      return this.summary();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  set(provider: CredentialProvider, value: string): Promise<CredentialsSummary> {
    if (value === '') return Promise.reject(new BadRequestError('credential value is empty'));
    return this.mutate((data) => {
      data[provider] = value;
    });
  }

  delete(provider: CredentialProvider): Promise<CredentialsSummary> {
    return this.mutate((data) => {
      delete data[provider];
    });
  }
}

// Per-user provider credentials (server mode, #472). A second encrypted file store (AES-256-GCM, key
// kept 0600 beside it in the hub config dir) holding named provider env credentials per scope — the
// `instance` scope or one `user:<hub user id>` — and the admin switch that decides which scope a
// run draws on. Values are write-only: nothing here, and no RPC built on it, ever returns one except
// to the run that uses it (`RunCredential.env`, never persisted).
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

/** The caller is known but not allowed (non-admin) — maps to HTTP 403 (src/hub/server.ts). */
export class ForbiddenError extends BadRequestError {}

type Scope = 'instance' | `user:${string}`;
type Secrets = Record<string, Record<string, string>>;

export class ScopedCredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'credentials.enc.json');
  }

  private async key(): Promise<Buffer> {
    const path = join(this.dir, 'credentials.key');
    try {
      return Buffer.from((await readFile(path, 'utf8')).trim(), 'hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(this.dir, { recursive: true });
    const fresh = randomBytes(32);
    try {
      await writeFile(path, `${fresh.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
      return fresh;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return Buffer.from((await readFile(path, 'utf8')).trim(), 'hex');
    }
  }

  private async load(): Promise<Secrets> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Secrets;
  }

  private async save(all: Secrets): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
    const body = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
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
const SIGN_IN_REQUIRED = 'Sign in to the hub first — per-user credentials need to know who you are.';

export interface CredentialService {
  isAdmin(user: HubUser | undefined): boolean;
  assertAdmin(user: HubUser | undefined): void;
  policy(): Promise<CredentialPolicy>;
  setPolicy(policy: CredentialPolicy): Promise<void>;
  store: ScopedCredentialStore;
  /** The credential a run started by `user` uses, per the admin switch. Throws a bad-request —
   * BEFORE the run claims the slot — when `user only` is on and the user has none. */
  resolveForRun(user: HubUser | undefined): Promise<RunCredential>;
}

export function createCredentialService(configDir: string, adminLogins: readonly string[] = []): CredentialService {
  const store = new ScopedCredentialStore(configDir);
  const admins = new Set(adminLogins.map((l) => l.trim().toLowerCase()).filter(Boolean));
  const policyFile = join(configDir, 'credential-policy.json');
  const service: CredentialService = {
    store,
    // A GitHub sign-in carries `login: 'github:<login>'`; GitLab, Google and the token owner never match.
    isAdmin: (user) => {
      const login = user?.login?.toLowerCase();
      return login?.startsWith('github:') === true && admins.has(login.slice('github:'.length));
    },
    assertAdmin(user) {
      if (!service.isAdmin(user)) throw new ForbiddenError('admin only — your GitHub login is not in --admin-github-login');
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
    async resolveForRun(user) {
      const policy = await service.policy();
      const instance = async (): Promise<RunCredential> => ({ source: 'instance', env: await store.values('instance') });
      if (policy === 'off') return instance();
      if (user === undefined) {
        if (policy === 'user-only') throw new BadRequestError(SIGN_IN_REQUIRED);
        return instance();
      }
      const own = await store.values(USER_SCOPE(user));
      if (Object.keys(own).length > 0) return { source: 'user', env: own };
      if (policy === 'user-only') throw new BadRequestError(USER_CREDENTIAL_REQUIRED);
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
  return { name, value };
}

export function parseCredentialName(args: Record<string, unknown>): string {
  const { name } = args;
  if (typeof name !== 'string' || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) {
    throw new BadRequestError(`name must be one of: ${CREDENTIAL_NAMES.join(', ')}`);
  }
  return name;
}
