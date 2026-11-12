import { formatPreflightReport, runPreflight, SANDBOX_CLI_CHECK } from './preflight.js';
import {
  SANDBOX_CLAUDE_VERSION,
  SANDBOX_CODEX_VERSION,
  isOlderVersion,
  refreshSandboxClaudeCli,
  refreshSandboxCodexCli,
} from '../sandbox/docker.js';
import { checkCliVersions, formatCliVersions, installedCliVersions } from '../sandbox/cli-versions.js';
import type { Command } from './args.js';
import type { PreflightOptions } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;

export interface DoctorOptions extends PreflightOptions {
  log?: (line: string) => void;
  /** Version lookup, injectable for tests; honours the VANGUARD_CLI_VERSION_CHECK off switch. */
  cliVersions?: typeof checkCliVersions;
}

/** Codex runs as the implementer, the reviewer or the implementer fallback. */
function usesCodex(cmd: DoctorCommand): boolean {
  return [cmd.provider, cmd.reviewProvider, 'fallbackProvider' in cmd ? cmd.fallbackProvider : undefined].includes('codex');
}

/** Print AFK-readiness checks and fail before any task can be claimed. */
export async function doctorCommand(cmd: DoctorCommand, opts: DoctorOptions = {}): Promise<void> {
  const log = opts.log ?? console.log;
  let report = await runPreflight(cmd, opts);
  const dockerOpts = {
    cwd: cmd.repoPath,
    ...(opts.run !== undefined ? { run: opts.run } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };

  // --fix repairs the failures that have a safe, deterministic remedy: a sandbox image whose
  // bundled claude CLI predates the repo pin, or whose codex CLI does. Deliberately a separate,
  // explicit command rather than something a run does on its own — it needs the network and
  // rewrites an image other sandboxes share.
  if (!report.ok && cmd.fix === true && report.checks.some((c) => c.name === SANDBOX_CLI_CHECK && !c.ok)) {
    log(`doctor --fix: installing claude ${SANDBOX_CLAUDE_VERSION} into the sandbox image`);
    await refreshSandboxClaudeCli(dockerOpts);
    report = await runPreflight(cmd, opts);
  }
  let codexFixFailed = false;
  if (cmd.fix === true && usesCodex(cmd)) {
    // Read straight from the image: the codex fix must not depend on the version-check switch.
    const codex = (await installedCliVersions(dockerOpts)).codex;
    if (codex !== undefined && isOlderVersion(codex, SANDBOX_CODEX_VERSION)) {
      log(`doctor --fix: installing codex ${SANDBOX_CODEX_VERSION} into the sandbox image`);
      // A failed codex install must not hide the preflight report below; it fails doctor after it.
      try {
        await refreshSandboxCodexCli(dockerOpts);
        const after = (await installedCliVersions(dockerOpts)).codex;
        if (after === undefined || isOlderVersion(after, SANDBOX_CODEX_VERSION)) throw new Error(`image still has codex ${after ?? 'unknown'}`);
      } catch (e: unknown) {
        codexFixFailed = true;
        log(`doctor --fix: codex install failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // The report first: the version check needs Docker and the network, and must not delay it.
  for (const line of formatPreflightReport(report)) log(line);
  for (const line of formatCliVersions(await (opts.cliVersions ?? checkCliVersions)(dockerOpts))) log(line);
  if (!report.ok) throw new Error('preflight failed');
  if (codexFixFailed) throw new Error('doctor --fix: codex install failed');
}
