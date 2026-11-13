// Append-only audit log of state-changing hub actions: one JSON line per action in
// `<configDir>/audit.jsonl`. Lines carry only the whitelisted fields below — never a request body,
// credential, token, cookie or error message — so a line cannot leak what the action carried.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonlLines } from '../core/stats.js';
import { appendAudit, localAdapter, STREAMS, TOKEN_AUDIT_ACTOR, type AuditActor, type AuditAdapter, type AuditSubject } from '../core/audit.js';
import type { AuditAction, AuditEntry, AuditOutcome } from '../wire.js';
import { readEnv } from '../core/env.js';

export type { AuditAction, AuditEntry, AuditOutcome };

/** Rotate once the live file reaches this size (rotated files are pruned by age: docs/audit.md). */
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 5000;

/** Who is acting. Header-token access is the shared `token` identity (an admin). */
export interface Actor {
  login: string;
  admin: boolean;
  /** Better Auth user id and display name, when the actor is a signed-in user. */
  id?: string;
  name?: string;
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
  private readonly adapter: AuditAdapter;

  constructor(
    configDir: string,
    opts: { maxBytes?: number; retentionDays?: number } = {},
  ) {
    this.adapter = localAdapter({
      file: join(configDir, 'audit.jsonl'),
      maxBytes: opts.maxBytes ?? AUDIT_MAX_BYTES,
      ...(opts.retentionDays !== undefined ? { retentionDays: opts.retentionDays } : {}),
    });
  }

  /**
   * Append one chained, fsynced line. Fails closed: an unwritable log rejects with AuditWriteError, so
   * the caller reports the failure instead of carrying on unrecorded.
   */
  record(input: AuditRecordInput & { actor?: AuditActor; subject?: AuditSubject }): Promise<void> {
    const entry: AuditEntry = {
      time: new Date().toISOString(),
      login: input.login,
      action: input.action,
      ...(input.target !== undefined ? { target: cleanTarget(input.target) } : {}),
      outcome: input.outcome,
      ...(input.detail !== undefined ? { detail: input.detail.filter((d) => NAME.test(d)).sort() } : {}),
    };
    const actor = input.actor ?? auditActorOf({ login: input.login, admin: false });
    const subject = input.subject ?? subjectOf(input.action, entry.target);
    // The adapter serialises appends per file, so concurrent requests keep the chain in order.
    return appendAudit(STREAMS.hub, this.adapter, { ...entry }, { actor, ...(subject !== undefined ? { subject } : {}) }).then(() => undefined);
  }

  /** Newest first across the live and rotated files, optionally for one login. */
  async read(opts: { login?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
    const out: AuditEntry[] = [];
    // Newest file first, newest line first, stopping as soon as `limit` entries are found.
    for await (const f of this.adapter.newestFirst()) {
      const records = parseJsonlLines(f.text) as unknown as AuditEntry[];
      for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
        if (opts.login === undefined || records[i]!.login === opts.login) out.push(records[i]!);
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** Run actions subject a run id; project actions a repo path. */
function subjectOf(action: string, target: string | undefined): AuditSubject | undefined {
  if (target === undefined) return undefined;
  if (target.startsWith('/')) return { repo: target };
  return action.startsWith('run-') ? { runId: target } : undefined;
}

/** Report an audit write that could not be made without failing the request that triggered it. */
export function reportAuditFailure(err: unknown): void {
  console.error(`audit log write failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** The hub's config dir when `TASKCELL_HUB_CONFIG_DIR` is unset. */
export function defaultHubConfigDir(): string {
  return readEnv('TASKCELL_HUB_CONFIG_DIR') ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'vanguard-hub');
}

/** The audit actor for a hub request: Better Auth id + display name, the shared token, or a login. */
export function auditActorOf(actor: Actor): AuditActor {
  if (actor.login === TOKEN_ACTOR.login) return TOKEN_AUDIT_ACTOR;
  return { kind: 'user', ...(actor.id !== undefined ? { id: actor.id } : {}), name: actor.name ?? actor.login };
}
