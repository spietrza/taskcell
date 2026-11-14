// The one audit record module. Callers append a record to a named stream, read a stream, or verify
// it; behind that sit the state-path guard, deep redaction, tolerant parsing and the hash chain.
// Two adapters: a local state file (rotating, fsynced) and a file on the metrics branch.
//
// A record is the caller's payload plus `actor`, `subject`, `ts` (unless the payload carries a time),
// `prev` (the previous record's `hash`) and `hash` (sha256 over the canonical record without `hash`).
// Editing a line breaks its own hash; deleting or reordering one breaks the next `prev`. The chain
// proves records were not altered after writing — not that a host admin could not rewrite the whole
// file plus chain (docs/audit.md).
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { userInfo } from 'node:os';
import { basename, dirname } from 'node:path';
import { TaskcellError } from './errors.js';
import { injectedSecretValues, redactForPublish } from './secret-scan.js';
import { parseJsonlLines } from './stats.js';
import { assertStatePath, ensureStateDir } from './state-path.js';
import { appendBranchLines, readBranchFile, type BranchFileOptions } from './metrics-branch.js';

/** `audit` streams fsync and fail closed; `telemetry` streams are best-effort. A property of the stream. */
export type AuditClass = 'audit' | 'telemetry';
export interface AuditStream {
  name: string;
  class: AuditClass;
}

export const STREAMS = {
  hub: { name: 'hub', class: 'audit' },
  decisions: { name: 'decisions', class: 'audit' },
  lessons: { name: 'lessons', class: 'audit' },
  metrics: { name: 'metrics', class: 'telemetry' },
  'run-events': { name: 'run-events', class: 'telemetry' },
} as const satisfies Record<string, AuditStream>;

/** Better Auth user (`user`, id + display name), the local owner, the shared hub `token`, or the factory bot. */
export interface AuditActor {
  kind: 'user' | 'local' | 'token' | 'bot';
  id?: string;
  name?: string;
}
/** Whatever of the issue's life is known; the hub run id is persistent across restarts. */
export interface AuditSubject {
  repo?: string;
  issue?: number;
  pr?: number;
  runId?: string;
}
export interface AuditContext {
  actor: AuditActor;
  subject?: AuditSubject;
}

export const BOT_ACTOR: AuditActor = { kind: 'bot', name: 'taskcell[bot]' };
export const TOKEN_AUDIT_ACTOR: AuditActor = { kind: 'token', name: 'token' };

/** The factory bot in CI, else the local owner. */
export function defaultActor(env: NodeJS.ProcessEnv = process.env): AuditActor {
  if (env.GITHUB_ACTIONS === 'true' || env.GITLAB_CI === 'true') return BOT_ACTOR;
  let name = 'owner';
  try {
    name = userInfo().username;
  } catch {
    // no passwd entry (some containers): keep the generic name
  }
  return { kind: 'local', name };
}

const warned = new Set<string>();
/** Kept apart from `warned`: clearing this bounded set must not re-arm the once-per-stream warning. */
const warnedMessages = new Set<string>();

/** Warn once per distinct message: a repo-controlled sibling or line would otherwise flood the log on every append. */
function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  if (warnedMessages.size >= 1000) warnedMessages.clear();
  warnedMessages.add(message);
  console.warn(message);
}

export class AuditWriteError extends TaskcellError {}

export const GENESIS_HASH = '0'.repeat(64);
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Retention in days: explicit value, else TASKCELL_AUDIT_RETENTION_DAYS, else 90. */
export function retentionDays(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromEnv = Number(env.TASKCELL_AUDIT_RETENTION_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RETENTION_DAYS;
}

/** Mask secrets in every string of a JSON-like value (structure-preserving, so the line stays valid JSON). */
export function redactDeep(value: unknown, secrets: readonly string[] = injectedSecretValues()): unknown {
  if (typeof value === 'string') return redactForPublish(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]));
  }
  return value;
}

