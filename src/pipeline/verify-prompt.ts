import type { VerificationResult } from './verify.js';

/** Prompt line telling the implementer/reviser how the host verifies the change; empty when no command resolved. */
export function verifyInstruction(cmd: string | undefined): string {
  return cmd === undefined ? '' : `The host verifies your change with \`${cmd}\`. Run exactly that command to check your work.`;
}

/** Host gate outcome as reviewer data (pass/fail + first error lines); the reviewer is not asked to run anything. */
export function gateResultText(result: VerificationResult | undefined): string {
  if (result === undefined) return 'Host verification: not run (no verify command resolved).';
  if (result.passed) return `Host verification: PASSED (\`${result.command}\`, exit ${result.exitCode}).`;
  const first = result.firstErrorLines !== undefined && result.firstErrorLines !== '' ? result.firstErrorLines : result.outputTail;
  return `Host verification: FAILED (\`${result.command}\`, exit ${result.exitCode}). First error lines:\n${first}`;
}
