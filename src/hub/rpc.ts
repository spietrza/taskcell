// POST /rpc/:cmd dispatch. The commands themselves live one module per feature in src/hub/commands/
// (contract, validation, handler, audit spec); this file builds the per-request guards, looks the
// command up in the generated index and writes the audit line. Every handler that takes a repoPath
// resolves it through ProjectAllowlist.assertAllowed first (src/hub/allowlist.ts) — see docs/hub.md.
import type { SidecarDeps } from '../sidecar/sidecar.js';
import { ProjectAllowlist, type BindOptions } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import type { SpawnRegistry } from './spawn.js';
import type { RunSession } from './run-session.js';
import type { CompleteRegistry } from './complete.js';
import * as teams from './teams.js';
import { AuditWriteError } from '../core/audit.js';
import { auditActorOf, reportAuditFailure, type AuditLog, type Actor, type AuditOutcome } from './audit.js';
import { ForbiddenError, type CredentialService, type CredentialStore, type HubUser } from './credentials.js';
import { UnknownCommandError, actorOf, classifyError, obj, optionalString, outcomeOf, type CommandCall } from './command-kit.js';
import { HUB_AUDITED, HUB_COMMANDS } from './commands/index.js';

export { FLEET_DISABLED_MESSAGE } from './commands/fleet.js';
export { UnknownCommandError, classifyError };

/** Re-exported from credentials.ts so RPC callers need not import it from there. */
export { ForbiddenError };

export interface RpcContext {
  allowlist: ProjectAllowlist;
  watchRegistry: WatchRegistry;
  runSession: RunSession;
  /** Present only when fleet is enabled (loopback bind + TASKCELL_HUB_ALLOW_FLEET=1). */
  spawnRegistry?: SpawnRegistry;
  completeRegistry: CompleteRegistry;
  deps: SidecarDeps;
  configDir: string;
  browseRoot: string;
  bind: BindOptions;
  /** Hosts `clone_project` accepts beyond `DEFAULT_CLONE_HOSTS` (a self-hosted GitHub/GitLab). */
  cloneHosts?: readonly string[];
  /** Instance provider credentials (write-only; see credentials.ts). */
  credentials: CredentialStore;
  /** Publish a server->client event (wired to the hub's EventBus). */
  publish: (name: string, payload: unknown) => void;
  /** Per-user credential switch + encrypted store; absent, runs use the host environment as before. */
  userCredentials?: CredentialService;
  /** The signed-in user behind THIS request (set per request by the server); undefined when none. */
  user?: HubUser;
  /** Audit log; absent in tests that do not exercise it. */
  audit?: AuditLog;
  /** Who is calling; the shared `token` identity when absent. */
  actor?: Actor;
}

/**
 * Dispatch one RPC command. Returns the raw result (never `undefined` — void commands resolve
 * `null`) or throws: `BadRequestError`/`FlowError`/`TaskcellError` classify `bad-request`,
 * `UnknownCommandError` (a BadRequestError subtype) is additionally mapped to 404 by the caller,
 * anything else classifies `internal`. See `classifyError`.
 */
async function dispatchInner(ctx: RpcContext, cmd: string, rawArgs: unknown, caller: teams.Caller): Promise<unknown> {
  // A lookup, never a prototype walk: `constructor` is not a command.
  if (!Object.hasOwn(HUB_COMMANDS, cmd)) throw new UnknownCommandError(`unknown command: ${cmd}`);
  const handler = HUB_COMMANDS[cmd as keyof typeof HUB_COMMANDS];
  const args = obj(rawArgs);

  // The allowlist, then the caller's teams: a repository outside every team of the caller is refused
  // for every command that reads or writes one (runs, files, drafts, flows, ...). The team roots are
  // read once per request.
  let rootsOnce: Promise<string[] | undefined> | undefined;
  const roots = (): Promise<string[] | undefined> => (rootsOnce ??= teams.callerRepoRoots(ctx.configDir, caller));
  const allow = async (repoPath: string): Promise<string> => {
    const real = await ctx.allowlist.assertAllowed(repoPath);
    teams.assertRepoInRoots(await roots(), real);
    return real;
  };
  // The repositories a list is limited to: the selected team's. Undefined (no limit) for the owner
  // without a `teamId` — token-only mode, one team — which keeps the pre-teams behaviour.
  const scope = async (): Promise<string[] | undefined> => {
    const teamId = optionalString(args, 'teamId');
    // Without a `teamId`: the caller's first team, and nothing to list (not an error) for a signed-in
    // user in no team. An explicit foreign `teamId` is refused.
    if (teamId === undefined) return caller.owner ? undefined : ((await teams.callerTeams(ctx.configDir, caller))[0]?.repositories ?? []);
    return (await teams.selectTeam(ctx.configDir, caller, teamId)).repositories;
  };
  // A run known to the session: its repository must be the caller's. Unknown (finished) runs: owner only.
  const assertRunVisible = async (runId: string, unknownOk: boolean): Promise<void> => {
    const known = [ctx.runSession.activeRun(), ...ctx.runSession.queued()].find((r) => r !== null && r.runId === runId);
    if (known != null) teams.assertRepoInRoots(await roots(), known.repoPath);
    else if (!unknownOk) teams.assertOwner(caller);
  };
  const call: CommandCall = { ctx, args, caller, allow, scope, roots, assertRunVisible };
  return handler(call);
}

/**
 * Dispatch one RPC command, writing exactly one audit line for an audited action — success, refusal
 * or failure. A run start/queue logs itself once the run is admitted (the call then stays pending
 * until the run ends), so it is not wrapped here.
 */
export async function dispatchRpc(ctx: RpcContext, cmd: string, rawArgs: unknown, caller: teams.Caller): Promise<unknown> {
  const spec = Object.hasOwn(HUB_AUDITED, cmd) ? HUB_AUDITED[cmd as keyof typeof HUB_AUDITED] : undefined;
  const audit = ctx.audit;
  if (spec === undefined || audit === undefined) return dispatchInner(ctx, cmd, rawArgs, caller);
  const args = obj(rawArgs);
  const actor = actorOf(ctx);
  const target = spec.target(args);
  const detail = await spec.detail?.(ctx, args);
  const okOutcome = spec.okOutcome?.(ctx, args) ?? 'ok';
  const line = (outcome: AuditOutcome): Promise<void> =>
    audit.record({ login: actor.login, actor: auditActorOf(actor), action: spec.action, ...(target !== undefined ? { target } : {}), outcome, ...(detail !== undefined ? { detail } : {}) });
  try {
    const result = await dispatchInner(ctx, cmd, rawArgs, caller);
    // Fail closed: the change is already applied, so the caller is told it went unrecorded rather than that it failed.
    await line(okOutcome).catch((e: unknown) => {
      throw new AuditWriteError(`${cmd} was applied but its audit line could not be written: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    });
    return result;
  } catch (err) {
    // On a failed action keep the original error: an unwritable log is only reported.
    await line(outcomeOf(err)).catch(reportAuditFailure);
    throw err;
  }
}
