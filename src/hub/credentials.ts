// Provider credentials (server mode): ONE encrypted file store (AES-256-GCM, `credentials.enc.json` in the hub
// config dir; its key is `TASKCELL_HUB_SECRET` when set, else `credentials.key` beside it) holding named provider
// env credentials per scope — the `instance` scope or one `user:<hub (Better Auth) user id>` — and the switch that
// decides which scope a run draws on. Values are write-only: nothing here, and no RPC built on it, ever returns one
// except to the run that uses it (`RunCredential.env`, never persisted). The retired `credentials.enc` (key from
// `TASKCELL_HUB_SECRET`) is migrated into the `instance` scope on start.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { readCooldownFile, recordCooldownFile } from '../core/cooldowns.js';
import type { AccountType, CredentialAccountView, CredentialRotation, RunCredential } from '../wire.js';
import { fallbackSlot } from '../wire.js';
import { parseSignupAllowlist, type HubUser } from './auth.js';

const LEGACY_MAGIC = 'VHC1';
const SECRET_FORMAT = 'TASKCELL_HUB_SECRET must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)';
const present = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const legacyPath = (configDir: string): string => join(configDir, '.vanguard-hub', 'credentials.enc');

/** A store or migration failure whose message is fixed and value-free (no path, no credential), so it can be shown
 * to a user as is; a bad request, so the RPC is refused with the reason rather than failing. */
export class CredentialStoreError extends BadRequestError {}

/** The reason to show for a store failure: our own fixed message, never raw error text (file-system errors carry paths). */
const shownReason = (error: unknown, fallback: string): string => (error instanceof CredentialStoreError ? error.message : fallback);
const STORE_UNREADABLE = 'credential store cannot be read: a file in the hub config directory is unreadable (see the hub log)';
const MIGRATION_FAILED = 'credentials.enc could not be migrated: a file in the hub config directory is unreadable (see the hub log)';

/** The env var each legacy `credentials.enc` provider slot held. */
const LEGACY_ENV: Record<string, string> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  codex: 'OPENAI_API_KEY',
  zai: 'ZAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function decryptLegacy(secret: string, blob: Buffer): Record<string, unknown> {
  const key = Buffer.from(secret.trim(), 'base64');
  if (key.length !== 32) throw new CredentialStoreError(SECRET_FORMAT);
  try {
    if (blob.length < 4 + 12 + 16 || blob.subarray(0, 4).toString() !== LEGACY_MAGIC) throw new Error('bad magic');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new CredentialStoreError('credentials.enc cannot be decrypted: TASKCELL_HUB_SECRET is wrong or the file is corrupt');
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
  const file = legacyPath(configDir);
  let blob: Buffer;
  try {
    blob = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { moved: [], skipped: [] };
    throw e;
  }
  if (secret === undefined || secret.trim() === '') {
    throw new CredentialStoreError('credentials.enc is no longer read: set TASKCELL_HUB_SECRET once so it can be migrated into the credential store');
  }
  const legacy = decryptLegacy(secret, blob);
  const existing = await store.values('instance');
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const [provider, value] of Object.entries(legacy)) {
    if (!Object.hasOwn(LEGACY_ENV, provider)) continue;
    const name = LEGACY_ENV[provider]!;
    if (typeof value !== 'string') throw new CredentialStoreError(`credentials.enc contains a non-string value for ${name}`);
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
      throw new CredentialStoreError(`credentials.enc migration could not verify ${name}`);
    }
  }
  await rm(file, { force: true });
  return { moved: moved.sort(), skipped: skipped.sort() };
}

export type { HubUser, AccountType, CredentialAccountView };

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

