// Hub commands: the audit log. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { ForbiddenError } from '../credentials.js';
import type { AuditEntry } from '../../wire.js';
import { defineCommands, optionalString, optionalNumber, actorOf } from '../command-kit.js';

export interface AuditCommands {
  /** HUB_ONLY, admin-only (403 otherwise): the audit log newest first, optionally for one login. */
  read_audit: { args: { login?: string; limit?: number }; result: AuditEntry[] };
}

export const commands = defineCommands<AuditCommands>({
  read_audit: async ({ ctx, args }) => {
    if (!actorOf(ctx).admin) throw new ForbiddenError('the audit log is admin-only');
    const login = optionalString(args, 'login');
    const limit = optionalNumber(args, 'limit');
    return ctx.audit === undefined ? [] : ctx.audit.read({ ...(login ? { login } : {}), ...(limit !== undefined ? { limit } : {}) });
  },
});
