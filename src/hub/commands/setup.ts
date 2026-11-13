// Hub commands: first-run setup detection. One module per feature — contract and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { assertMutationsAllowed } from '../allowlist.js';
import { detectSetup } from '../setup-status.js';
import * as teams from '../teams.js';
import type { SetupStatus } from '../../wire.js';
import { defineCommands } from '../command-kit.js';

export interface SetupCommands {
  /** HUB_ONLY, owner only, read-only: whether `gh`, `glab`, a Linear key and a model credential (Claude, or a Codex key or sign-in file) are present on the hub host. Booleans only — never a secret value. Spawns `gh`/`glab` on the host, so it is refused on a non-loopback bind without VANGUARD_HUB_ALLOW_ADD. */
  setup_status: { args: undefined; result: SetupStatus };
}

export const commands = defineCommands<SetupCommands>({
  setup_status: async ({ ctx, caller }) => {
    teams.assertOwner(caller);
    assertMutationsAllowed(ctx.bind);
    return detectSetup(await ctx.credentials.summary());
  },
});
