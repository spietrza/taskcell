// Hub commands: the audit log. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { ForbiddenError } from '../credentials.js';
import type { ActivityEvent, AuditEntry, SettingsHistoryEntry } from '../../wire.js';
import { ACTIVITY_LIMIT, activityFeed } from '../activity.js';
import { defaultRunsRoot, listRunSummaries } from '../runs.js';
import * as projects from '../projects.js';
import { defineCommands, optionalString, optionalNumber, actorOf, requireString } from '../command-kit.js';

export interface AuditCommands {
  /** HUB_ONLY, admin-only (403 otherwise): the audit log newest first, optionally for one login. */
  read_audit: { args: { login?: string; limit?: number }; result: AuditEntry[] };
  /** HUB_ONLY, read-only, same gate as read_app_config: the repository's settings saves (app.json key names, flow files), newest first. */
  read_settings_history: { args: { repoPath: string; limit?: number }; result: SettingsHistoryEntry[] };
  /** HUB_ONLY, read-only: Home's activity feed across the team's repositories, newest first, at most 30 (`limit` lowers it).
   *  Run records and the audit log only (settings saves as key names): no tracker read. */
  list_activity: { args: { teamId?: string; limit?: number } | undefined; result: ActivityEvent[] };
}

/** Audit lines scanned for the feed: the newest ones only, so the read stays cheap on a long log. */
const ACTIVITY_AUDIT_SCAN = 500;

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
  list_activity: async ({ ctx, args, allow, scope }) => {
    const only = await scope();
    const limit = Math.min(Math.max(1, Math.floor(optionalNumber(args, 'limit') ?? ACTIVITY_LIMIT)), ACTIVITY_LIMIT);
    const paths = await projects.loadScopedPaths(ctx.configDir, only);
    const [{ items: runs }, audit] = await Promise.all([
      projects.listAcrossProjects(ctx.configDir, allow, (real) => listRunSummaries(defaultRunsRoot(real)), only),
      ctx.audit === undefined ? [] : ctx.audit.read({ limit: ACTIVITY_AUDIT_SCAN }),
    ]);
    return activityFeed(runs, audit, new Map(paths.map((p) => [p, projects.repoDisplayName(p)])), limit);
  },
}, {
  read_settings_history: { write: false, repo: 'repoPath' },
  list_activity: { write: false },
  read_audit: { write: false, gatedBy: 'admin actor only (403), checked in the handler' },
});
