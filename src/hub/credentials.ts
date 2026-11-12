// Per-user provider credentials (server mode, #472). An encrypted file store (AES-256-GCM, key kept
// 0600 beside it in the hub config dir) holding named provider env credentials per scope — the
// `instance` scope or one `user:<hub user id>` — and the admin switch that decides which scope a
// run draws on. Values are write-only: nothing here, and no RPC built on it, ever returns one except
// to the run that uses it (`RunCredential.env`, never persisted).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunCredential } from '../wire.js';
import type { HubUser } from './auth.js';

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

/** Maps to HTTP 403 (src/hub/server.ts). */
export class ForbiddenError extends Error {}

type Scope = 'instance' | `user:${string}`;
type Secrets = Record<string, Record<string, string>>;

export class CredentialStore {
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
  store: CredentialStore;
  /** The credential a run started by `user` uses, per the admin switch. Throws a bad-request —
   * BEFORE the run claims the slot — when `user only` is on and the user has none. */
  resolveForRun(user: HubUser | undefined): Promise<RunCredential>;
}

export function createCredentialService(configDir: string, adminLogins: readonly string[] = []): CredentialService {
  const store = new CredentialStore(configDir);
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
