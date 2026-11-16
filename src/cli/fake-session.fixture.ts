import { vi } from 'vitest';
import type { AgentSession } from '../runners/agent-session.js';
import type { OpenAgentSession } from './review-agent.js';

/**
 * An injectable session opener for the CLI command tests: no sandbox, no sidecars. `prepare` and `close`
 * are spies, and `opened` records the options each session was opened with.
 */
export function fakeSessionOpener(): {
  open: OpenAgentSession;
  opened: Parameters<OpenAgentSession>[0][];
  prepare: ReturnType<typeof vi.fn<AgentSession['prepare']>>;
  close: ReturnType<typeof vi.fn>;
} {
  const opened: Parameters<OpenAgentSession>[0][] = [];
  const prepare = vi.fn<AgentSession['prepare']>(async () => ({}) as never);
  const close = vi.fn(async () => undefined);
  const open: OpenAgentSession = async (opts) => {
    opened.push(opts);
    return { agents: { agent: { name: 'claude' } }, credentials: {}, sandbox: {}, ctx: undefined, prepare, close } as never;
  };
  return { open, opened, prepare, close };
}
