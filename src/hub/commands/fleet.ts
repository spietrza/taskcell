// Hub commands: the Fleet screen: spawn, kill and list shell processes (owner only, loopback hub with fleet enabled). One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { type SpawnRegistry } from '../spawn.js';
import type { SpawnInfo } from '../../wire.js';
import type { RpcContext } from '../rpc.js';
import { defineCommands, requireString, optionalNumber } from '../command-kit.js';

export interface FleetCommands {
  /** The Fleet screen's shell-spawn surface — enabled only on the desktop app's local (loopback) hub,
   * refused elsewhere (remote code execution on a reachable server). `argv[0]` is the program, run
   * WITHOUT a shell: values built from repo config travel as single arguments and can never
   * introduce shell syntax. */
  spawn_run: { args: { cwd: string; argv: string[] }; result: number };
  /** See spawn_run. */
  kill_run: { args: { pid: number }; result: void };
  /** See spawn_run. */
  list_spawns: { args: undefined; result: SpawnInfo[] };
}

/** The Fleet screen (`spawn_run` et al) is off unless the hub is the desktop app's own local hub:
 * `spawn_run` executes arbitrary programs, which is remote code execution on a reachable server. */
export const FLEET_DISABLED_MESSAGE = 'the Fleet screen is not available on this hub';

/** The Fleet screen's shell-spawn surface — refused unless `ctx.spawnRegistry` is set. */
function requireFleet(ctx: RpcContext): SpawnRegistry {
  if (ctx.spawnRegistry === undefined) throw new BadRequestError(FLEET_DISABLED_MESSAGE);
  return ctx.spawnRegistry;
}

export const commands = defineCommands<FleetCommands>({
  spawn_run: async ({ ctx, args, allow }) => {
    const spawns = requireFleet(ctx);
    const real = await allow(requireString(args, 'cwd'));
    const argv = args.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
      throw new BadRequestError('argv is required and must be a non-empty array of strings');
    }
    // Saved instance credentials reach the spawn explicitly (argv is any agent CLI, so every storable name), read at call time.
    await ctx.userCredentials?.instanceStatus();
    return spawns.spawn(real, argv as string[], ctx.userCredentials?.childEnv());
  },
  kill_run: async ({ ctx, args }) => {
    const spawns = requireFleet(ctx);
    const pid = optionalNumber(args, 'pid');
    if (pid === undefined) throw new BadRequestError('pid is required and must be a number');
    spawns.kill(pid);
    return null;
  },
  list_spawns: async ({ ctx }) => {
    return requireFleet(ctx).list();
  },
}, {
  // The owner's shell-spawn surface; the handlers also refuse unless the hub is the desktop app's own (ctx.spawnRegistry).
  spawn_run: { write: true, owner: true, gatedBy: 'the handler resolves cwd through the allowlist once the fleet is known to be enabled', unaudited: 'only on the desktop app\'s own loopback hub' },
  kill_run: { write: true, owner: true, unaudited: 'only on the desktop app\'s own loopback hub' },
  list_spawns: { write: false, owner: true },
});
