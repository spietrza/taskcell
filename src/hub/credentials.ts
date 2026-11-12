// Instance-level provider credentials, encrypted at rest (AES-256-GCM) in `.vanguard-hub/credentials.enc`
// under the hub's config dir. The key is `VANGUARD_HUB_SECRET` (32 bytes, base64). Write-only API: callers
// only ever see "set" + the last four characters. A stored value is applied to `process.env` (overriding the
// same variable from the start-up environment), so the next run picks it up and the LLM proxy sidecar
// still injects it — the sandbox never sees it — and it stays in the injected-secret redaction list.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';

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
  private readonly reason: string | undefined;
  /** Env values as the process started with them, so a deleted credential falls back to them. */
  private readonly original = new Map<string, string | undefined>();

  constructor(configDir: string, secret: string | undefined = process.env.VANGUARD_HUB_SECRET, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.file = join(configDir, '.vanguard-hub', 'credentials.enc');
    const parsed = parseKey(secret);
    this.key = parsed.key;
    this.reason = parsed.reason;
  }

  get enabled(): boolean {
    return this.key !== undefined;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.key === undefined) throw new BadRequestError(this.reason ?? DISABLED_REASON);
    let blob: Buffer;
    try {
      blob = await readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    try {
      return decrypt(this.key, blob);
    } catch (e) {
      throw new BadRequestError((e as Error).message);
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    if (this.key === undefined) throw new BadRequestError(this.reason ?? DISABLED_REASON);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, encrypt(this.key, data), { mode: 0o600 });
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
        return { provider, set, ...(set ? { last4: value.slice(-4) } : {}), env: startEnv !== undefined };
      });
    if (this.key === undefined) return { enabled: false, reason: this.reason ?? DISABLED_REASON, providers: base({}) };
    try {
      return { enabled: true, providers: base(await this.load()) };
    } catch (e) {
      return { enabled: true, reason: (e as Error).message, providers: base({}) };
    }
  }

  async set(provider: CredentialProvider, value: string): Promise<CredentialsSummary> {
    const data = await this.load();
    data[provider] = value;
    await this.save(data);
    this.apply(data);
    return this.summary();
  }

  async delete(provider: CredentialProvider): Promise<CredentialsSummary> {
    const data = await this.load();
    delete data[provider];
    await this.save(data);
    this.apply(data);
    return this.summary();
  }
}