/** JSON with sorted keys, so a hash does not depend on key order surviving a parse/stringify round trip. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const ENVELOPE_KEYS = new Set(['actor', 'subject', 'prev', 'hash']);

export function recordHash(record: Record<string, unknown>): string {
  const { hash: _hash, ...rest } = record;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

const hashOf = (r: Record<string, unknown>): string | undefined => (typeof r.hash === 'string' ? r.hash : undefined);

/** The `hash` of the last chained record in `records`, or undefined when none is chained. */
export function tailHash(records: readonly Record<string, unknown>[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const h = hashOf(records[i]!);
    if (h !== undefined) return h;
  }
  return undefined;
}

/** Redact `payload`, stamp actor/subject/time and chain it after `prev`. */
export function sealRecord(payload: Record<string, unknown>, ctx: AuditContext, prev: string, now: Date = new Date()): Record<string, unknown> {
  const body = redactDeep(payload) as Record<string, unknown>;
  // A payload key that collides with the envelope is kept under an underscore, never dropped.
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) rest[ENVELOPE_KEYS.has(k) ? `_${k}` : k] = v;
  const record: Record<string, unknown> = {
    ...rest,
    ...(timeOf(rest) !== undefined ? {} : { ts: now.toISOString() }),
    actor: ctx.actor,
    ...(ctx.subject !== undefined && Object.keys(ctx.subject).length > 0 ? { subject: ctx.subject } : {}),
    prev,
  };
  record.hash = recordHash(record);
  return record;
}

/** Seal `payloads` in order, each chained to the one before; the first chains to `prev`. */
export function sealAll(payloads: readonly Record<string, unknown>[], ctx: AuditContext, prev: string | undefined): Record<string, unknown>[] {
  let last = prev ?? GENESIS_HASH;
  return payloads.map((p) => {
    const sealed = sealRecord(p, ctx, last);
    last = sealed.hash as string;
    return sealed;
  });
}

export interface AuditFile {
  name: string;
  text: string;
}

export interface AuditAdapter {
  /** Every retained file of the stream, oldest first. */
  files(): Promise<AuditFile[]>;
  /** The same files newest first, read lazily so a caller wanting the last N records stops early. */
  newestFirst(): AsyncIterable<AuditFile>;
  /** Append the payloads as chained records; resolves to how many were written (a dedupe key can skip some). `durable` = fsync before resolving. Throws on failure. */
  append(payloads: readonly Record<string, unknown>[], ctx: AuditContext, durable: boolean): Promise<number>;
}

/**
 * Append to a stream. An `audit` stream fsyncs and throws {@link AuditWriteError} when the line cannot
 * be written (the caller refuses or reports the action); a `telemetry` stream swallows the failure.
 * Resolves to the number of records written.
 */
