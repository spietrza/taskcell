// What a hub command module (src/hub/commands/<feature>.ts) is built from: the handler/audit types,
// `defineCommands`, and the argument-validation helpers every module shares. Imports nothing from
// rpc.ts at runtime, so rpc.ts can import the modules without a cycle.
import { BadRequestError, classifyCoreError } from '../sidecar/sidecar.js';
import { detectRepoSlug } from '../runners/github.js';
import type { ErrorKind } from '../hub-wire.js';
import { TOKEN_ACTOR, type Actor, type AuditAction, type AuditOutcome } from './audit.js';
import type { RpcContext } from './rpc.js';
import type { Caller } from './teams.js';

export type Args = Record<string, unknown>;

/** What a handler receives: the request context plus the per-request guards `dispatchRpc` builds. */
export interface CommandCall {
  ctx: RpcContext;
  /** The raw, unvalidated arguments (`{}` when none were sent). */
  args: Args;
  caller: Caller;
  /** Allowlist + caller's teams: resolves a repoPath the caller may touch, or throws. */
  allow: (repoPath: string) => Promise<string>;
  /** The repositories a list is limited to (the selected team's); undefined for no limit. */
  scope: () => Promise<string[] | undefined>;
  /** The caller's team repository roots (read once per request). */
  roots: () => Promise<string[] | undefined>;
  /** A run known to the session must be in the caller's repositories; unknown runs: owner only unless `unknownOk`. */
  assertRunVisible: (runId: string, unknownOk: boolean) => Promise<void>;
}

/** Void commands resolve `null`; every other result is the command's wire `result`. */
export type CommandHandler = (call: CommandCall) => Promise<unknown>;

export interface AuditSpec {
  action: AuditAction;
  target: (a: Args) => string | undefined;
  /** Names only — computed before the command runs. */
  detail?: (ctx: RpcContext, a: Args) => Promise<string[]>;
  /** Outcome of a call that did not throw (default `ok`). */
  okOutcome?: (ctx: RpcContext, a: Args) => AuditOutcome;
}

export interface CommandModule<C> {
  handlers: { readonly [K in keyof C]: CommandHandler };
  /** Audited commands of this module: the action each logs, and the target/detail it names (never a value). */
  audit: { readonly [K in keyof C]?: AuditSpec };
}

/**
 * Declare a module's commands. `C` is the module's wire interface (`{ name: { args; result } }`): the
 * handler map must have exactly its keys, so the contract and the implementation cannot drift apart.
 */
export function defineCommands<C>(handlers: { [K in keyof C]: CommandHandler }, audit: { [K in keyof C]?: AuditSpec } = {}): CommandModule<C> {
  return { handlers, audit };
}

export class UnknownCommandError extends BadRequestError {}

export function obj(rawArgs: unknown): Args {
  return (rawArgs ?? {}) as Args;
}

export function requireString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequestError(`${key} is required and must be a non-blank string`);
  return v;
}

export function optionalString(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function optionalNumber(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

export function requireMatch(args: Args, key: string, shape: RegExp, label: string): string {
  const v = requireString(args, key);
  if (!shape.test(v)) throw new BadRequestError(`${key} must be a valid ${label}`);
  return v;
}

export function requireOneOf(args: Args, key: string, allowed: readonly string[]): string {
  const v = requireString(args, key);
  if (!allowed.includes(v)) throw new BadRequestError(`${key} must be one of ${allowed.join(', ')}`);
  return v;
}

/** Who is calling: the request's actor, or the shared `token` identity. */
export function actorOf(ctx: RpcContext): Actor {
  return ctx.actor ?? TOKEN_ACTOR;
}

/** The GitHub slug of an allowlisted repo's origin, or undefined when it has no GitHub remote. */
export async function githubSlug(repoPath: string): Promise<string | undefined> {
  try {
    return await detectRepoSlug(repoPath);
  } catch {
    return undefined;
  }
}

export const repoTarget = (a: Args): string | undefined => optionalString(a, 'repoPath');
/** `<repoPath>:<a[key]>` — a file or item within a repository. */
export const repoItemTarget = (key: string): AuditSpec['target'] => (a) => `${repoTarget(a) ?? ''}:${optionalString(a, key) ?? ''}`;

/** Top-level keys of `next` whose value differs from `prev` — names, never values. */
export function changedKeys(prev: Args, next: Args): string[] {
  return [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

/** Classify a thrown value for the wire, on top of `classifyCoreError`'s message/kind (the one
 * place that pairing lives — see `src/sidecar/sidecar.ts`): adds the 404 hint the HTTP layer wants
 * for an unknown command. */
export function classifyError(err: unknown): { message: string; kind: ErrorKind; notFound: boolean } {
  const notFound = err instanceof UnknownCommandError;
  const { message, kind } = classifyCoreError(err);
  return { message, kind, notFound };
}

/** A caller-correctable error is `refused` (the HTTP 400 class); anything else, and a git clone that ran and failed, is `failed`. */
export function outcomeOf(err: unknown): AuditOutcome {
  const { kind, message } = classifyError(err);
  return kind === 'bad-request' && !message.startsWith('git clone failed') ? 'refused' : 'failed';
}
