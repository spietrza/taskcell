import type { ExecOptions, ExecResult, IsolatedSandboxProvider } from './provider.js';

/** A sandbox exec that always runs in gate mode (see {@link gateExec}). */
export type GateExec = (command: string, options?: Omit<ExecOptions, 'loginShell'>) => Promise<ExecResult>;

/**
 * Bind `sandbox.exec` once for a gate (verify, visual proof): a non-login shell, so agent-owned
 * `$HOME` dotfiles and the agent-writable secrets file cannot change the result (#1180). The option
 * cannot be passed or forgotten per call; gate modules must use this, never `sandbox.exec` (a test
 * scans them).
 */
export function gateExec(sandbox: IsolatedSandboxProvider): GateExec {
  return (command, options) => sandbox.exec(command, { ...options, loginShell: false });
}