/** Stored accounts: several credentials per provider, each named and switchable. Only `claude` for now; other providers keep one value per variable. */
export const ACCOUNT_TYPES = ['subscription', 'api-key', 'auth-token'] as const satisfies readonly AccountType[];
export const ACCOUNT_PROVIDERS = ['claude'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
/** Per provider, per scope (the instance scope is hub-wide; each signed-in user has their own). Disabled accounts count. */
export const MAX_ACCOUNTS_PER_PROVIDER = 20;
export const ACCOUNT_ENV: Record<AccountType, string> = {
  subscription: 'CLAUDE_CODE_OAUTH_TOKEN',
  'api-key': 'ANTHROPIC_API_KEY',
  'auth-token': 'ANTHROPIC_AUTH_TOKEN',
};
const ACCOUNT_TYPE_OF_ENV: Record<string, AccountType> = Object.fromEntries(Object.entries(ACCOUNT_ENV).map(([type, env]) => [env, type as AccountType]));

/** An account as stored (encrypted). `value` never leaves the store except into a run's env. Array order is pick order. */
export interface StoredAccount {
  id: string;
  provider: AccountProvider;
  name: string;
  type: AccountType;
  enabled: boolean;
  value: string;
}

/** Built by an explicit field allow-list, never by spreading a stored account. */
export const toView = (a: StoredAccount, coolingUntil?: Date): CredentialAccountView => ({
  id: a.id,
  provider: a.provider,
  name: a.name,
  type: a.type,
  enabled: a.enabled,
  ...(coolingUntil !== undefined ? { coolingUntil: coolingUntil.toISOString() } : {}),
});

/** The encrypted payload (v2). v1 was a bare `Record<Scope, Record<env, value>>` and is upgraded in memory on load. */
interface Secrets {
  v: 2;
  env: Record<string, Record<string, string>>;
  accounts: Record<string, StoredAccount[]>;
}

function normalise(raw: unknown): Secrets {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.v === 2 && typeof r.env === 'object' && r.env !== null && typeof r.accounts === 'object' && r.accounts !== null) return r as unknown as Secrets;
  const out: Secrets = { v: 2, env: {}, accounts: {} };
  for (const [scope, vars] of Object.entries(r as Record<string, Record<string, string>>)) {
    const env: Record<string, string> = {};
    const accounts: StoredAccount[] = [];
    for (const type of ACCOUNT_TYPES) {
      const name = ACCOUNT_ENV[type];
      if (typeof vars[name] === 'string') accounts.push({ id: `v1-${type}`, provider: 'claude', name, type, enabled: true, value: vars[name] });
    }
    for (const [k, v] of Object.entries(vars)) if (!Object.hasOwn(ACCOUNT_TYPE_OF_ENV, k)) env[k] = v;
    out.env[scope] = env;
    if (accounts.length > 0) out.accounts[scope] = accounts;
  }
  return out;
}

const emptySecrets = (): Secrets => ({ v: 2, env: {}, accounts: {} });

const TERMS_ACK_REQUIRED =
  "enabling a second subscription token needs acknowledgeTerms: Anthropic's Claude Code terms say plan limits \"assume ordinary, individual usage\", so rotating several subscription accounts may breach them (API keys are fine)";
export const TERMS_WARNING =
  "More than one subscription token is enabled. Anthropic's Claude Code terms say plan limits \"assume ordinary, individual usage\"; rotating several subscription accounts to get past limits may breach the Consumer Terms. API keys are allowed.";

export interface AccountInput {
  id?: string;
  provider?: string;
  name?: string;
  type?: AccountType;
  value?: string;
  enabled?: boolean;
  acknowledgeTerms?: boolean;
}

const upsert = (list: readonly StoredAccount[], next: StoredAccount, exists: boolean): StoredAccount[] =>
  exists ? list.map((a) => (a.id === next.id ? next : a)) : [...list, next];

const isEnabledSubscription = (a: StoredAccount | undefined): boolean => a !== undefined && a.enabled && a.type === 'subscription';

/** The value-free status warning for a scope (instance or user) while more than one subscription token is enabled in it. */
export const termsWarningFor = (accounts: readonly StoredAccount[]): string | undefined =>
  accounts.filter(isEnabledSubscription).length > 1 ? TERMS_WARNING : undefined;

