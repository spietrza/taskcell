// Hub commands: starting, queueing and cancelling runs. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { invokeCoreMethod, validateCoreMethod, type CreateRunParams as CoreCreateRunParams } from '../../sidecar/sidecar.js';
import * as teams from '../teams.js';
import { auditActorOf, reportAuditFailure, type AuditAction, type AuditOutcome } from '../audit.js';
import type { Capabilities, CreateRunParams, CreateRunResult } from '../../wire.js';
import { defineCommands, requireString, optionalString, actorOf, outcomeOf } from '../command-kit.js';

export interface RunSessionCommands {
  api_capabilities: { args: undefined; result: Capabilities };
  api_create_run: { args: { params: CreateRunParams }; result: CreateRunResult };
  api_active_run: { args: undefined; result: { runId: string; repoPath: string } | null };
  api_run_backlog: { args: { runId: string }; result: unknown[] };
  /** HUB_ONLY: Tauri has no queue to read — it is still strictly single-in-flight, the hub's queue
   * (src/hub/run-session.ts) is what's new here. Position is 1-based, 1 = next to start. */
  api_queue: { args: undefined; result: { runId: string; repoPath: string; position: number }[] };
  /** `runId` cancels exactly that run (active or queued). The hub REQUIRES it (an id-less cancel
   * could hit another project's run); Tauri ignores it and cancels its one active run (no queue). */
  api_cancel: { args: { runId?: string }; result: void };
}

export const commands = defineCommands<RunSessionCommands>({
  api_capabilities: async ({ ctx }) => {
    return invokeCoreMethod(ctx.deps, 'capabilities', undefined);
  },
  api_create_run: async ({ ctx, args, allow }) => {
    const params = (args.params ?? {}) as Record<string, unknown>;
    // startedBy comes from the request's actor, never from the client's params.
    const requester = actorOf(ctx);
    const startedBy = requester.login;
    const actor = auditActorOf(requester);
    // One audit line: at acceptance (the call then stays pending until the run ends), or, when the
    // run is refused before that, one refusal line.
    let accepted = false;
    try {
      const real = await allow(requireString(params, 'repoPath'));
      // The run session (not deps.createRun) owns single-in-flight gating and event
      // buffering/publishing — validate via the table row, then call it directly.
      const validated = validateCoreMethod('createRun', { ...params, repoPath: real }) as CoreCreateRunParams;
      const log = (action: AuditAction, runId: string, outcome: AuditOutcome): void => {
        accepted = true;
        // The run is already admitted (this call stays pending until it ends): an unwritable audit log is reported, not thrown.
        void ctx.audit?.record({ login: startedBy, actor, action, target: runId, outcome }).catch(reportAuditFailure);
      };
      // The credential is resolved from the server-side switch and the caller's identity, BEFORE the
      // run is queued or claims the slot: a `user only` run with no saved credential is refused here.
      const credential = ctx.userCredentials !== undefined ? await ctx.userCredentials.resolveForRun(ctx.user, validated.provider) : undefined;
      return await ctx.runSession.createRun({ ...validated, startedBy }, {
        onStarted: (id) => log('run-start', id, 'ok'),
        onQueued: (id) => log('run-queue', id, 'ok'),
        onRefused: (id) => log('run-start', id, 'refused'),
      }, credential);
    } catch (err) {
      if (!accepted) {
        const repoPath = optionalString(params, 'repoPath');
        await ctx.audit?.record({ login: startedBy, actor, action: 'run-start', ...(repoPath !== undefined ? { target: repoPath, subject: { repo: repoPath } } : {}), outcome: outcomeOf(err) }).catch(reportAuditFailure);
      }
      throw err;
    }
  },
  api_active_run: async ({ ctx, roots }) => {
    const active = ctx.runSession.activeRun();
    return active !== null && teams.repoInRoots(await roots(), active.repoPath) ? active : null;
  },
  api_run_backlog: async ({ ctx, args, assertRunVisible }) => {
    const runId = requireString(args, 'runId');
    await assertRunVisible(runId, false);
    return ctx.runSession.backlog(runId);
  },
  api_queue: async ({ ctx, roots }) => {
    const visible = await roots();
    return ctx.runSession.queued().filter((q) => teams.repoInRoots(visible, q.repoPath));
  },
  api_cancel: async ({ ctx, args, assertRunVisible }) => {
    // Required on the hub: with a queue, an id-less "cancel the active run" can hit another
    // project's run, or the successor promoted after the clicked run ended.
    const runId = requireString(args, 'runId');
    await assertRunVisible(runId, true);
    ctx.runSession.cancel(runId);
    return null;
  },
}, {
  api_cancel: {
    action: 'run-cancel',
    target: (a) => optionalString(a, 'runId'),
    // Cancelling an id that is neither active nor queued does nothing: logged as refused, not ok.
    okOutcome: (ctx, a) => {
      const id = optionalString(a, 'runId');
      return ctx.runSession.activeRun()?.runId === id || ctx.runSession.queued().some((q) => q.runId === id) ? 'ok' : 'refused';
    },
  },
});
