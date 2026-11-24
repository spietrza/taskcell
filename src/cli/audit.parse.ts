import { STREAMS } from '../core/audit.js';
import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `audit`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseAuditCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const action = positionals[1];
  if (action !== 'verify' && action !== 'export') return fail('audit expects a subcommand: taskcell audit verify [--stream <name>] | taskcell audit export [--stream <name>] [--since <date>] [--until <date>] [--format jsonl|csv].');
  const streams = Object.keys(STREAMS);
  if (typeof values.stream === 'string' && !streams.includes(values.stream)) return fail(`audit --stream must be one of ${streams.join(', ')}, got '${values.stream}'.`);
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
