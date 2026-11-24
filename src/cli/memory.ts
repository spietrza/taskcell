import { parseLimit } from './flags.js';
import type { ParseCtx } from './flags.js';
import { readFile } from 'node:fs/promises';
import {
  buildRetrospectiveMemory,
  renderRetrospectiveMarkdown,
  refreshRetrospectiveMemory,
  writeRetrospectiveMarkdown,
} from '../core/retrospective-memory.js';
import type { Command } from './args.js';

type MemoryCommand = Extract<Command, { kind: 'memory' }>;

/** Refresh .taskcell/memory/retrospective.md from run artifacts, then print it (or the raw report with --json). */
export async function memoryCommand(cmd: MemoryCommand): Promise<void> {
  // exactOptionalPropertyTypes: omit `limit` entirely when absent so the builder default applies.
  const opts = cmd.limit !== undefined ? { limit: cmd.limit } : {};
  if (cmd.json) {
    // Scan once: build the report, then reuse it to write the file (no second scan).
    const report = await buildRetrospectiveMemory(cmd.repoPath, opts);
    const md = renderRetrospectiveMarkdown(report);
    await writeRetrospectiveMarkdown(cmd.repoPath, md);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const path = await refreshRetrospectiveMemory(cmd.repoPath, opts);
  console.log(await readFile(path, 'utf8'));
}

/** Parse `memory`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseMemoryCommand(ctx: ParseCtx): Command {
  const { values, repoPath } = ctx;
  const limit = parseLimit(values.limit);
  return {
    kind: 'memory',
    repoPath,
    ...(limit !== undefined ? { limit } : {}),
    json: values.json === true,
  };
}
