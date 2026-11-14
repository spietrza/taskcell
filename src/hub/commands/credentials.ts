// Hub commands: instance and per-user provider credentials, and the credential policy. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { USER_SCOPE, applyInstanceEnv, CREDENTIAL_POLICIES, parseCredentialInput, parseCredentialName, type CredentialService, type HubUser } from '../credentials.js';
import type { CredentialPolicy } from '../../wire.js';
import type { RpcContext } from '../rpc.js';
import { defineCommands, optionalString, type AuditSpec } from '../command-kit.js';

export interface CredentialsCommands {
  /** HUB_ONLY, hub owner or admin only (403 otherwise — one gate for the switch and every instance-credential RPC): the `per-user credentials` switch. */
  get_credential_policy: { args: undefined; result: { policy: CredentialPolicy } };
  set_credential_policy: { args: { policy: CredentialPolicy }; result: void };
  /** HUB_ONLY, hub owner or admin only: instance provider credentials. Write-only — status lists names, never values. */
  instance_credentials_status: { args: undefined; result: { names: string[] } };
  save_instance_credential: { args: { name: string; value: string }; result: void };
  delete_instance_credential: { args: { name: string }; result: void };
  /** HUB_ONLY: the signed-in user's OWN credentials (no RPC takes a user id). Write-only. */
  user_credentials_status: { args: undefined; result: { enabled: boolean; admin: boolean; names: string[] } };
  save_user_credential: { args: { name: string; value: string }; result: void };
  delete_user_credential: { args: { name: string }; result: void };
}

function requireCredentials(ctx: RpcContext): CredentialService {
  if (ctx.userCredentials === undefined) throw new BadRequestError('per-user credentials are not configured on this hub');
  return ctx.userCredentials;
}

/** Credential RPCs act on the CALLER's own scope only — no RPC takes a user id, so there is no way to
 * name another user's credentials. */
function requireUser(ctx: RpcContext): HubUser {
  if (ctx.user === undefined) throw new BadRequestError('Sign in to the hub first — per-user credentials need to know who you are.');
  return ctx.user;
}

function requirePolicy(args: Record<string, unknown>): CredentialPolicy {
  const v = args.policy;
  if (!(CREDENTIAL_POLICIES as readonly unknown[]).includes(v)) throw new BadRequestError(`policy must be one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  return v as CredentialPolicy;
}

/** A credential write names the variable only — the value never reaches the log. */
const CREDENTIAL_AUDIT: AuditSpec = { action: 'settings-change', target: (a) => `credential:${optionalString(a, 'name') ?? ''}` };

export const commands = defineCommands<CredentialsCommands>({
  get_credential_policy: async ({ ctx, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    return { policy: await svc.policy() };
  },
  set_credential_policy: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    if (caller.owner) assertMutationsAllowed(ctx.bind);
    await svc.setPolicy(requirePolicy(args));
    return null;
  },
  instance_credentials_status: async ({ ctx, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    return { names: await svc.store.names('instance') };
  },
  save_instance_credential: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    if (caller.owner) assertMutationsAllowed(ctx.bind);
    const { name, value } = parseCredentialInput(args);
    await svc.store.put('instance', name, value);
    await applyInstanceEnv(svc.store);
    return null;
  },
  delete_instance_credential: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    if (caller.owner) assertMutationsAllowed(ctx.bind);
    await svc.store.remove('instance', parseCredentialName(args));
    await applyInstanceEnv(svc.store);
    return null;
  },
  user_credentials_status: async ({ ctx, caller }) => {
    const svc = requireCredentials(ctx);
    const enabled = (await svc.policy()) !== 'off';
    const names = ctx.user !== undefined && enabled ? await svc.store.names(USER_SCOPE(ctx.user)) : [];
    return { enabled, admin: (caller.owner || svc.isAdmin(ctx.user)), names };
  },
  save_user_credential: async ({ ctx, args }) => {
    const svc = requireCredentials(ctx);
    const user = requireUser(ctx);
    if ((await svc.policy()) === 'off') throw new BadRequestError('per-user credentials are turned off on this hub');
    const { name, value } = parseCredentialInput(args);
    await svc.store.put(USER_SCOPE(user), name, value);
    return null;
  },
  delete_user_credential: async ({ ctx, args }) => {
    const svc = requireCredentials(ctx);
    await svc.store.remove(USER_SCOPE(requireUser(ctx)), parseCredentialName(args));
    return null;
  },
}, {
  save_instance_credential: CREDENTIAL_AUDIT,
  delete_instance_credential: CREDENTIAL_AUDIT,
});
