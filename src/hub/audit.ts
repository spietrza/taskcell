// Append-only audit log of state-changing hub actions: one JSON line per action in
// `<configDir>/audit.jsonl`. Lines carry only the whitelisted fields below — never a request body,
// credential, token, cookie or error message — so a line cannot leak what the action carried.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonlLines } from '../core/stats.js';
import { appendAudit, hubAuditFile, localAdapter, STREAMS, TOKEN_AUDIT_ACTOR, type AuditActor, type AuditAdapter, type AuditSubject } from '../core/audit.js';
import type { AuditAction, AuditEntry, AuditOutcome, SettingsHistoryEntry, SettingsValueChange } from '../wire.js';
import { readEnv } from '../core/env.js';
import { FLOW_FILE_RE } from '../flows/repo.js';

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

/** `detail` is names only (e.g. the settings keys that changed); `changes` holds values of allowlisted non-secret keys only. */
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

/**
 * `app.json` keys whose old and new values a `settings-change` line may carry. An explicit allowlist: every other key
 * logs its name only. Left out on purpose: `verifyCmd` and `runCommand` (a shell command can inline a token),
 * `chatBaseUrl` and `customProviders` (a URL can carry a key in its userinfo or query), and any key added later.
 */
export const SETTINGS_VALUE_KEYS: ReadonlySet<string> = new Set([
  'taskSource', 'source', 'runLocation', 'label', 'team', 'color', 'provider', 'reviewProvider', 'flow',
  'concurrency', 'budgetUsd', 'usageCapPct', 'chatModel', 'baseBranch', 'baseBranches',
]);
const MAX_VALUE = 80;

/** A value as the history shows it: a bounded single line; null for a shape it does not show (an object). */
function shownValue(v: unknown): string | null {
  const text = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : null;
  if (text === null) return null;
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE)}…` : flat;
}

/** Old → new values of the allowlisted top-level keys that differ between two `app.json` objects. */
export function settingsValueChanges(prev: Record<string, unknown>, next: Record<string, unknown>): SettingsValueChange[] {
  const out: SettingsValueChange[] = [];
  for (const key of [...SETTINGS_VALUE_KEYS].sort()) {
    if (JSON.stringify(prev[key]) === JSON.stringify(next[key])) continue;
    const from = prev[key] === undefined ? undefined : shownValue(prev[key]);
    const to = next[key] === undefined ? undefined : shownValue(next[key]);
    if (from === null || to === null) continue;
    out.push({ key, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
  }
  return out;
}

/** Re-checked where lines are written and read: only allowlisted keys and bounded string values pass. */
function allowedChanges(changes: readonly SettingsValueChange[] | undefined): SettingsValueChange[] {
  return (changes ?? []).flatMap((c) => {
    if (typeof c !== 'object' || c === null || !SETTINGS_VALUE_KEYS.has(c.key)) return [];
    const from = typeof c.from === 'string' ? shownValue(c.from) : undefined;
    const to = typeof c.to === 'string' ? shownValue(c.to) : undefined;
    return [{ key: c.key, ...(from != null ? { from } : {}), ...(to != null ? { to } : {}) }];
  });
}
/**
 * Successful actions that carry no decision and repeat on every reconnect or screen visit: the events-stream sign-in
 * and the filesystem watch of a project. One `ok` line per actor, action and target per window; refusals, failures
 * and every other action are always written.
 */
const ROUTINE_ACTIONS: ReadonlySet<AuditAction> = new Set(['sign-in', 'project-watch', 'project-unwatch']);
export const ROUTINE_AUDIT_WINDOW_MS = 10 * 60_000;

const SETTINGS_HISTORY_DEFAULT = 20;
const SETTINGS_HISTORY_MAX = 100;

export class AuditLog {
  private readonly adapter: AuditAdapter;
  /** When each routine `ok` line was last written (epoch ms), by actor, action and target. */
  private readonly routineSeen = new Map<string, number>();

  constructor(
    configDir: string,
    opts: { maxBytes?: number; retentionDays?: number } = {},
  ) {
    this.adapter = localAdapter({
      file: hubAuditFile(configDir),
      maxBytes: opts.maxBytes ?? AUDIT_MAX_BYTES,
      ...(opts.retentionDays !== undefined ? { retentionDays: opts.retentionDays } : {}),
    });
  }

  /**
   * Append one chained, fsynced line. Fails closed: an unwritable log rejects with AuditWriteError, so
   * the caller reports the failure instead of carrying on unrecorded.
   */
  record(input: AuditRecordInput & { actor?: AuditActor; subject?: AuditSubject }, now = Date.now()): Promise<void> {
    if (input.outcome === 'ok' && ROUTINE_ACTIONS.has(input.action)) {
      const key = JSON.stringify([input.actor?.id ?? input.login, input.action, input.target ?? '']);
      const last = this.routineSeen.get(key);
      if (last !== undefined && now - last < ROUTINE_AUDIT_WINDOW_MS) return Promise.resolve();
      this.routineSeen.set(key, now);
    }
    const entry: AuditEntry = {
      time: new Date().toISOString(),
      login: input.login,
      action: input.action,
      ...(input.target !== undefined ? { target: cleanTarget(input.target) } : {}),
      outcome: input.outcome,
      ...(input.detail !== undefined ? { detail: input.detail.filter((d) => NAME.test(d)).sort() } : {}),
      ...(input.action === 'settings-change' && allowedChanges(input.changes).length > 0 ? { changes: allowedChanges(input.changes) } : {}),
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

  /**
   * `settings-change` lines for one repository, newest first, from the live file only (rotated files are
   * not scanned). `repoPaths` are the raw argument and its realpath: the audit target is the raw argument.
   * Kept: the app.json save (target is the repo, with a non-empty key list) and `<repo>:<file>.hcl` flow
   * writes. Skills, lessons and local-worker lines also log `settings-change` and are left out. Only
   * {@link SettingsHistoryEntry} fields leave: never the actor, subject or chain hashes.
   */
  async readSettingsHistory(repoPaths: readonly string[], limit?: number): Promise<SettingsHistoryEntry[]> {
    const max = Math.min(Math.max(1, Math.floor(limit ?? SETTINGS_HISTORY_DEFAULT)), SETTINGS_HISTORY_MAX);
    const repos = new Set(repoPaths.flatMap((p) => [p, cleanTarget(p)]));
    const out: SettingsHistoryEntry[] = [];
    for await (const f of this.adapter.newestFirst()) {
      const records = parseJsonlLines(f.text) as unknown as AuditEntry[];
      for (let i = records.length - 1; i >= 0 && out.length < max; i--) {
        const r = records[i]!;
        const target = r.target;
        if (r.action !== 'settings-change' || target === undefined) continue;
        const detail = r.detail ?? [];
        const isConfig = repos.has(target) && detail.length > 0;
        // The remainder must be a strict flow file name: a repo whose path is `<this repo>:x` cannot pass as a file of this one.
        const isFlow = [...repos].some((p) => target.startsWith(`${p}:`) && FLOW_FILE_RE.test(target.slice(p.length + 1)));
        const changes = isConfig ? allowedChanges(r.changes) : [];
        if (isConfig || isFlow) out.push({ time: r.time, login: r.login, outcome: r.outcome, detail: isFlow ? [] : detail, target, ...(changes.length > 0 ? { changes } : {}) });
      }
      break; // live file only
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
