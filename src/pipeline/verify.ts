import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactForPublish } from '../core/secret-scan.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import { readEnv } from '../core/env.js';

export interface VerificationResult {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;        // over the combined stdout + stderr
  outputTail: string;    // last ~40 lines, for the PR body
  /**
   * The earliest lines around the first failure marker in the full output. A monorepo task runner
   * (turbo, lerna) prints every task's output in sequence, so `outputTail` alone can be a screen of
   * passing packages with the actual failure scrolled off the top — this is the part that names what
   * is actually red. Empty (or absent, for a record written before this field existed) when `passed`
   * or no marker was found.
   */
  firstErrorLines?: string;
  /**
   * Whether the sandbox cgroup's `memory.events` `oom_kill` counter rose during a failed verify
   * (a killed worker leaves the container alive, so `OOMKilled` is unreliable). Absent when
   * `passed` or the counter could not be read.
   */
  oomKilled?: boolean;
}

/** The one wording for the OOM evidence, shared by the run log and the proof block. */
function oomNote(oomKilled: boolean): string {
  return oomKilled
    ? 'yes — the verify run was OOM-killed in the sandbox (raise `TASKCELL_SANDBOX_MEMORY_MB`)'
    : 'no OOM kill during the verify run (memory.events oom_kill did not change)';
}

const WORKDIR = '/workspace';

/** Marker files that indicate a Python project driven by pytest. */
const PYTHON_MARKERS = ['pyproject.toml', 'pytest.ini', 'setup.cfg'];

/** Type-check script names, in precedence order. */
const TYPECHECK_SCRIPTS = ['typecheck', 'check-types', 'type-check'];

/** The package manager a package.json's `packageManager` field names (pnpm/yarn), default npm. */
export function packageManagerOf(field: string | undefined): 'pnpm' | 'yarn' | 'npm' {
  const value = field ?? '';
  return value.startsWith('pnpm') ? 'pnpm' : value.startsWith('yarn') ? 'yarn' : 'npm';
}

/**
 * Resolve the verification command. Precedence: explicit cmd (CLI flag) > TASKCELL_VERIFY_CMD env >
 * a `verify` script in the worktree package.json > auto-detect from package.json's test/typecheck
 * scripts > auto-detect Python (pytest) markers > undefined (skip Proof of Work entirely — the
 * caller must render that skip visibly, not drop it silently).
 * JS auto-detect: if package.json has a `verify` script, build "<pm> install --frozen-lockfile &&
 * <pm> run verify" so the gate matches whatever a repo declares (e.g. the CI build job) instead of
 * our guess. Otherwise, if it has a `test` script, build "<pm> install --frozen-lockfile && <pm>
 * run typecheck && <pm> test", including the first of typecheck/check-types/type-check that exists;
 * pm from the `packageManager` field (pnpm/yarn/npm), default npm. Python auto-detect:
 * pyproject.toml/pytest.ini/setup.cfg present -> "pytest".
 */
