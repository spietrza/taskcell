// Hub commands: reading a repository's files. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { execa } from 'execa';
import { invokeCoreMethod } from '../../sidecar/sidecar.js';
import { defineCommands, requireString } from '../command-kit.js';

export interface RepoFilesCommands {
  api_list_repo_files: { args: { repoPath: string }; result: { files: string[]; capped: boolean } };
  api_read_repo_file: { args: { repoPath: string; path: string }; result: { path: string; content: string; truncated: boolean } };
  api_repo_ok: { args: { repoPath: string }; result: boolean };
}

async function repoOk(repoPath: string): Promise<boolean> {
  try {
    const res = await execa('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

export const commands = defineCommands<RepoFilesCommands>({
  api_list_repo_files: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return invokeCoreMethod(ctx.deps, 'listRepoFiles', { repoPath: real });
  },
  api_read_repo_file: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const path = requireString(args, 'path');
    return invokeCoreMethod(ctx.deps, 'readRepoFile', { repoPath: real, path });
  },
  api_repo_ok: async ({ args, allow }) => {
    const repoPath = requireString(args, 'repoPath');
    try {
      const real = await allow(repoPath);
      return repoOk(real);
    } catch {
      return false;
    }
  },
});
