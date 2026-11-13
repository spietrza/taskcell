// Hub commands: editor completions. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { type CompleteParams } from '../complete.js';
import type { CompleteCallArgs, CompleteResponse } from '../../wire.js';
import { defineCommands, requireString, optionalString } from '../command-kit.js';

export interface CompleteCommands {
  api_complete: { args: { repoPath: string; req: CompleteCallArgs; callId?: string }; result: CompleteResponse };
  api_cancel_complete: { args: { callId: string }; result: void };
}

export const commands = defineCommands<CompleteCommands>({
  api_complete: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const reqRaw = args.req;
    if (typeof reqRaw !== 'object' || reqRaw === null) throw new BadRequestError('req is required');
    const reqObj = reqRaw as Record<string, unknown>;
    if (typeof reqObj.model !== 'string') throw new BadRequestError('req.model is required');
    // ALLOWLIST, not Omit<>: only these fields cross into the child's request, exactly like
    // ipc.ts's CompleteParams (baseUrl/assetRoot are never read from the caller — see complete.ts).
    const params: CompleteParams = {
      messages: reqObj.messages,
      model: reqObj.model,
      ...(reqObj.system !== undefined ? { system: reqObj.system } : {}),
      ...(reqObj.attachments !== undefined ? { attachments: reqObj.attachments } : {}),
    };
    return ctx.completeRegistry.complete(real, params, optionalString(args, 'callId'));
  },
  api_cancel_complete: async ({ ctx, args }) => {
    ctx.completeRegistry.cancel(requireString(args, 'callId'));
    return null;
  },
});
