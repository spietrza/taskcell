// Hub commands: the audit log. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { ForbiddenError } from '../credentials.js';
import type { AuditEntry, SettingsHistoryEntry } from '../../wire.js';
import { defineCommands, optionalString, optionalNumber, actorOf, requireString } from '../command-kit.js';

export interface AuditCommands {
  /** HUB_ONLY, admin-only (403 otherwise): the audit log newest first, optionally for one login. */
  read_audit: { args: { login?: string; limit?: number }; result: AuditEntry[] };
  /** HUB_ONLY, read-only, same gate as read_app_config: the repository's settings saves (app.json key names, flow files), newest first. */
  read_settings_history: { args: { repoPath: string; limit?: number }; result: SettingsHistoryEntry[] };
}

export const commands = defineCommands<AuditCommands>({
  read_audit: async ({ ctx, args }) => {
    if (!actorOf(ctx).admin) throw new ForbiddenError('the audit log is admin-only');
    const login = optionalString(args, 'login');
    const limit = optionalNumber(args, 'limit');
    return ctx.audit === undefined ? [] : ctx.audit.read({ ...(login ? { login } : {}), ...(limit !== undefined ? { limit } : {}) });
  },
  read_settings_history: async ({ ctx, args, allow }) => {
    const raw = requireString(args, 'repoPath');
    const real = await allow(raw);
    const limit = optionalNumber(args, 'limit');
    return ctx.audit === undefined ? [] : ctx.audit.readSettingsHistory([raw, real], limit);
  },
}, {
  read_settings_history: { write: false, repo: 'repoPath' },
  read_audit: { write: false, gatedBy: 'admin actor only (403), checked in the handler' },
});
