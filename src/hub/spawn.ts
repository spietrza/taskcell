// Fleet's shell-spawn surface (`spawn_run`/`kill_run`/`list_spawns`), ported from the desktop's
// former Rust spawn module. Only reachable when the hub was started with fleet enabled (the desktop app's local
// hub, `TASKCELL_HUB_ALLOW_FLEET=1` on a loopback bind) — see `FLEET_DISABLED_MESSAGE` in rpc.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export const SPAWN_OUTPUT_EVENT = 'spawn:output';
export const SPAWN_EXIT_EVENT = 'spawn:exit';

export interface SpawnInfo {
  pid: number;
  cwd: string;
  command: string;
}

/** `taskcell`/`vanguard` resolve to this very CLI, so an installed app needs no CLI on PATH. */
function resolveProgram(argv: readonly string[]): { program: string; args: string[] } {
  const [program, ...rest] = argv as [string, ...string[]];
  const self = process.argv[1];
  if ((program === 'taskcell' || program === 'vanguard') && self !== undefined) {
    return { program: process.execPath, args: [...process.execArgv, self, ...rest] };
  }
  return { program, args: rest };
}

export class SpawnRegistry {
  private readonly children = new Map<number, { child: ChildProcess; info: SpawnInfo }>();

  constructor(private readonly publish: (name: string, payload: unknown) => void) {}

  /** Run `argv` in `cwd` with NO shell (argv is built from repo config, so each element stays one
   * argument), merging stdout+stderr line by line into `spawn:output`; `spawn:exit` on end. */
  spawn(cwd: string, argv: readonly string[]): Promise<number> {
    const { program, args } = resolveProgram(argv);
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('error', reject);
      child.once('spawn', () => {
        const pid = child.pid!;
        this.children.set(pid, { child, info: { pid, cwd, command: argv.join(' ') } });
        let live = 0;
        let exitCode: number | null | undefined;
        const finish = (): void => {
          if (live > 0 || exitCode === undefined) return;
          this.children.delete(pid);
          this.publish(SPAWN_EXIT_EVENT, { pid, code: exitCode });
        };
        for (const stream of [child.stdout, child.stderr]) {
          live += 1;
          const rl = createInterface({ input: stream! });
          rl.on('line', (line) => this.publish(SPAWN_OUTPUT_EVENT, { pid, line }));
          rl.on('close', () => {
            live -= 1;
            finish();
          });
        }
        child.once('close', (code) => {
          exitCode = code;
          finish();
        });
        // A grandchild holding the pipes open must not stall the exit event forever.
        child.once('exit', (code) => {
          exitCode = code;
          setTimeout(() => {
            live = 0;
            finish();
          }, 2000).unref();
        });
        resolve(pid);
      });
    });
  }

  kill(pid: number): void {
    this.children.get(pid)?.child.kill();
  }

  list(): SpawnInfo[] {
    return [...this.children.values()].map((e) => e.info);
  }

  /** Hub shutdown: take every spawned run down with it. */
  killAll(): void {
    for (const { child } of this.children.values()) child.kill();
  }
}