export async function appendAudit(
  stream: AuditStream,
  adapter: AuditAdapter,
  payloads: Record<string, unknown> | readonly Record<string, unknown>[],
  ctx: AuditContext,
): Promise<number> {
  const list = Array.isArray(payloads) ? (payloads as readonly Record<string, unknown>[]) : [payloads as Record<string, unknown>];
  try {
    return await adapter.append(list, ctx, stream.class === 'audit');
  } catch (err) {
    if (stream.class === 'telemetry') {
      // Best-effort, but not silent: say so once per stream.
      if (!warned.has(stream.name)) {
        warned.add(stream.name);
        console.warn(`taskcell: ${stream.name} records are not being written: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 0;
    }
    throw new AuditWriteError(`audit stream '${stream.name}' write failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** Every record of the stream, oldest first, tolerating torn and blank lines. */
export async function readAudit(adapter: AuditAdapter): Promise<Record<string, unknown>[]> {
  return (await adapter.files()).flatMap((f) => parseJsonlLines(f.text));
}

export interface AuditProblem {
  file: string;
  line: number;
  reason: string;
}
export interface VerifyResult {
  ok: boolean;
  /** Chained records checked. */
  records: number;
  /** Unchained lines written before the chain began (tolerated). */
  legacy: number;
  /** Lines that do not parse (a crash mid-write): reported, not a failure; a lost record still breaks the chain. */
  torn: number;
  problems: AuditProblem[];
}

/**
 * Walk the files in order carrying the chain across them. The first chained record is the anchor: its
 * `prev` is not checked (retention may have pruned what came before). After that every record must
 * hash to its own `hash` and its `prev` must equal the previous record's `hash`.
 */
export function verifyFiles(files: readonly AuditFile[]): VerifyResult {
  const result: VerifyResult = { ok: true, records: 0, legacy: 0, torn: 0, problems: [] };
  let expected: string | undefined;
  const fail = (file: string, line: number, reason: string): void => {
    result.problems.push({ file, line, reason });
  };
  for (const f of files) {
    const lines = f.text.split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => x.l !== '');
    for (const { l, n } of lines) {
      let rec: unknown;
      try {
        rec = JSON.parse(l);
      } catch {
        // A crash mid-write leaves a partial line; a damaged record is caught by the chain (the next prev breaks).
        result.torn += 1;
        continue;
      }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        fail(f.name, n, 'not a JSON object');
        continue;
      }
      const r = rec as Record<string, unknown>;
      const hash = hashOf(r);
      if (hash === undefined) {
        if (expected === undefined) result.legacy += 1;
        else fail(f.name, n, 'unchained record after the chain began');
        continue;
      }
      result.records += 1;
      if (recordHash(r) !== hash) fail(f.name, n, 'hash mismatch (line edited)');
      else if (expected !== undefined && r.prev !== expected) fail(f.name, n, 'chain broken (line deleted or reordered)');
      expected = hash;
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

export async function verifyAudit(adapter: AuditAdapter): Promise<VerifyResult> {
  return verifyFiles(await adapter.files());
}

const timeOf = (r: Record<string, unknown>): string | undefined =>
  [r.ts, r.time, r.timestamp].find((v): v is string => typeof v === 'string');

/** Records with `since <= time <= until` (ISO strings; either bound optional). Records without a time are kept. */
export function filterByTime(records: readonly Record<string, unknown>[], since?: string, until?: string): Record<string, unknown>[] {
  const lo = since !== undefined ? Date.parse(since) : undefined;
  const hi = until !== undefined ? Date.parse(until) : undefined;
  return records.filter((r) => {
    const t = timeOf(r);
    const ms = t !== undefined ? Date.parse(t) : NaN;
    if (Number.isNaN(ms)) return true;
    return (lo === undefined || ms >= lo) && (hi === undefined || ms <= hi);
  });
}

const csvCell = (v: unknown): string => {
  const s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Quote anything with a delimiter/quote/newline; neutralise a leading formula character.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** `jsonl`: one record per line. `csv`: ts, stream, actor, subject, then the whole record as JSON. */
export function exportRecords(records: readonly Record<string, unknown>[], format: 'jsonl' | 'csv', stream = '', header = true): string {
  if (format === 'jsonl') return records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  const rows = records.map((r) => [timeOf(r), stream, r.actor, r.subject, r].map(csvCell).join(','));
  return [...(header ? ['ts,stream,actor,subject,record'] : []), ...rows].map((l) => `${l}\n`).join('');
}

// ---- local adapter ----------------------------------------------------------------------------

const ROTATED = /^(\d+|\d{8}T\d{9}Z(-\d+)?)$/;
/** Rotated files kept per stream whatever their age, so disk use stays bounded inside the retention window. */
export const DEFAULT_MAX_ROTATED = 50;
const MAX_TRACKED = 1000;
/** Appends to one file are serialised process-wide, whichever adapter instance made them. */
const queues = new Map<string, Promise<unknown>>();
/** The chain tail per file, valid while the file still has the size we left it at. */
const tails = new Map<string, { size: number; hash: string }>();
const pruned = new Map<string, boolean>();

export interface LocalAdapterOptions {
  file: string;
  /** Repo whose state dir holds `file`: the symlink guard applies. Omit for files outside a repo (hub config dir). */
  repoPath?: string;
  maxBytes?: number;
  retentionDays?: number;
  maxRotated?: number;
}

/** Rotated siblings of `file`, oldest first (legacy `.N` suffixes are older than any timestamp). */
async function rotatedFiles(file: string): Promise<string[]> {
  const names = await readdir(dirname(file)).catch(() => [] as string[]);
  const base = basename(file);
  const suffixes = names.filter((n) => n.startsWith(`${base}.`) && ROTATED.test(n.slice(base.length + 1))).map((n) => n.slice(base.length + 1));
  const numeric = suffixes.filter((s) => /^\d+$/.test(s)).sort((a, b) => Number(b) - Number(a));
  const stamped = suffixes.filter((s) => !/^\d+$/.test(s)).sort();
  return [...numeric, ...stamped].map((s) => `${file}.${s}`);
}

async function pruneRotated(file: string, days: number, maxRotated: number): Promise<void> {
  const cutoff = Date.now() - days * 86_400_000;
  const all = await rotatedFiles(file);
  const excess = all.length - maxRotated;
  for (const [i, f] of all.entries()) {
    const info = await lstat(f).catch(() => undefined);
    // Legacy numeric suffixes are count-retained only; the age prune applies to timestamped files.
    const aged = info !== undefined && !/\.\d+$/.test(f) && info.mtimeMs < cutoff;
    if (info !== undefined && (i < excess || aged)) await rm(f, { force: true, recursive: true });
  }
}

/** Cross-process mutual exclusion for one file's append (O_EXCL lock file; a stale lock is broken after 10 s). */
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  for (let waited = 0; ; waited += 10) {
    try {
      await (await open(lock, 'wx', 0o600)).close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const info = await lstat(lock).catch(() => undefined);
      const age = info !== undefined ? Date.now() - info.mtimeMs : 0;
      if (age <= 10_000 && waited <= 15_000) await sleep(10);
      // A lock that is a directory can never be a live lock (ours is a file): clear it once stale, re-checking
      // that it is still a real directory (not swapped for a symlink) so the recursive remove never follows a link.
      // If it no longer is one, the path may be another process's fresh lock file: look again, do not remove it.
      else if (info?.isDirectory() === true) {
        if ((await lstat(lock).catch(() => undefined))?.isDirectory() !== true) continue;
        // Not warnOnce: this reports an action, at most one per stale period, and a later directory lock at the same path must be reported too.
        console.warn(`taskcell: audit lock ${lock} is a directory; removing it`);
        await rm(lock, { force: true, recursive: true });
      } else await rm(lock, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** An audit file's text; a missing file is empty, any other read error is reported and read as empty. */
async function readText(p: string): Promise<string> {
  return readFile(p, 'utf8').catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnOnce(`taskcell: cannot read audit file ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return '';
  });
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as K);
}

async function endsWithNewline(file: string, size: number): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

export function localAdapter(opts: LocalAdapterOptions): AuditAdapter {
  const { file } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const days = retentionDays(opts.retentionDays);
  const maxRotated = opts.maxRotated ?? DEFAULT_MAX_ROTATED;
  // The directory/symlink guard is checked once per adapter; every later append only re-checks the leaf.
  let dirReady = false;

  /** Every retained file with its text. `skipBad` (the append path's chain-tail lookup only) drops a rotated sibling that fails the state-path guard, with a warning; readers keep the guard's error. */
  const readAll = async (skipBad = false): Promise<AuditFile[]> => {
    const paths = [...(await rotatedFiles(file)), file];
    const out: AuditFile[] = [];
    for (const p of paths) {
      if (opts.repoPath !== undefined) {
        try {
          await assertStatePath(opts.repoPath, p);
        } catch (err) {
          if (!skipBad || p === file) throw err;
          warnOnce(`taskcell: skipping audit file ${p}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      out.push({ name: p, text: await readText(p) });
    }
    return out;
  };

  const currentTail = async (size: number): Promise<string | undefined> => {
    const cached = tails.get(file);
    if (cached !== undefined && cached.size === size) return cached.hash;
    const all = await readAll(true);
    for (let i = all.length - 1; i >= 0; i--) {
      const { name, text } = all[i]!;
      const h = tailHash(parseJsonlLines(text, () => warnOnce(`taskcell: ignoring a line in ${name} that is not a JSON object`)));
      if (h !== undefined) return h;
    }
    return undefined;
  };

  /** Create the directory (once) and re-check the leaf for a symlink; runs before the lock file is made. */
  const prepare = async (): Promise<void> => {
    if (!dirReady) {
      if (opts.repoPath !== undefined) await ensureStateDir(opts.repoPath, dirname(file));
      else await mkdir(dirname(file), { recursive: true });
      dirReady = true;
    }
    if (opts.repoPath !== undefined) await assertStatePath(opts.repoPath, file);
  };

  const write = async (payloads: readonly Record<string, unknown>[], ctx: AuditContext, durable: boolean): Promise<number> => {
    let written = 0;
    let size = await stat(file).then((s) => s.size, () => 0);
    // The tail is read before rotating so the chain carries into the fresh file.
    let tail = await currentTail(size);
    if (size >= maxBytes) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      let target = `${file}.${stamp}`;
      for (let n = 1; await stat(target).then(() => true, () => false); n++) target = `${file}.${stamp}-${n}`;
      await rename(file, target);
      size = 0;
      await pruneRotated(file, days, maxRotated);
    } else if (!pruned.has(file)) {
      remember(pruned, file, true);
      await pruneRotated(file, days, maxRotated).catch(() => undefined);
    }
    const sealed = sealAll(payloads, ctx, tail);
    tail = sealed.at(-1)!.hash as string;
    const fh = await open(file, 'a', 0o600);
    try {
      // A crash mid-write leaves a line without its newline: start a fresh line so the new record stays parseable.
      const torn = size > 0 && !(await endsWithNewline(file, size));
      const data = `${torn ? '\n' : ''}${sealed.map((r) => JSON.stringify(r)).join('\n')}\n`;
      written = Buffer.byteLength(data);
      await fh.appendFile(data);
      if (durable) await fh.sync();
    } finally {
      await fh.close();
    }
    remember(tails, file, { size: size + written, hash: tail });
    return sealed.length;
  };

  return {
    files: () => readAll(),
    newestFirst: async function* () {
      const paths = [file, ...(await rotatedFiles(file)).reverse()];
      for (const p of paths) {
        if (opts.repoPath !== undefined) await assertStatePath(opts.repoPath, p);
        yield { name: p, text: await readText(p) };
      }
    },
    append: (payloads, ctx, durable) => {
      const next = (queues.get(file) ?? Promise.resolve()).then(async () => {
        await prepare();
        return withFileLock(file, () => write(payloads, ctx, durable));
      });
      const settled = next.then(() => undefined, () => undefined);
      queues.set(file, settled);
      void settled.then(() => {
        if (queues.get(file) === settled) queues.delete(file);
      });
      return next;
    },
  };
}

// ---- metrics-branch adapter -------------------------------------------------------------------

export interface BranchAdapterOptions extends BranchFileOptions {
  file: string;
  /** Dedupe key over the payload (same meaning as appendBranchLines). */
  key?: (record: Record<string, unknown>) => string | undefined;
}

/** A file on the metrics branch. Records are chained inside the push, so a retried push re-chains on the fresh tip. */
export function branchAdapter(repoPath: string, opts: BranchAdapterOptions): AuditAdapter {
  const where = { ...(opts.branch !== undefined ? { branch: opts.branch } : {}), ...(opts.remote !== undefined ? { remote: opts.remote } : {}) };
  return {
    files: async () => [{ name: opts.file, text: await readBranchFile(repoPath, { ...where, file: opts.file }) }],
    newestFirst: async function* () {
      yield { name: opts.file, text: await readBranchFile(repoPath, { ...where, file: opts.file }) };
    },
    append: async (payloads, ctx) => {
      const res = await appendBranchLines(repoPath, payloads.map((p) => JSON.stringify(p)), {
        ...where,
        file: opts.file,
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        seal: (fresh, existing) => sealAll(fresh, ctx, tailHash(existing)),
      });
      return res.pushed;
    },
  };
}
