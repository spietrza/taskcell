// Hub commands: the audit log. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { ForbiddenError } from '../credentials.js';
import type { ActivityEvent, AuditEntry, SettingsHistoryEntry } from '../../wire.js';
import { ACTIVITY_LIMIT, activityFeed, fromAudit } from '../activity.js';
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

/** Audit lines scanned for the feed at most: the scan keeps only the caller's events and stops once `limit` are found. */
const ACTIVITY_AUDIT_SCAN = 5000;

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
    const repos = new Map(paths.map((p) => [p, projects.repoDisplayName(p)]));
    const [{ items: runs }, audit] = await Promise.all([
      projects.listAcrossProjects(ctx.configDir, allow, (real) => listRunSummaries(defaultRunsRoot(real)), only),
      // Filtered while scanning: another team's busy repositories cannot push this scope's events out of the window.
      ctx.audit === undefined ? [] : ctx.audit.read({ limit, match: (e) => fromAudit(e, repos) !== undefined, scan: ACTIVITY_AUDIT_SCAN }),
    ]);
    return activityFeed(runs, audit, repos, limit);
  },
}, {
  read_settings_history: { write: false, repo: 'repoPath' },
  list_activity: { write: false },
  read_audit: { write: false, gatedBy: 'admin actor only (403), checked in the handler' },
});
