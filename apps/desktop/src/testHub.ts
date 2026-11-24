import { vi } from 'vitest';
import { hub } from './transport';
import type { Commands } from './wire';

/** A fake for one hub command: its args object in, a promise of its result out. */
export type HubCall<K extends keyof Commands> = (args: Commands[K]['args']) => Promise<Commands[K]['result']>;

/** Per-command answers for `stubHubCalls`: the command's args in, its result (or a promise of it) out. */
export type HubCallHandlers = { [K in keyof Commands]?: (args: Commands[K]['args']) => Commands[K]['result'] | Promise<Commands[K]['result']> };

/**
 * Answer the page session's `hub().call(cmd, args)` from `handlers` for one test (undo with `vi.restoreAllMocks()`);
 * a command without a handler rejects. Returns the spy: assert with `toHaveBeenCalledWith('cmd', { …args })`.
 */
export function stubHubCalls(handlers: HubCallHandlers) {
  return vi.spyOn(hub(), 'call').mockImplementation((async (cmd: keyof Commands, args?: unknown) => {
    const handler = handlers[cmd] as ((a: unknown) => unknown) | undefined;
    if (handler === undefined) throw new Error(`no stub for hub call ${cmd}`);
    return handler(args);
  }) as never);
}
