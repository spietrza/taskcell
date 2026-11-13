// Hub commands: installed vs latest agent CLI versions. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { assertMutationsAllowed } from '../allowlist.js';
import { checkCliVersions } from '../../sandbox/cli-versions.js';
import type { CliVersionReport } from '../../wire.js';
import { defineCommands } from '../command-kit.js';

export interface CliVersionsCommands {
  /** HUB_ONLY, read-only: installed vs latest claude/codex/cursor CLI in the local sandbox image (3-day soak applied; `enabled: false`, and no lookups, when TASKCELL_CLI_VERSION_CHECK is off). Refused on a non-loopback bind without TASKCELL_HUB_ALLOW_ADD. */
  agent_cli_versions: { args: undefined; result: CliVersionReport };
}

export const commands = defineCommands<CliVersionsCommands>({
  agent_cli_versions: async ({ ctx }) => {
    // Starts a container on the host and makes outbound lookups — gated like the other side effects.
    assertMutationsAllowed(ctx.bind);
    return checkCliVersions({ cwd: ctx.configDir });
  },
});
