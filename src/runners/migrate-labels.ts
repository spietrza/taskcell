import { currentLabel } from '../core/labels.js';
import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import type { MigrateLabelsReport } from '../wire.js';

export type { MigrateLabelsReport };

export interface MigrateLabelsOptions {
  repoSlug: string;
  /** Rename for real. Default: dry-run (report only). */
  apply?: boolean;
  gh?: GhRunner;
  log?: (line: string) => void;
}

/**
 * One-shot migration: rename a repo's pre-rename `vanguard:*` labels (and `ready for vanguard review`) to their
 * `taskcell` names. `gh label edit --name` renames in place, so issues and PRs keep the label. Dry-run by default.
 */
export async function migrateLabels(opts: MigrateLabelsOptions): Promise<MigrateLabelsReport> {
  const gh = opts.gh ?? defaultGhRunner;
  const log = opts.log ?? ((line: string): void => console.log(line));
  const dryRun = opts.apply !== true;
  const names = (JSON.parse(await gh(['label', 'list', '--repo', opts.repoSlug, '--limit', '1000', '--json', 'name'])) as { name: string }[]).map((l) => l.name);
  const existing = new Set(names);
  const report: MigrateLabelsReport = { renamed: [], skipped: [], failed: [], dryRun };
  for (const from of names) {
    const to = currentLabel(from);
    if (to === from) continue;
    if (existing.has(to)) {
      log(`migrate-labels ${opts.repoSlug}: skip "${from}" -> "${to}" already exists (the old label is still recognised)`);
      report.skipped.push({ from, to });
      continue;
    }
    try {
      if (!dryRun) await gh(['label', 'edit', from, '--repo', opts.repoSlug, '--name', to]);
      log(`migrate-labels ${opts.repoSlug}: ${dryRun ? 'would rename' : 'renamed'} "${from}" -> "${to}"`);
      report.renamed.push({ from, to });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`migrate-labels ${opts.repoSlug}: failed "${from}" -> ${reason}`);
      report.failed.push({ from, reason });
    }
  }
  return report;
}
