import { DEFAULT_PR_REVIEWING_LABEL, DEFAULT_PR_REVIEWED_LABEL, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import { formatPreflightReport, preflightFailed, runPreflight } from './preflight.js';
import type { Command } from './args.js';
import type { PreflightOptions } from './preflight.js';

type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;

export interface DoctorPrsOptions extends PreflightOptions {
  log?: (line: string) => void;
}

/** Print PR-watch readiness checks and fail before any pull request can be claimed. */
export async function doctorPrsCommand(cmd: DoctorPrsCommand, opts: DoctorPrsOptions = {}): Promise<void> {
  const report = await runPreflight(cmd, opts);
  const log = opts.log ?? console.log;
  for (const line of formatPreflightReport(report)) log(line);
  if (!report.ok) throw preflightFailed();
}

/** Parse `doctor-prs`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseDoctorPrsCommand(ctx: ParseCtx): Command {
  const { values, repoPath, builtinProvider, proxyMode } = ctx;
  const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (repoSlug === undefined || label === undefined) return fail('doctor-prs requires --github-repo <owner/repo> and --label <name>.');
  return {
    kind: 'doctor-prs',
    repoSlug,
    repoPath,
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
  };
}
