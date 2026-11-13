import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  branchAdapter,
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
import { stateDir } from '../core/state-path.js';
import { defaultHubConfigDir } from '../hub/audit.js';
import type { Command } from './args.js';

type AuditCommand = Extract<Command, { kind: 'audit' }>;

const STREAM_NAMES = Object.keys(STREAMS);


/** The chains of one stream: one for most; one per run for run-events (each run's log is its own chain). */
async function adaptersFor(cmd: AuditCommand, name: string): Promise<AuditAdapter[]> {
  const branch = cmd.branch !== undefined ? { branch: cmd.branch } : {};
  switch (name) {
    case 'hub':
      return [localAdapter({ file: join(cmd.configDir ?? defaultHubConfigDir(), 'audit.jsonl') })];
    case 'metrics':
      return [localAdapter({ file: join(stateDir(cmd.repoPath), 'runs', 'metrics.jsonl'), repoPath: cmd.repoPath })];
    case 'run-events': {
      const runs = join(stateDir(cmd.repoPath), 'runs');
      const out: AuditAdapter[] = [];
      for (const task of await readdir(runs).catch(() => [] as string[])) {
        for (const f of await readdir(join(runs, task)).catch(() => [] as string[])) {
          if (f.startsWith('events-') && f.endsWith('.jsonl')) out.push(localAdapter({ file: join(runs, task, f), repoPath: cmd.repoPath }));
        }
      }
      return out;
    }
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
