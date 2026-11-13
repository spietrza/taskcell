// Hub commands: task drafts and their assets. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import * as drafts from '../drafts.js';
import { defineCommands, requireString } from '../command-kit.js';

export interface DraftsCommands {
  list_drafts: { args: { repoPath: string }; result: string[] };
  read_draft: { args: { repoPath: string; id: string }; result: string };
  write_draft: { args: { repoPath: string; id: string; content: string }; result: void };
  delete_draft: { args: { repoPath: string; id: string }; result: void };
  write_draft_asset: { args: { repoPath: string; id: string; name: string; bytes: number[] }; result: string };
  clear_draft_assets: { args: { repoPath: string; id: string }; result: void };
}

export const commands = defineCommands<DraftsCommands>({
  list_drafts: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return drafts.list(real);
  },
  read_draft: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return drafts.read(real, requireString(args, 'id'));
  },
  write_draft: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    await drafts.write(real, requireString(args, 'id'), requireString(args, 'content'));
    return null;
  },
  delete_draft: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    await drafts.del(real, requireString(args, 'id'));
    return null;
  },
  write_draft_asset: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const name = requireString(args, 'name');
    const bytesRaw = args.bytes;
    if (!Array.isArray(bytesRaw)) throw new BadRequestError('bytes is required and must be an array of numbers');
    return drafts.writeAsset(real, id, name, Uint8Array.from(bytesRaw as number[]));
  },
  clear_draft_assets: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    await drafts.clearAssets(real, requireString(args, 'id'));
    return null;
  },
});
