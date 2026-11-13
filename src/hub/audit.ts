// Append-only audit log of state-changing hub actions: one JSON line per action in
// `<configDir>/audit.jsonl`. Lines carry only the whitelisted fields below — never a request body,
// credential, token, cookie or error message — so a line cannot leak what the action carried.
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditAction, AuditEntry, AuditOutcome } from '../wire.js';

export type { AuditAction, AuditEntry, AuditOutcome };

/** Rotate once the live file reaches this size. */
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
/** Files kept in total: the live file plus the newest rotated ones. */
export const AUDIT_KEEP_FILES = 5;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 5000;

/** Who is acting. Header-token access is the shared `token` identity (an admin). */
export interface Actor {
  login: string;
  admin: boolean;
}
export const TOKEN_ACTOR: Actor = { login: 'token', admin: true };

/** `detail` is names only (e.g. the settings keys that changed) — never values. */
export type AuditRecordInput = Omit<AuditEntry, 'time'>;

/** A clone URL reduced to scheme, host and path: userinfo, query and fragment can carry a credential. */
export function safeUrl(raw: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(raw);
  if (scp) return `${scp[1]}:${scp[2]!.split(/[?#]/, 1)[0]}`;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

const MAX_TARGET = 256;

/** Client-supplied targets are bounded, stripped of control characters, and URL-shaped ones lose userinfo/query. */
function cleanTarget(raw: string): string {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[\w.-]+@[\w.-]+:/.test(raw) ? safeUrl(raw) : raw;
  const flat = url.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return flat.length > MAX_TARGET ? `${flat.slice(0, MAX_TARGET)}…` : flat;
}

const NAME = /^[\w.-]{1,64}$/;

export class AuditLog {
  private readonly file: string;
  private readonly maxBytes: number;
  /** Serialises appends so concurrent requests cannot interleave a rotation with a write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly configDir: string,
    opts: { maxBytes?: number } = {},
  ) {
    this.file = join(configDir, 'audit.jsonl');
    this.maxBytes = opts.maxBytes ?? AUDIT_MAX_BYTES;
  }

  /** Append one line. Never throws: an unwritable log must not fail the action it records. */
  record(input: AuditRecordInput): Promise<void> {
    const entry: AuditEntry = {
      time: new Date().toISOString(),
      login: input.login,
      action: input.action,
      ...(input.target !== undefined ? { target: cleanTarget(input.target) } : {}),
      outcome: input.outcome,
      ...(input.detail !== undefined ? { detail: input.detail.filter((d) => NAME.test(d)).sort() } : {}),
    };
    const next = this.queue.then(() => this.append(`${JSON.stringify(entry)}\n`));
    this.queue = next.catch((e: unknown) => console.error(`audit log write failed: ${e instanceof Error ? e.message : String(e)}`));
    return this.queue as Promise<void>;
  }

  private async append(line: string): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const size = await stat(this.file).then((s) => s.size, () => 0);
    if (size >= this.maxBytes) await this.rotate();
    await appendFile(this.file, line, { mode: 0o600 });
  }

  private async rotate(): Promise<void> {
    const oldest = AUDIT_KEEP_FILES - 1;
    await rm(`${this.file}.${oldest}`, { force: true });
    for (let i = oldest - 1; i >= 1; i--) await rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => undefined);
    await rename(this.file, `${this.file}.1`);
  }

  /** Newest first across the live and rotated files, optionally for one login. */
  async read(opts: { login?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
    await this.queue;
    const out: AuditEntry[] = [];
    for (let i = 0; i < AUDIT_KEEP_FILES && out.length < limit; i++) {
      const raw = await readFile(i === 0 ? this.file : `${this.file}.${i}`, 'utf8').catch(() => '');
      const lines = raw.split('\n');
      for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
        if (lines[j] === '') continue;
        try {
          const entry = JSON.parse(lines[j]!) as AuditEntry;
          if (opts.login === undefined || entry.login === opts.login) out.push(entry);
        } catch {
          // a torn line is skipped, not fatal
        }
      }
    }
    return out;
  }
}
