import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import {
  allRunEventFiles,
  branchAdapter,
  hubAuditFile,
  metricsFile,
  exportRecords,
  filterByTime,
  localAdapter,
  readAudit,
  STREAMS,
  verifyAudit,
  type AuditAdapter,
} from '../core/audit.js';
import { DECISIONS_FILE } from '../approver/ledger.js';
import { LESSONS_FILE } from '../core/lessons.js';
import { defaultHubConfigDir } from '../hub/audit.js';
import type { Command } from './args.js';

type AuditCommand = Extract<Command, { kind: 'audit' }>;

const STREAM_NAMES = Object.keys(STREAMS);


/** The chains of one stream: one for most; one per run for run-events (each run's log is its own chain). */
async function adaptersFor(cmd: AuditCommand, name: string): Promise<AuditAdapter[]> {
  const branch = cmd.branch !== undefined ? { branch: cmd.branch } : {};
  switch (name) {
    case 'hub':
      return [localAdapter({ file: hubAuditFile(cmd.configDir ?? defaultHubConfigDir()) })];
    case 'metrics':
      return [localAdapter({ file: metricsFile(cmd.repoPath), repoPath: cmd.repoPath })];
    case 'run-events':
      return (await allRunEventFiles(cmd.repoPath)).map((file) => localAdapter({ file, repoPath: cmd.repoPath }));
    case 'decisions':
      return [branchAdapter(cmd.repoPath, { ...branch, file: DECISIONS_FILE })];
    default:
      return [branchAdapter(cmd.repoPath, { ...branch, file: LESSONS_FILE })];
  }
}

/** `taskcell audit verify|export`. Resolves to the exit code: 1 when any chain fails to verify. */
export async function auditCommand(cmd: AuditCommand): Promise<number> {
  const names = cmd.stream !== undefined ? [cmd.stream] : STREAM_NAMES;
  let failed = false;
  let first = true;
  for (const name of names) {
    const adapters = await adaptersFor(cmd, name);
    if (cmd.action === 'export') {
      const records = filterByTime((await Promise.all(adapters.map(readAudit))).flat(), cmd.since, cmd.until);
      process.stdout.write(exportRecords(records, cmd.format, name, first));
      first = false;
      continue;
    }
    for (const adapter of adapters) {
      const r = await verifyAudit(adapter);
      if (adapters.length > 1 && r.ok && r.records === 0 && r.legacy === 0) continue;
      const extra = `${r.legacy > 0 ? `, ${r.legacy} unchained (pre-audit)` : ''}${r.torn > 0 ? `, ${r.torn} torn final line` : ''}`;
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name}: ${r.records} chained record(s)${extra}`);
      for (const p of r.problems) console.log(`       ${p.file}:${p.line}: ${p.reason}`);
      if (!r.ok) failed = true;
    }
  }
  return failed ? 1 : 0;
}

/** Parse `audit`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseAuditCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const action = positionals[1];
  if (action !== 'verify' && action !== 'export') return fail('audit expects a subcommand: taskcell audit verify [--stream <name>] | taskcell audit export [--stream <name>] [--since <date>] [--until <date>] [--format jsonl|csv].');
  if (typeof values.stream === 'string' && !Object.keys(STREAMS).includes(values.stream)) return fail(`audit --stream must be one of ${Object.keys(STREAMS).join(', ')}, got '${values.stream}'.`);
  const format = typeof values.format === 'string' ? values.format : 'jsonl';
  if (format !== 'jsonl' && format !== 'csv') return fail(`audit --format must be jsonl or csv, got '${format}'.`);
  for (const key of ['since', 'until'] as const) {
    const v = values[key];
    if (typeof v === 'string' && Number.isNaN(Date.parse(v))) return fail(`audit --${key} must be a date, got '${v}'.`);
  }
  return {
    kind: 'audit',
    action,
    repoPath,
    format,
    ...(typeof values.stream === 'string' ? { stream: values.stream } : {}),
    ...(typeof values['config-dir'] === 'string' ? { configDir: values['config-dir'] } : {}),
    ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    ...(typeof values.since === 'string' ? { since: values.since } : {}),
    ...(typeof values.until === 'string' ? { until: values.until } : {}),
  };
}
