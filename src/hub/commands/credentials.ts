// Hub commands: instance and per-user provider credentials, and the credential policy. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import * as teams from '../teams.js';
import { USER_SCOPE, CREDENTIAL_POLICIES, CREDENTIAL_PROVIDERS, parseCredentialInput, parseCredentialName, type CredentialService, type HubUser } from '../credentials.js';
import type { CredentialPolicy, CredentialProvider, CredentialsSummary } from '../../wire.js';
import type { RpcContext } from '../rpc.js';
import { defineCommands, requireString, optionalString, requireOneOf, type AuditSpec } from '../command-kit.js';

export interface CredentialsCommands {
  /** HUB_ONLY: instance provider credentials (src/hub/credentials.ts) — write-only; reads return set + last four. */
  get_credentials: { args: undefined; result: CredentialsSummary };
  set_credential: { args: { provider: CredentialProvider; value: string }; result: CredentialsSummary };
  delete_credential: { args: { provider: CredentialProvider }; result: CredentialsSummary };
  /** HUB_ONLY, admin only (403 otherwise): the `per-user credentials` switch. */
  get_credential_policy: { args: undefined; result: { policy: CredentialPolicy } };
  set_credential_policy: { args: { policy: CredentialPolicy }; result: void };
  /** HUB_ONLY, admin only: instance provider credentials. Write-only — status lists names, never values. */
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

function requireCredentialProvider(args: Record<string, unknown>): CredentialProvider {
  return requireOneOf(args, 'provider', CREDENTIAL_PROVIDERS) as CredentialProvider;
}

/** A credential write names the provider only — the value never reaches the log. */
const CREDENTIAL_AUDIT: AuditSpec = { action: 'settings-change', target: (a) => `credential:${optionalString(a, 'provider') ?? ''}` };

export const commands = defineCommands<CredentialsCommands>({
  get_credentials: async ({ ctx, caller }) => {
    teams.assertOwner(caller);
    return ctx.credentials.summary();
  },
  set_credential: async ({ ctx, args, caller }) => {
    teams.assertOwner(caller);
    assertMutationsAllowed(ctx.bind);
    const provider = requireCredentialProvider(args);
    return ctx.credentials.set(provider, requireString(args, 'value').trim());
  },
  delete_credential: async ({ ctx, args, caller }) => {
    teams.assertOwner(caller);
    assertMutationsAllowed(ctx.bind);
    return ctx.credentials.delete(requireCredentialProvider(args));
  },
  get_credential_policy: async ({ ctx }) => {
    const svc = requireCredentials(ctx);
    svc.assertAdmin(ctx.user);
    return { policy: await svc.policy() };
  },
  set_credential_policy: async ({ ctx, args }) => {
    const svc = requireCredentials(ctx);
    svc.assertAdmin(ctx.user);
    await svc.setPolicy(requirePolicy(args));
    return null;
  },
  instance_credentials_status: async ({ ctx }) => {
    const svc = requireCredentials(ctx);
    svc.assertAdmin(ctx.user);
    return { names: await svc.store.names('instance') };
  },
  save_instance_credential: async ({ ctx, args }) => {
    const svc = requireCredentials(ctx);
    svc.assertAdmin(ctx.user);
    const { name, value } = parseCredentialInput(args);
    await svc.store.put('instance', name, value);
    return null;
  },
  delete_instance_credential: async ({ ctx, args }) => {
    const svc = requireCredentials(ctx);
    svc.assertAdmin(ctx.user);
    await svc.store.remove('instance', parseCredentialName(args));
    return null;
  },
  user_credentials_status: async ({ ctx }) => {
    const svc = requireCredentials(ctx);
    const enabled = (await svc.policy()) !== 'off';
    const names = ctx.user !== undefined && enabled ? await svc.store.names(USER_SCOPE(ctx.user)) : [];
    return { enabled, admin: svc.isAdmin(ctx.user), names };
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
  set_credential: CREDENTIAL_AUDIT,
  delete_credential: CREDENTIAL_AUDIT,
});
