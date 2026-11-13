// Hub commands: flow documents and providers of a repository. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { invokeCoreMethod } from '../../sidecar/sidecar.js';
import type { FlowDoc, RepoFlowInfo, RepoProviderInfo } from '../../wire.js';
import { defineCommands, requireString, repoItemTarget } from '../command-kit.js';

export interface FlowsCommands {
  api_list_flows: { args: { repoPath: string }; result: { flows: RepoFlowInfo[] } };
  api_list_providers: { args: { repoPath: string }; result: { providers: RepoProviderInfo[] } };
  api_read_flow: { args: { repoPath: string; file: string }; result: { doc: FlowDoc; source: string } };
  api_write_flow: { args: { repoPath: string; file: string; doc: FlowDoc }; result: { source: string } };
  api_delete_flow: { args: { repoPath: string; file: string }; result: void };
}

export const commands = defineCommands<FlowsCommands>({
  api_list_flows: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return invokeCoreMethod(ctx.deps, 'listFlows', { repoPath: real });
  },
  api_list_providers: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return invokeCoreMethod(ctx.deps, 'listProviders', { repoPath: real });
  },
  api_read_flow: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const file = requireString(args, 'file');
    return invokeCoreMethod(ctx.deps, 'readFlow', { repoPath: real, file });
  },
  api_write_flow: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const file = requireString(args, 'file');
    return invokeCoreMethod(ctx.deps, 'writeFlow', { repoPath: real, file, doc: args.doc });
  },
  api_delete_flow: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const file = requireString(args, 'file');
    return invokeCoreMethod(ctx.deps, 'deleteFlow', { repoPath: real, file });
  },
}, {
  api_write_flow: { action: 'settings-change', target: repoItemTarget('file') },
  api_delete_flow: { action: 'settings-change', target: repoItemTarget('file') },
});