export async function resolveVerifyCommand(
  worktreePath: string,
  opts: { cmd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if (opts.cmd !== undefined && opts.cmd !== '') return opts.cmd;
  const envCmd = readEnv('TASKCELL_VERIFY_CMD', opts.env);
  if (envCmd !== undefined && envCmd !== '') return envCmd;

  let pkgRaw: string | undefined;
  try {
    pkgRaw = await readFile(join(worktreePath, 'package.json'), 'utf8');
  } catch {
    pkgRaw = undefined;
  }
  if (pkgRaw !== undefined) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string };
      const scripts = pkg.scripts ?? {};
      const pm = packageManagerOf(pkg.packageManager);
      const install = `${pm} install --frozen-lockfile`;
      if (scripts.verify !== undefined) return `${install} && ${pm} run verify`;
      if (scripts.test === undefined) return undefined;
      const parts = [install];
      // Turborepo-style monorepos name it check-types; without this the gate never type-checks them.
      const typecheck = TYPECHECK_SCRIPTS.find((name) => scripts[name] !== undefined);
      if (typecheck !== undefined) parts.push(`${pm} run ${typecheck}`);
      parts.push(`${pm} test`);
      return parts.join(' && ');
    } catch {
      return undefined;
    }
  }

  for (const marker of PYTHON_MARKERS) {
    try {
      await readFile(join(worktreePath, marker), 'utf8');
      return 'pytest';
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Rendered in the PR body when no verify command could be resolved, so a skipped gate is visible, not silent. */
export function verifySkippedBlock(): string {
  return [
    '## Proof of work: SKIPPED',
    '',
    'No verify command resolved (no package.json test script, no pytest markers, and no `TASKCELL_VERIFY_CMD`).',
  ].join('\n');
}

/** Lines that mark an actual failure, as opposed to narrative prose that merely mentions one. */
const FAILURE_MARKER_RE = /(^|\s)(?:FAIL(?:ED)?\b|ERROR\b|ERR!|error TS\d+|[✕✖×])/;
/** How many lines of context to carry from the first failure marker onward. */
const FIRST_ERROR_LINES = 20;

/** The earliest `FIRST_ERROR_LINES` lines starting at the first failure marker, or '' if none found. */
export function extractFirstErrorLines(output: string): string {
  const lines = output.split('\n');
  const idx = lines.findIndex((l) => FAILURE_MARKER_RE.test(l));
  if (idx === -1) return '';
  return lines.slice(idx, idx + FIRST_ERROR_LINES).join('\n').trimEnd();
}

/** A turbo/lerna-style `<package>:<task>: ` line prefix, the closest thing to "which package failed". */
// The task part must hold a letter, so a `file.ts:12: message` compiler line is not read as one.
const TASK_PREFIX_RE = /^\s*((?:@[\w.-]+\/)?[\w.-]+):((?=[\w.-]*[A-Za-z_])[\w.-]+):\s/;

/** Best-effort failing task/package name from a monorepo runner's own output prefix; undefined if not that shape. */
export function failingTaskName(excerpt: string | undefined): string | undefined {
  if (excerpt === undefined || excerpt === '') return undefined;
  for (const line of excerpt.split('\n')) {
    const m = TASK_PREFIX_RE.exec(line);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return undefined;
}

/** The last `n` lines of `text`, ignoring trailing whitespace. */
function lastLines(text: string, n: number): string {
  return text.trimEnd().split('\n').slice(-n).join('\n');
}

/** Run the command inside the sandbox (host-driven) and attest the result. */
export async function runVerification(
  sandbox: IsolatedSandboxProvider,
  command: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const sh = sandbox.exec.bind(sandbox);
  // The counter is cumulative over the container's life (baseline, agent sessions, earlier verifies),
  // so read it before the command too and report only the delta.
  const oomBefore = await readOomKillCount(sh);
  const res = await sh(command, { cwd: WORKDIR, ...(signal !== undefined ? { signal } : {}) });
  const output = `${res.stdout}\n${res.stderr}`;
  const sha256 = createHash('sha256').update(output).digest('hex');
  const passed = res.exitCode === 0;
  // On a pass neither stream may evict the other: stderr noise (React act() warnings) must not hide a stdout
  // summary (Vitest), and stdout banners (pnpm install) must not hide a stderr summary (Jest).
  const outputTail =
    passed && res.stdout.trim() !== '' && res.stderr.trim() !== ''
      ? `${lastLines(res.stderr, 10)}\n${lastLines(res.stdout, 30)}`
      : lastLines(output, 40);
  const oomAfter = passed ? undefined : await readOomKillCount(sh);
  const oomKilled = oomBefore !== undefined && oomAfter !== undefined ? oomAfter > oomBefore : undefined;
  const result: VerificationResult = {
    command,
    exitCode: res.exitCode,
    passed,
    sha256,
    outputTail,
    firstErrorLines: passed ? '' : extractFirstErrorLines(output),
    ...(oomKilled !== undefined ? { oomKilled } : {}),
  };
  if (oomKilled !== undefined) console.log(`taskcell: verify failed — OOM kill: ${oomNote(oomKilled)}`);
  return result;
}

/** The sandbox cgroup's `oom_kill` counter (cgroup v2 `memory.events`); undefined if unreadable. */
async function readOomKillCount(sh: IsolatedSandboxProvider['exec']): Promise<number | undefined> {
  try {
    const r = await sh('cat /sys/fs/cgroup/memory.events 2>/dev/null');
    const m = /^oom_kill\s+(\d+)/m.exec(r.stdout);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mask the two verbatim-output fields a result carries — `outputTail` and, when present,
 * `firstErrorLines` — like every other free text in a persisted record. One place, so every copy
 * written under the state dir is masked the same way (run-store's writeProof, the baseline cache).
 */
export function redactVerificationOutput(result: VerificationResult, secretValues?: readonly string[]): VerificationResult {
  return {
    ...result,
    outputTail: redactForPublish(result.outputTail, secretValues),
    ...(result.firstErrorLines !== undefined ? { firstErrorLines: redactForPublish(result.firstErrorLines, secretValues) } : {}),
  };
}

/**
 * Minimal failing-witness feedback for the verification repair loop (CEGIS-style, mirrors
 * renderConformanceFeedback): the command, exit code, failing task/package when identifiable, and
 * the first error lines (not just the tail — on a monorepo runner the tail can be all-passing
 * output from packages after the one that actually failed), so the resumed implement session stays
 * small and targeted at what is actually red.
 */
export function renderVerificationFeedback(result: VerificationResult): string {
  const task = failingTaskName(result.firstErrorLines);
  const lines = [
    'The verification command failed. Make it pass:',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    ...(task !== undefined ? [`- failing task/package: \`${task}\``] : []),
  ];
  if (result.firstErrorLines !== undefined && result.firstErrorLines !== '') lines.push('', 'First error lines:', result.firstErrorLines);
  lines.push('', 'Output tail:', result.outputTail);
  return lines.join('\n');
}

/** Fence-safe `<details>` block: one backtick longer than the longest run already inside `text`. */
function detailsBlock(summary: string, text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`<details><summary>${summary}</summary>`, '', fence, text, fence, '', '</details>'].join('\n');
}

/** Markdown Proof of Work block for the PR body. */
export function proofBlock(result: VerificationResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const task = !result.passed ? failingTaskName(result.firstErrorLines) : undefined;
  const lines = [
    `## Proof of work: ${status}`,
    '',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    `- sha256(output): \`${result.sha256}\``,
    ...(task !== undefined ? [`- failing task/package: \`${task}\``] : []),
    ...(result.oomKilled !== undefined ? [`- OOM kill: ${oomNote(result.oomKilled)}`] : []),
    '',
  ];
  // The tail alone can be a screen of passing output on a monorepo runner — show the failure itself too.
  if (!result.passed && result.firstErrorLines !== undefined && result.firstErrorLines !== '') {
    lines.push(detailsBlock('first error lines', result.firstErrorLines), '');
  }
  lines.push(detailsBlock('output tail', result.outputTail));
  return lines.join('\n');
}

/** Issue-comment block posted when the baseline verify command already fails on the base commit, before the implementer ran. */
export function baseRedBlock(baseBranch: string, sha: string, result: VerificationResult): string {
  const task = failingTaskName(result.firstErrorLines);
  const lines = [
    `🚧 Taskcell stopped before implementing: \`${baseBranch}\` (${sha.slice(0, 7)}) already fails \`${result.command}\` (exit ${result.exitCode}).`,
    '',
    'Fixing it would mean repairing failures that have nothing to do with this issue, so no implement run was started. Fix the base branch, then re-apply the trigger label. If this issue is the fix for the red base, add the `taskcell:base-red-ok` label and re-apply the trigger label to skip this check.',
    ...(task !== undefined ? ['', `- failing task/package: \`${task}\``] : []),
  ];
  const hasFirstError = result.firstErrorLines !== undefined && result.firstErrorLines !== '';
  const excerpt = hasFirstError ? (result.firstErrorLines as string) : result.outputTail;
  if (excerpt !== '') lines.push('', detailsBlock(hasFirstError ? 'first error lines' : 'output tail', excerpt));
  return lines.join('\n');
}
