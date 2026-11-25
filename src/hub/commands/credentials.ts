// Hub commands: instance and per-user provider credentials, and the credential policy. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { USER_SCOPE, CREDENTIAL_NAMES, CREDENTIAL_POLICIES, parseCredentialInput, parseCredentialName, type CredentialService, type HubUser } from '../credentials.js';
import type { CredentialPolicy } from '../../wire.js';
import type { RpcContext } from '../rpc.js';
import { defineCommands, type AuditSpec } from '../command-kit.js';

export interface CredentialsCommands {
  /** HUB_ONLY, hub owner or admin only (403 otherwise — one gate for the switch and every instance-credential RPC): the `per-user credentials` switch. */
  get_credential_policy: { args: undefined; result: { policy: CredentialPolicy } };
  set_credential_policy: { args: { policy: CredentialPolicy }; result: void };
  /** HUB_ONLY, hub owner or admin only: instance provider credentials. Write-only — status lists names, never values. */
  instance_credentials_status: { args: undefined; result: { names: string[]; reason?: string } };
  save_instance_credential: { args: { name: string; value: string }; result: void };
  delete_instance_credential: { args: { name: string }; result: void };
  /** HUB_ONLY: the signed-in user's OWN credentials (no RPC takes a user id). Write-only. */
  user_credentials_status: { args: undefined; result: { enabled: boolean; admin: boolean; names: string[] } };
  save_user_credential: { args: { name: string; value: string }; result: void };
  delete_user_credential: { args: { name: string }; result: void };
  /** HUB_ONLY: the opt-in "when every subscription account is out, continue on a paid API key". `user` is the caller's own switch; `instance` is returned to the hub owner or an admin only. */
  get_paid_fallback: { args: undefined; result: { user: boolean; instance?: boolean } };
  /** HUB_ONLY, hub owner or admin only: the instance's switch (off by default). */
  set_instance_paid_fallback: { args: { enabled: boolean }; result: void };
  /** HUB_ONLY: the signed-in caller's own switch (no user id is taken). */
  set_user_paid_fallback: { args: { enabled: boolean }; result: void };
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

function requireEnabled(args: Record<string, unknown>): boolean {
  if (typeof args.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean');
  return args.enabled;
}

const paidAudit = (scope: 'instance' | 'user'): AuditSpec => ({
  action: 'settings-change',
  target: (args) => (typeof args.enabled === 'boolean' ? `paid-fallback:${scope}:${args.enabled ? 'on' : 'off'}` : 'paid-fallback'),
});

/** A credential write names the variable only — the value never reaches the log. */
const CREDENTIAL_AUDIT: AuditSpec = {
  action: 'settings-change',
  target: (args) => typeof args.name === 'string' && (CREDENTIAL_NAMES as readonly string[]).includes(args.name)
    ? `credential:${args.name}`
    : 'credential',
};
const CREDENTIAL_POLICY_AUDIT: AuditSpec = {
  action: 'settings-change',
  target: (args) => (CREDENTIAL_POLICIES as readonly unknown[]).includes(args.policy)
    ? `credential-policy:${String(args.policy)}`
    : 'credential-policy',
};

export const commands = defineCommands<CredentialsCommands>({
  get_credential_policy: async ({ ctx, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    return { policy: await svc.policy() };
  },
  set_credential_policy: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    await svc.setPolicy(requirePolicy(args));
    return null;
  },
  instance_credentials_status: async ({ ctx, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    return svc.instanceStatus();
  },
  save_instance_credential: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    const { name, value } = parseCredentialInput(args);
    await svc.putInstance(name, value);
    return null;
  },
  delete_instance_credential: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    await svc.removeInstance(parseCredentialName(args));
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
  get_paid_fallback: async ({ ctx, caller }) => {
    const svc = requireCredentials(ctx);
    const user = ctx.user !== undefined ? await svc.paidFallback(ctx.user) : false;
    return { user, ...(caller.owner || svc.isAdmin(ctx.user) ? { instance: await svc.paidFallback('instance') } : {}) };
  },
  set_instance_paid_fallback: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    await svc.setPaidFallback('instance', requireEnabled(args));
    return null;
  },
  set_user_paid_fallback: async ({ ctx, args }) => {
    const svc = requireCredentials(ctx);
    const user = requireUser(ctx);
    if ((await svc.policy()) === 'off') throw new BadRequestError('per-user credentials are turned off on this hub');
    await svc.setPaidFallback(user, requireEnabled(args));
    return null;
  },
}, {
  // Hub owner or admin (assertManager, 403). The remote gate binds the hub-token holder only, as documented in docs/hub.md:
  // a signed-in admin manages credentials on a hosted hub, where TASKCELL_HUB_ALLOW_ADD would otherwise have to be set for them.
  get_credential_policy: { write: false, gatedBy: 'assertManager (owner or hub admin)' },
  set_credential_policy: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  instance_credentials_status: { write: false, gatedBy: 'assertManager (owner or hub admin)' },
  save_instance_credential: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  delete_instance_credential: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  user_credentials_status: { write: false },
  save_user_credential: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
  delete_user_credential: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
  get_paid_fallback: { write: false },
  set_instance_paid_fallback: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  set_user_paid_fallback: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)' },
}, {
  set_instance_paid_fallback: paidAudit('instance'),
  set_user_paid_fallback: paidAudit('user'),
  set_credential_policy: CREDENTIAL_POLICY_AUDIT,
  save_instance_credential: CREDENTIAL_AUDIT,
  delete_instance_credential: CREDENTIAL_AUDIT,
});
