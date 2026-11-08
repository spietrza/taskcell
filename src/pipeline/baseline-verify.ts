import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureStateDir, assertStatePath, stateDir } from '../core/state-path.js';
import { redactVerificationOutput, runVerification } from './verify.js';
import type { VerificationResult } from './verify.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

function baselineDir(repoPath: string): string {
  return join(stateDir(repoPath), 'baseline-verify');
}

/** `undefined` for a SHA shape git could never produce — refuses to ever read/write outside baselineDir. */
function baselinePath(repoPath: string, sha: string): string | undefined {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return undefined;
  return join(baselineDir(repoPath), `${sha.toLowerCase()}.json`);
}

/**
 * Best-effort cached read; absent, unreadable, symlinked or malformed all read as "no cache". A
 * record that is not green reads as "no cache" too: only green baselines are cached (see
 * resolveBaselineVerify), so a red one on disk is a leftover, never a verdict to serve.
 */
async function readCachedBaselineVerify(repoPath: string, sha: string): Promise<VerificationResult | undefined> {
  const file = baselinePath(repoPath, sha);
  if (file === undefined) return undefined;
  try {
    await assertStatePath(repoPath, file);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<VerificationResult>;
    if (typeof parsed.command !== 'string' || parsed.passed !== true || typeof parsed.exitCode !== 'number' || typeof parsed.sha256 !== 'string' || typeof parsed.outputTail !== 'string') {
      return undefined;
    }
    return parsed as VerificationResult;
  } catch {
    return undefined;
  }
}

/** Best-effort cache write — a failure here must never fail a run. */
async function writeCachedBaselineVerify(repoPath: string, sha: string, result: VerificationResult): Promise<void> {
  const file = baselinePath(repoPath, sha);
  if (file === undefined) return;
  try {
    await ensureStateDir(repoPath, baselineDir(repoPath));
    await assertStatePath(repoPath, file);
    // Verbatim command output, masked on the way to disk like every other free text persisted
    // under the state dir (see run-store's writeProof).
    await writeFile(file, JSON.stringify(redactVerificationOutput(result)));
  } catch {
    // best-effort
  }
}

/**
 * Run the verify command against the base commit (before the implementer has touched anything —
 * the worktree is still exactly `sha` at this point) and cache the result by SHA, so repeated runs
 * cut from the same base commit (a common case: several issues queued against the same main HEAD)
 * don't re-pay the install+test cost. A cached result for a *different* command is never served —
 * only ever reused for the exact same `command` string, so a changed `--verify-cmd` can't read a
 * stale verdict from before it changed.
 *
 * Only a green baseline is persisted. The point of the cache is skipping work already known to be
 * unnecessary, and a red verdict is the one that must not be sticky: a flaky test or a transient
 * install failure would otherwise pin every later attempt against that SHA to "base is red" with no
 * way to clear it. A red baseline is re-run on every attempt instead.
 */
export async function resolveBaselineVerify(
  repoPath: string,
  sha: string,
  sandbox: IsolatedSandboxProvider,
  command: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const cached = await readCachedBaselineVerify(repoPath, sha);
  if (cached !== undefined && cached.command === command) return cached;
  const result = await runVerification(sandbox, command, signal);
  if (result.passed) await writeCachedBaselineVerify(repoPath, sha, result);
  return result;
}
