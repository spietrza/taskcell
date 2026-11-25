// Hub commands: instance and per-user provider credentials, and the credential policy. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { USER_SCOPE, CREDENTIAL_NAMES, termsWarningFor, CREDENTIAL_POLICIES, ACCOUNT_PROVIDERS, ACCOUNT_TYPES, parseCredentialInput, parseCredentialName, type AccountInput, type AccountProvider, type CredentialService, type HubUser } from '../credentials.js';
import type { AccountType, CredentialAccountView, CredentialPolicy } from '../../wire.js';
import type { RpcContext } from '../rpc.js';
import { defineCommands, type AuditSpec } from '../command-kit.js';

export interface CredentialsCommands {
  /** HUB_ONLY, hub owner or admin only (403 otherwise — one gate for the switch and every instance-credential RPC): the `per-user credentials` switch. */
  get_credential_policy: { args: undefined; result: { policy: CredentialPolicy } };
  set_credential_policy: { args: { policy: CredentialPolicy }; result: void };
  /** HUB_ONLY, hub owner or admin only: instance provider credentials. Write-only — status lists names, never values. */
  instance_credentials_status: { args: undefined; result: { names: string[]; reason?: string; accounts: CredentialAccountView[]; termsWarning?: string } };
  /** HUB_ONLY, hub owner or admin only: the instance's Claude and Codex (ChatGPT plan) accounts (up to 20 per provider, tried in list order; a limited one cools until its reset). `value` is required to create and optional to rename or switch one; it is never returned. A second enabled subscription token needs `acknowledgeTerms` (see docs/hub.md). */
  save_instance_account: { args: { id?: string; provider: 'claude' | 'codex'; name: string; type: AccountType; value?: string; enabled?: boolean; acknowledgeTerms?: boolean }; result: { id: string } };
  delete_instance_account: { args: { id: string }; result: void };
  reorder_instance_accounts: { args: { ids: string[]; provider?: 'claude' | 'codex' }; result: void };
  save_instance_credential: { args: { name: string; value: string }; result: void };
  delete_instance_credential: { args: { name: string }; result: void };
  /** HUB_ONLY: the signed-in user's OWN credentials (no RPC takes a user id). Write-only. */
  user_credentials_status: { args: undefined; result: { enabled: boolean; admin: boolean; names: string[]; accounts: CredentialAccountView[]; termsWarning?: string } };
  /** HUB_ONLY: the signed-in user's OWN Claude and Codex accounts. A second enabled subscription token needs `acknowledgeTerms`, as on the instance (see docs/hub.md). */
  save_user_account: { args: { id?: string; provider: 'claude' | 'codex'; name: string; type: AccountType; value?: string; enabled?: boolean; acknowledgeTerms?: boolean }; result: { id: string } };
  delete_user_account: { args: { id: string }; result: void };
  reorder_user_accounts: { args: { ids: string[]; provider?: 'claude' | 'codex' }; result: void };
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

/** Validate an account save. `value` is trimmed and non-blank when present, and required when `id` is absent. Unknown keys are ignored. */
export function parseAccountInput(args: Record<string, unknown>): AccountInput & { provider: AccountProvider; name: string; type: AccountType } {
  const { id, provider, name, type, value, enabled, acknowledgeTerms } = args;
  if (id !== undefined && typeof id !== 'string') throw new BadRequestError('id must be a string');
  if (!(ACCOUNT_PROVIDERS as readonly unknown[]).includes(provider)) throw new BadRequestError(`provider must be one of: ${ACCOUNT_PROVIDERS.join(', ')}`);
  if (typeof name !== 'string' || name.trim() === '') throw new BadRequestError('name is required');
  if (!(ACCOUNT_TYPES as readonly unknown[]).includes(type)) throw new BadRequestError(`type must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) throw new BadRequestError('value must be a non-blank string');
  if (value === undefined && id === undefined) throw new BadRequestError('value is required for a new credential');
  if (provider === 'codex' && type !== 'subscription') throw new BadRequestError('codex credentials must be of type subscription (a ChatGPT-plan auth.json)');
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean');
  return {
    ...(id !== undefined ? { id } : {}),
    provider: provider as AccountProvider,
    name: name.trim(),
    type: type as AccountType,
    ...(value !== undefined ? { value: (value as string).trim() } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(acknowledgeTerms === true ? { acknowledgeTerms: true } : {}),
  };
}

function requireIds(args: Record<string, unknown>): string[] {
  const { ids } = args;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new BadRequestError('ids must be a list of credential ids');
  return ids as string[];
}

/** The optional provider a reorder is scoped to (absent: the whole list). */
function optionalProvider(args: Record<string, unknown>): AccountProvider | undefined {
  const { provider } = args;
  if (provider === undefined) return undefined;
  if (!(ACCOUNT_PROVIDERS as readonly unknown[]).includes(provider)) throw new BadRequestError(`provider must be one of: ${ACCOUNT_PROVIDERS.join(', ')}`);
  return provider as AccountProvider;
}

function requireId(args: Record<string, unknown>): string {
  if (typeof args.id !== 'string' || args.id === '') throw new BadRequestError('id is required');
  return args.id;
}

/** Own-scope user RPCs are refused when per-user credentials are off. */
async function userScope(ctx: RpcContext): Promise<{ svc: CredentialService; scope: ReturnType<typeof USER_SCOPE> }> {
  const svc = requireCredentials(ctx);
  const user = requireUser(ctx);
  if ((await svc.policy()) === 'off') throw new BadRequestError('per-user credentials are turned off on this hub');
  return { svc, scope: USER_SCOPE(user) };
}

function requirePolicy(args: Record<string, unknown>): CredentialPolicy {
  const v = args.policy;
  if (!(CREDENTIAL_POLICIES as readonly unknown[]).includes(v)) throw new BadRequestError(`policy must be one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  return v as CredentialPolicy;
}

/** A credential write names the variable only — the value never reaches the log. */
const CREDENTIAL_AUDIT: AuditSpec = {
  action: 'settings-change',
  target: (args) => typeof args.name === 'string' && (CREDENTIAL_NAMES as readonly string[]).includes(args.name)
    ? `credential:${args.name}`
    : 'credential',
};
/** An account write names its id only (or `new`): never the name or the value. */
const ACCOUNT_AUDIT: AuditSpec = {
  action: 'settings-change',
  target: (args) => `credential-account:${typeof args.id === 'string' && /^[\w-]{1,64}$/.test(args.id) ? args.id : 'new'}`,
};
const ACCOUNT_ORDER_AUDIT: AuditSpec = { action: 'settings-change', target: () => 'credential-account:order' };
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
  save_instance_account: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    return { id: await svc.store.putAccount('instance', parseAccountInput(args)) };
  },
  delete_instance_account: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    await svc.store.removeAccount('instance', requireId(args));
    return null;
  },
  reorder_instance_accounts: async ({ ctx, args, caller }) => {
    const svc = requireCredentials(ctx);
    svc.assertManager(ctx.user, caller.owner);
    await svc.store.reorderAccounts('instance', requireIds(args), optionalProvider(args));
    return null;
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
    const accounts = ctx.user !== undefined && enabled ? await svc.accountViews(USER_SCOPE(ctx.user)) : [];
    const termsWarning = ctx.user !== undefined && enabled ? termsWarningFor(await svc.store.accounts(USER_SCOPE(ctx.user))) : undefined;
    return { enabled, admin: (caller.owner || svc.isAdmin(ctx.user)), names, accounts, ...(termsWarning !== undefined ? { termsWarning } : {}) };
  },
  save_user_account: async ({ ctx, args }) => {
    const { svc, scope } = await userScope(ctx);
    return { id: await svc.store.putAccount(scope, parseAccountInput(args)) };
  },
  delete_user_account: async ({ ctx, args }) => {
    const { svc, scope } = await userScope(ctx);
    await svc.store.removeAccount(scope, requireId(args));
    return null;
  },
  reorder_user_accounts: async ({ ctx, args }) => {
    const { svc, scope } = await userScope(ctx);
    await svc.store.reorderAccounts(scope, requireIds(args), optionalProvider(args));
    return null;
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
  // Hub owner or admin (assertManager, 403). The remote gate binds the hub-token holder only, as documented in docs/hub.md:
  // a signed-in admin manages credentials on a hosted hub, where TASKCELL_HUB_ALLOW_ADD would otherwise have to be set for them.
  get_credential_policy: { write: false, gatedBy: 'assertManager (owner or hub admin)' },
  set_credential_policy: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  instance_credentials_status: { write: false, gatedBy: 'assertManager (owner or hub admin)' },
  save_instance_account: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  delete_instance_account: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  reorder_instance_accounts: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  save_user_account: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
  delete_user_account: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
  reorder_user_accounts: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
  save_instance_credential: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  delete_instance_credential: { write: true, remote: 'owner-only', gatedBy: 'assertManager (owner or hub admin)' },
  user_credentials_status: { write: false },
  save_user_credential: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
  delete_user_credential: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)', unaudited: 'a user\'s own credential, never another\'s; values are never logged' },
}, {
  set_credential_policy: CREDENTIAL_POLICY_AUDIT,
  save_instance_account: ACCOUNT_AUDIT,
  delete_instance_account: ACCOUNT_AUDIT,
  reorder_instance_accounts: ACCOUNT_ORDER_AUDIT,
  save_instance_credential: CREDENTIAL_AUDIT,
  delete_instance_credential: CREDENTIAL_AUDIT,
});