/** One validation for every account write: cap, unique name, and the subscription-token terms rule (the same in every scope). `next` is the account as it will be stored. */
function assertAccountAllowed(list: readonly StoredAccount[], prior: StoredAccount | undefined, next: StoredAccount, acknowledgeTerms: boolean): void {
  const name = next.name;
  if (name.length < 1 || name.length > 64 || [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new CredentialStoreError('name must be 1-64 characters with no control characters');
  }
  const others = list.filter((a) => a.id !== next.id && a.provider === next.provider);
  if (others.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new CredentialStoreError('another credential already has that name');
  if (prior === undefined && others.length >= MAX_ACCOUNTS_PER_PROVIDER) {
    throw new CredentialStoreError(`at most ${MAX_ACCOUNTS_PER_PROVIDER} ${next.provider} credentials can be stored`);
  }
  if (isEnabledSubscription(next) && !isEnabledSubscription(prior) && others.some(isEnabledSubscription) && !acknowledgeTerms) {
    throw new CredentialStoreError(TERMS_ACK_REQUIRED);
  }
}

/** No usable `TASKCELL_HUB_SECRET` but `credentials.keyed` is present: `credentials.key` is neither read nor written. */
function markerWithoutSecret(): CredentialStoreError {
  return new CredentialStoreError('credential store cannot be decrypted: credentials.keyed records that the store was saved under a TASKCELL_HUB_SECRET value that is no longer set (or is not usable), so credentials.key is neither read nor written. Restore that secret to recover it, or, if the store is meant to be on credentials.key, remove credentials.keyed (in the hub config directory); the store and the marker are left untouched');
}

/** No usable secret, `credentials.keyed` present and no store file: nothing to decrypt, but a save would start a store on `credentials.key`. */
function markerWithoutStore(): CredentialStoreError {
  return new CredentialStoreError('credential store save refused: credentials.keyed records that the store was saved under TASKCELL_HUB_SECRET, but this start has no usable secret and no store file, so a new store is not started on credentials.key. Set the secret again, or, if the store is meant to be on credentials.key, remove credentials.keyed (in the hub config directory); the marker is left untouched');
}

export class ScopedCredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly secret?: string) {}

  private get file(): string {
    return join(this.dir, 'credentials.enc.json');
  }

  /** Set once this store has read or written under the operator's secret: from then on `credentials.key` is never
   * tried again, so a planted key file plus store cannot replace the saved credentials.
   * Also persisted as `credentials.keyed` beside the store so it holds across restarts; that file lives in the config
   * directory, so it stops a planted key file only against someone who cannot also delete it. */
  private operatorKeyed = false;
  /** The last load read a disk-key store whose re-key is put off (a legacy file is still unmigrated): saves stay under `credentials.key`. */
  private rekeyDeferred = false;

  /** Why a set `TASKCELL_HUB_SECRET` is not used (the store then stays on `credentials.key`, as before the secret keyed it). */
  get secretIssue(): string | undefined {
    const secret = this.secret?.trim() ?? '';
    return secret !== '' && Buffer.from(secret, 'base64').length !== 32 ? `${SECRET_FORMAT}; until it is, the credential store uses credentials.key` : undefined;
  }

  private operatorKey(): Buffer | undefined {
    if (this.secret === undefined || this.secret.trim() === '') return undefined;
    const key = Buffer.from(this.secret.trim(), 'base64');
    return key.length === 32 ? key : undefined;
  }

  private async diskKey(create: boolean): Promise<Buffer> {
    const path = join(this.dir, 'credentials.key');
    try {
      const key = Buffer.from((await readFile(path, 'utf8')).trim(), 'hex');
      if (key.length !== 32) throw new CredentialStoreError('credentials.key must contain a 32-byte hex key');
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
      if (key.length !== 32) throw new CredentialStoreError('credentials.key must contain a 32-byte hex key');
      return key;
    }
  }

  private decrypt(raw: string, key: Buffer): Secrets {
    const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return normalise(JSON.parse(plain.toString('utf8')));
  }

  private keyedPath(): string {
    return join(this.dir, 'credentials.keyed');
  }

  /** Remember (in memory, and in a marker file once, best effort: a read-only config dir must not make a readable store fail) that the store is keyed under the secret. */
  private async markKeyed(): Promise<void> {
    this.operatorKeyed = true;
    if (await present(this.keyedPath())) return;
    await writeFile(this.keyedPath(), 'keyed under TASKCELL_HUB_SECRET\n', { mode: 0o600 }).catch(() => undefined);
  }

  /** The store is (re)written under `credentials.key`: a marker from an earlier secret no longer describes it. */
  private async unmarkKeyed(): Promise<void> {
    this.operatorKeyed = false;
    try {
      await rm(this.keyedPath(), { force: true });
    } catch {
      throw new CredentialStoreError('credential store save refused: credentials.keyed could not be removed; remove it by hand (in the hub config directory); the store is left untouched');
    }
  }

  private async load(): Promise<Secrets> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySecrets();
      throw error;
    }
    this.rekeyDeferred = false;
    const operatorKey = this.operatorKey();
    if (operatorKey !== undefined) {
      let opened: Secrets | undefined;
      try {
        opened = this.decrypt(raw, operatorKey);
      } catch {
        opened = undefined;
      }
      if (opened !== undefined) {
        await this.markKeyed();
        return opened;
      }
      const undecryptable = new CredentialStoreError('credential store cannot be decrypted: it was saved under a different TASKCELL_HUB_SECRET value (or under the on-disk credentials.key, now absent), or the file is corrupt. Restore that value to recover it; the store is left untouched');
      // The store is left as it is: nothing here overwrites or deletes what cannot be read.
      const keyed = this.operatorKeyed || await present(this.keyedPath());
      let legacy: Secrets;
      try {
        legacy = this.decrypt(raw, await this.diskKey(false));
      } catch {
        throw undecryptable;
      }
      if (keyed) {
        throw new CredentialStoreError('credential store is under credentials.key, but credentials.keyed records that it was keyed under TASKCELL_HUB_SECRET, so credentials.key is not trusted. If you restored this store yourself, remove credentials.keyed (in the hub config directory) to re-key it; the store is left untouched');
      }
      // While credentials.enc is unmigrated the secret may not be the one that opens it: re-keying now could leave
      // two files that no single secret reads, so the store stays under credentials.key until the migration is done.
      if (await present(legacyPath(this.dir))) {
        this.rekeyDeferred = true;
        return legacy;
      }
      // Re-key under the operator's secret; credentials.key goes only once the new file reads back.
      await this.saveWithKey(legacy, operatorKey);
      if (JSON.stringify(this.decrypt(await readFile(this.file, 'utf8'), operatorKey)) !== JSON.stringify(legacy)) {
        throw new CredentialStoreError('credential store could not be verified after re-keying under TASKCELL_HUB_SECRET');
      }
      await rm(join(this.dir, 'credentials.key'), { force: true });
      await this.markKeyed();
      return legacy;
    }
    // A marker means the store was keyed under a secret this start cannot use: credentials.key is not read.
    if (await present(this.keyedPath())) throw markerWithoutSecret();
    try {
      return this.decrypt(raw, await this.diskKey(false));
    } catch {
      throw new CredentialStoreError('credential store cannot be decrypted: it was saved under a TASKCELL_HUB_SECRET value that is no longer set, or credentials.key is missing or wrong, or the file is corrupt. Restore that secret or key to recover it; the store is left untouched');
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
    const usable = this.operatorKey();
    // With no usable secret a marker is never removed, also when the store file is absent: the save is refused instead,
    // so deleting the store cannot turn a marker into a fresh credentials.key store.
    if (usable === undefined && await present(this.keyedPath())) throw await present(this.file) ? markerWithoutSecret() : markerWithoutStore();
    // While credentials.enc is unmigrated and the store is not yet under the secret, stay on credentials.key so no
    // second secret comes into play (the secret may not be the one that opens the legacy file).
    const deferred = this.rekeyDeferred || (!this.operatorKeyed && await present(legacyPath(this.dir)));
    const operatorKey = deferred ? undefined : usable;
    // Drop a stale marker BEFORE the disk-key write, so a crash between the two cannot leave a readable store locked out.
    // Only reached with a usable secret whose re-key is deferred (credentials.enc is unmigrated).
    if (operatorKey === undefined) {
      await this.unmarkKeyed();
      // With a usable secret and no store file, a credentials.key already on disk was not written by this hub for any store: never adopt it.
      if (usable !== undefined && !await present(this.file)) await rm(join(this.dir, 'credentials.key'), { force: true });
    }
    await this.saveWithKey(all, operatorKey ?? await this.diskKey(true));
    if (operatorKey !== undefined) await this.markKeyed();
  }

  /** Why a save would be refused with no store file: a marker without a usable secret. Settings shows it before the first save fails. */
  async markerIssue(): Promise<string | undefined> {
    if (this.operatorKey() !== undefined || !await present(this.keyedPath()) || await present(this.file)) return undefined;
    return markerWithoutStore().message;
  }

  /** Why a valid secret is not keying the store: an unmigrated `credentials.enc` keeps new saves on `credentials.key`. */
  async legacyIssue(): Promise<string | undefined> {
    if (this.operatorKey() === undefined || this.operatorKeyed || !await present(legacyPath(this.dir))) return undefined;
    return 'credentials.enc is unmigrated, so the credential store stays on credentials.key until it is migrated or removed';
  }

  /** Serialize read-modify-write cycles so two saves never lose each other's update. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Credential values for a scope (server-internal: only run resolution reads these): the plain variables plus the
   * first enabled account per Claude variable. */
  values(scope: Scope): Promise<Record<string, string>> {
    return this.serial(async () => {
      const all = await this.load();
      const env = { ...(all.env[scope] ?? {}) };
      for (const a of all.accounts[scope] ?? []) {
        const name = ACCOUNT_ENV[a.type];
        if (a.enabled && env[name] === undefined) env[name] = a.value;
      }
      return env;
    });
  }

  async names(scope: Scope): Promise<string[]> {
    return Object.keys(await this.values(scope)).sort();
  }

  /** The scope's stored accounts, in pick order, WITH values (server-internal). */
  accounts(scope: Scope): Promise<StoredAccount[]> {
    return this.serial(async () => ((await this.load()).accounts[scope] ?? []).map((a) => ({ ...a })));
  }

  /** Create (`value` required) or update (`value` optional: rename or toggle without re-entering the secret) an account; returns its id. */
  putAccount(scope: Scope, input: AccountInput): Promise<string> {
    return this.serial(async () => {
      const all = await this.load();
      const list = all.accounts[scope] ?? [];
      const prior = input.id !== undefined ? list.find((a) => a.id === input.id) : undefined;
      if (input.id !== undefined && prior === undefined) throw new CredentialStoreError('unknown credential');
      if (prior === undefined && (input.value === undefined || input.value === '')) throw new CredentialStoreError('value is required for a new credential');
      const provider = input.provider ?? prior?.provider ?? 'claude';
      if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(provider)) throw new CredentialStoreError(`provider must be one of: ${ACCOUNT_PROVIDERS.join(', ')}`);
      const next: StoredAccount = {
        id: prior?.id ?? randomUUID(),
        provider: provider as AccountProvider,
        name: (input.name ?? prior?.name ?? '').trim(),
        type: input.type ?? prior?.type ?? 'api-key',
        enabled: input.enabled ?? prior?.enabled ?? true,
        value: input.value ?? prior?.value ?? '',
      };
      assertAccountAllowed(list, prior, next, input.acknowledgeTerms === true);
      all.accounts[scope] = upsert(list, next, prior !== undefined);
      await this.save(all);
      return next.id;
    });
  }

  removeAccount(scope: Scope, id: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      const list = all.accounts[scope] ?? [];
      if (!list.some((a) => a.id === id)) throw new CredentialStoreError('unknown credential');
      all.accounts[scope] = list.filter((a) => a.id !== id);
      await this.save(all);
    });
  }

  /** `ids` must be a permutation of the scope's account ids: the new pick order. */
  reorderAccounts(scope: Scope, ids: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      const list = all.accounts[scope] ?? [];
      if (ids.length !== list.length || new Set(ids).size !== ids.length || !list.every((a) => ids.includes(a.id))) {
        throw new CredentialStoreError('ids must list every stored credential exactly once');
      }
      all.accounts[scope] = ids.map((id) => list.find((a) => a.id === id)!);
      await this.save(all);
    });
  }

  put(scope: Scope, name: string, value: string): Promise<void> {
    const type = ACCOUNT_TYPE_OF_ENV[name];
    // A Claude variable is the account named after it (created if none); the single-slot RPCs stay a subset of the account model.
    if (type !== undefined) {
      return this.serial(async () => {
        const all = await this.load();
        const list = all.accounts[scope] ?? [];
        const prior = list.find((a) => a.type === type && a.name === name);
        const next: StoredAccount = { id: prior?.id ?? randomUUID(), provider: 'claude', name, type, enabled: prior?.enabled ?? true, value };
        assertAccountAllowed(list, prior, next, false);
        all.accounts[scope] = upsert(list, next, prior !== undefined);
        await this.save(all);
      });
    }
    return this.serial(async () => {
      const all = await this.load();
      all.env[scope] = { ...(all.env[scope] ?? {}), [name]: value };
      await this.save(all);
    });
  }

  remove(scope: Scope, name: string): Promise<void> {
    const type = ACCOUNT_TYPE_OF_ENV[name];
    return this.serial(async () => {
      const all = await this.load();
      if (type !== undefined) {
        all.accounts[scope] = (all.accounts[scope] ?? []).filter((a) => !(a.type === type && a.name === name));
      } else {
        const { [name]: _gone, ...rest } = all.env[scope] ?? {};
        all.env[scope] = rest;
      }
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
  instanceStatus(): Promise<{ names: string[]; reason?: string; accounts: CredentialAccountView[]; termsWarning?: string }>;
  /** A scope's stored accounts as RPC-safe views (never a value), with the time a limited one cools until. */
  accountViews(scope: Scope): Promise<CredentialAccountView[]>;
  /** Rotation for one run: same scope, same provider, list order. Undefined unless the provider is claude and `first` is a stored account. */
  rotationFor(user: HubUser | undefined, provider: string | undefined, first: RunCredential): CredentialRotation | undefined;
  /** Move the retired `credentials.enc` into the store (names logged, never values). A failure is kept as the
   * status reason and retried on later status reads, so it clears without a restart once it succeeds. */
  migrateLegacy(): Promise<void>;
  putInstance(name: string, value: string): Promise<void>;
  removeInstance(name: string): Promise<void>;
  /** Environment for a hub child that consumes instance credentials: one provider's names (doc chat), or every
   * storable name when the child's provider is not known (Fleet). Never mutates `process.env`. */
  childEnv(provider?: string): NodeJS.ProcessEnv;
  /** The credential a run started by `user` uses, per the admin switch. Throws a bad-request —
   * BEFORE the run claims the slot — when `user only` is on and the user has none for `provider`
   * (default claude). Resolved per provider: only that provider's variables are returned. */
  resolveForRun(user: HubUser | undefined, provider?: string, extra?: readonly string[]): Promise<RunCredential>;
}

export function createCredentialService(configDir: string, adminLogins: readonly string[] = [], secret?: string, hubAdmins: readonly string[] = []): CredentialService {
  const store = new ScopedCredentialStore(configDir, secret);
  // `--admin-github-login` values are bare GitHub logins; `TASKCELL_HUB_ADMINS` entries use the sign-up allowlist syntax.
  const admins = parseSignupAllowlist([...adminLogins.filter((l) => l.trim() !== '').map((l) => `github:${l.trim()}`), ...hubAdmins]);
  const policyFile = join(configDir, 'credential-policy.json');
  let migrationIssue: string | undefined;
  let migrating: Promise<void> | undefined;
  let instanceValues: Record<string, string> = {};
  // Credential cool-downs are hub-level (a credential serves every project): same file format as the model pool's.
  const cooldownFile = join(configDir, 'credential-cooldowns.json');
  let cooldownChain: Promise<unknown> = Promise.resolve();
  const coolKey = (scope: Scope, id: string): string => `credential:${scope}:${id}`;
  const readCooling = (): Promise<Map<string, Date>> => readCooldownFile(cooldownFile);
  const recordCooling = (scope: Scope, id: string, until: Date): Promise<void> => {
    // Serialised: two runs hitting limits at once must not lose each other's write.
    const next = cooldownChain.then(() => recordCooldownFile(cooldownFile, coolKey(scope, id), until, {
      prepare: async (path) => {
        await mkdir(configDir, { recursive: true });
        const st = await lstat(path).catch(() => undefined);
        if (st?.isSymbolicLink()) throw new CredentialStoreError('credential-cooldowns.json is a symbolic link');
      },
    }));
    cooldownChain = next.catch(() => undefined);
    return next;
  };
  const toCredential = (source: 'instance' | 'user', a: StoredAccount): RunCredential => ({ source, env: { [ACCOUNT_ENV[a.type]]: a.value }, accountId: a.id, accountName: a.name });
  // Only the types the claude provider authenticates with (`authFromEnv`): an auth-token (gateway) account is not rotated onto.
  const enabledAccounts = async (scope: Scope): Promise<StoredAccount[]> => (await store.accounts(scope)).filter((a) => a.enabled && a.provider === 'claude' && a.type !== 'auth-token');
  /** The first enabled, non-cooling account (not in `skip`), or why none: how many are enabled and when the first resets. */
  const pickAccount = async (scope: Scope, source: 'instance' | 'user', skip: ReadonlySet<string> = new Set()): Promise<{ credential?: RunCredential; enabled: number; resets?: Date; soonest?: RunCredential }> => {
    const enabled = await enabledAccounts(scope);
    const cooling = await readCooling();
    const live = enabled.filter((a) => !skip.has(a.id));
    const free = live.find((a) => !cooling.has(coolKey(scope, a.id)));
    if (free !== undefined) return { credential: toCredential(source, free), enabled: enabled.length };
    const byReset = live
      .map((a) => ({ a, until: cooling.get(coolKey(scope, a.id)) }))
      .filter((x): x is { a: StoredAccount; until: Date } => x.until !== undefined)
      .sort((x, y) => x.until.getTime() - y.until.getTime());
    const first = byReset[0];
    return { enabled: enabled.length, ...(first !== undefined ? { resets: first.until, soonest: toCredential(source, first.a) } : {}) };
  };
  const allCooling = (enabled: number, resets: Date | undefined): BadRequestError =>
    new BadRequestError(`all ${enabled} Claude credentials are cooling down after a provider limit${resets !== undefined ? `; the first resets at ${resets.toISOString()}` : ''}`);
  const service: CredentialService = {
    store,
    // A GitHub or GitLab sign-in carries `login: '<provider>:<login>'`; an e-mail or domain entry needs a verified address.
    // The token owner (unverified `owner@hub.invalid`, no login) never matches.
    isAdmin: (user) => {
      if (user === undefined) return false;
      const base = { email: user.email, emailVerified: user.emailVerified === true };
      return [undefined, ...(user.logins ?? (user.login !== undefined ? [user.login] : []))].some((login) => admins({ ...base, login }));
    },
    assertManager(user, owner) {
      if (!owner && !service.isAdmin(user)) throw new ForbiddenError('only the hub owner or a hub admin (TASKCELL_HUB_ADMINS, --admin-github-login) can do this');
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
      if (migrationIssue !== undefined) await service.migrateLegacy();
      try {
        instanceValues = await store.values('instance');
        const reason = [migrationIssue ?? store.secretIssue, await store.legacyIssue(), await store.markerIssue()].filter((r) => r !== undefined).join('; ') || undefined;
        const accounts = await service.accountViews('instance');
        const termsWarning = termsWarningFor(await store.accounts('instance'));
        return {
          names: Object.keys(instanceValues).sort(),
          ...(reason !== undefined ? { reason } : {}),
          accounts,
          ...(termsWarning !== undefined ? { termsWarning } : {}),
        };
      } catch (error) {
        // `instanceValues` keeps the last good read, so doc chat and Fleet do not silently drop to the start-up environment.
        if (!(error instanceof CredentialStoreError)) console.error(`vanguard-hub: ${(error as Error).message}`);
        return { names: [], reason: shownReason(error, STORE_UNREADABLE), accounts: [] };
      }
    },
    async accountViews(scope) {
      const cooling = await readCooling();
      return (await store.accounts(scope)).map((a) => toView(a, cooling.get(coolKey(scope, a.id))));
    },
    rotationFor(user, provider, first) {
      if ((provider ?? 'claude') !== 'claude' || first.accountId === undefined) return undefined;
      const scope: Scope = first.source === 'user' && user !== undefined ? USER_SCOPE(user) : 'instance';
      const exhausted = new Set<string>();
      let current = first.accountId;
      // The fallback chain's keys ride along on every account the run moves to; only the Anthropic variable changes.
      const anthropic = new Set(Object.values(ACCOUNT_ENV));
      const chainEnv = Object.fromEntries(Object.entries(first.env).filter(([name]) => !anthropic.has(name)));
      const withChain = (c: RunCredential | undefined): RunCredential | undefined => (c === undefined ? undefined : { ...c, env: { ...chainEnv, ...c.env } });
      return {
        provider: 'claude',
        async hasNext() {
          try {
            return (await pickAccount(scope, first.source, new Set([...exhausted, current]))).credential !== undefined;
          } catch {
            return false;
          }
        },
        async limited(accountId, until) {
          exhausted.add(accountId);
          await recordCooling(scope, accountId, until).catch(() => undefined);
          try {
            const next = (await pickAccount(scope, first.source, exhausted)).credential;
            if (next?.accountId !== undefined) current = next.accountId;
            return withChain(next);
          } catch {
            return undefined;
          }
        },
        async cool(accountId, until) {
          await recordCooling(scope, accountId, until);
        },
        async refresh(cur) {
          if (cur.accountId === undefined || !(await readCooling()).has(coolKey(scope, cur.accountId))) return cur;
          const next = (await pickAccount(scope, first.source, exhausted)).credential;
          if (next?.accountId !== undefined) current = next.accountId;
          return withChain(next) ?? cur;
        },
      };
    },
    migrateLegacy() {
      // Single-flight: two status reads retrying at once share one migration.
      migrating ??= (async (): Promise<void> => {
        try {
          const { moved, skipped } = await migrateLegacyCredentials(configDir, store, secret);
          if (moved.length > 0) console.error(`vanguard-hub: migrated credentials from credentials.enc: ${moved.join(', ')}`);
          if (skipped.length > 0) console.error(`vanguard-hub: kept existing credentials while migrating credentials.enc: ${skipped.join(', ')}`);
          migrationIssue = undefined;
        } catch (error) {
          const reason = shownReason(error, MIGRATION_FAILED);
          if (reason !== migrationIssue) console.error(`vanguard-hub: ${error instanceof Error ? error.message : reason}`);
          migrationIssue = reason;
        }
      })().finally(() => {
        migrating = undefined;
      });
      return migrating;
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
      const names = provider === undefined ? CREDENTIAL_NAMES : PROVIDER_NAMES[provider] ?? [];
      return { ...process.env, ...pick(instanceValues, names) };
    },
    async resolveForRun(user, provider = 'claude', extra = []) {
      const policy = await service.policy();
      const names = PROVIDER_NAMES[provider];
      // The fallback chain's providers add their names to the env, but the source is decided by the primary alone.
      // A non-Claude Engine takes Claude from the chain as ONE variable of the account list (`withClaudeVar`), never all three names.
      const anthropic = new Set(Object.values(ACCOUNT_ENV));
      const allNames = names === undefined ? undefined : [...new Set([...names, ...extra.flatMap((p) => (provider !== 'claude' && p === 'claude' ? [] : PROVIDER_NAMES[p] ?? []))])];
      const withClaudeVar = async (credential: RunCredential, scope: Scope): Promise<RunCredential> => {
        if (provider === 'claude' || !extra.includes('claude') || names === undefined) return credential;
        const picked = await pickAccount(scope, credential.source).catch(() => undefined);
        return picked?.credential === undefined ? credential : { ...credential, env: { ...picked.credential.env, ...credential.env } };
      };
      // A stored Claude account funds the run alone; the chain providers' keys from the same scope join it (still one Anthropic variable).
      const chainNames = (allNames ?? []).filter((n) => !anthropic.has(n));
      const withChain = async (credential: RunCredential, scope: Scope): Promise<RunCredential> => {
        if (chainNames.length === 0) return credential;
        const values = await store.values(scope).catch(() => ({}));
        return { ...credential, env: { ...pick(values, chainNames), ...credential.env } };
      };
      // Every account cooling is no refusal while a chain entry can take the run: it starts and the engine moves to the chain
      // (as without stored accounts). Mirrors deps' `fundedParams`: only a built-in with a key counts (a custom's keys are unknown here,
      // meridian cannot run on a stored key), and a lone entry on the Engine's own transport (claude → zai) is dropped there.
      const chainFunded = async (scope: Scope): Promise<boolean> => {
        const values: Record<string, string> = await store.values(scope).catch(() => ({}));
        const hostFunds = scope === 'instance';
        const funded = extra.filter((p) => p !== 'claude' && (PROVIDER_NAMES[p] ?? []).some((n) => (values[n] ?? '') !== '' || (hostFunds && (process.env[n] ?? '') !== '')));
        return funded.length > 1 || (funded.length === 1 && fallbackSlot(funded[0]!) !== fallbackSlot('claude'));
      };
      const instance = async (): Promise<RunCredential> => {
        if (provider === 'claude') {
          try {
            const { credential, enabled, resets, soonest } = await pickAccount('instance', 'instance');
            if (credential !== undefined) return await withChain(credential, 'instance');
            if (soonest !== undefined && (await chainFunded('instance'))) return await withChain(soonest, 'instance');
            if (enabled > 0) throw allCooling(enabled, resets);
          } catch (error) {
            if (error instanceof BadRequestError && !(error instanceof CredentialStoreError)) throw error;
            // An unreadable store falls through to the plain read below, which reports it (or lets the start-up env fund the run).
          }
        }
        let env: Record<string, string> = {};
        try {
          env = await store.values('instance');
        } catch (error) {
          // An unreadable store does not stop a run the hub's start-up environment can fund (as before the secret
          // keyed this store); with no key there either, the run needs the store and is refused with the reason.
          // Only names this provider can use count: a Claude key cannot fund a meridian run; a custom provider has none.
          const fundable = names ?? (provider === 'meridian' ? ['MERIDIAN_API_KEY'] : []);
          if (!fundable.some((n) => (process.env[n] ?? '') !== '')) throw new BadRequestError(shownReason(error, STORE_UNREADABLE));
        }
        return withClaudeVar({ source: 'instance', env: allNames === undefined ? env : pick(env, allNames) }, 'instance');
      };
      if (policy === 'off') return instance();
      if (user === undefined) {
        if (policy === 'user-only') throw new BadRequestError(SIGN_IN_REQUIRED);
        return instance();
      }
      if (provider === 'claude') {
        // The user's own accounts: never silently moved onto the instance's when they are all cooling (that spends the hub's money).
        try {
          const { credential, enabled, resets, soonest } = await pickAccount(USER_SCOPE(user), 'user');
          if (credential !== undefined) return await withChain(credential, USER_SCOPE(user));
          if (soonest !== undefined && (await chainFunded(USER_SCOPE(user)))) return await withChain(soonest, USER_SCOPE(user));
          if (enabled > 0) throw allCooling(enabled, resets);
        } catch (error) {
          if (error instanceof BadRequestError && !(error instanceof CredentialStoreError)) throw error;
          if (policy === 'user-only') throw new BadRequestError(shownReason(error, STORE_UNREADABLE));
        }
      }
      let own: Record<string, string> = {};
      try {
        own = await store.values(USER_SCOPE(user));
      } catch (error) {
        if (policy === 'user-only') throw new BadRequestError(shownReason(error, STORE_UNREADABLE));
      }
      // Meridian / custom providers (no `names`): any saved credential makes it a user run (credentialEnv refuses it if unusable).
      const mine = names === undefined ? own : pick(own, names);
      if (Object.keys(mine).length > 0) return withClaudeVar({ source: 'user', env: allNames === undefined ? mine : pick(own, allNames) }, USER_SCOPE(user));
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
