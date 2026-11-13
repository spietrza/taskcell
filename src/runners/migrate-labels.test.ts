import { describe, expect, it } from 'vitest';
import { migrateLabels } from './migrate-labels.js';

const repoLabels = ['bug', 'vanguard:running', 'vanguard:model=opus', 'ready for vanguard review', 'vanguard:waiting', 'taskcell:waiting'];

function makeGh(): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (args) => {
      calls.push(args);
      return args[1] === 'list' ? JSON.stringify(repoLabels.map((name) => ({ name }))) : '';
    },
  };
}

describe('migrateLabels', () => {
  it('is a dry-run by default: reports the renames and edits nothing', async () => {
    const { gh, calls } = makeGh();
    const report = await migrateLabels({ repoSlug: 'o/r', gh, log: () => {} });
    expect(report.dryRun).toBe(true);
    expect(report.renamed).toEqual([
      { from: 'vanguard:running', to: 'taskcell:running' },
      { from: 'vanguard:model=opus', to: 'taskcell:model=opus' },
    ]);
    expect(report.skipped).toEqual([{ from: 'vanguard:waiting', to: 'taskcell:waiting' }]);
    expect(calls.filter((c) => c[1] === 'edit')).toEqual([]);
  });

  it('--apply renames in place and leaves a label whose new name already exists', async () => {
    const { gh, calls } = makeGh();
    const report = await migrateLabels({ repoSlug: 'o/r', apply: true, gh, log: () => {} });
    expect(report.dryRun).toBe(false);
    expect(calls.filter((c) => c[1] === 'edit')).toEqual([
      ['label', 'edit', 'vanguard:running', '--repo', 'o/r', '--name', 'taskcell:running'],
      ['label', 'edit', 'vanguard:model=opus', '--repo', 'o/r', '--name', 'taskcell:model=opus'],
    ]);
  });

  it('leaves the review trigger alone and says why: the PR-review workflows fire on its name', async () => {
    const { gh, calls } = makeGh();
    const logs: string[] = [];
    const report = await migrateLabels({ repoSlug: 'o/r', apply: true, gh, log: (line) => logs.push(line) });
    expect(calls.some((c) => c.includes('ready for vanguard review'))).toBe(false);
    expect([...report.renamed, ...report.skipped].some((r) => r.from === 'ready for vanguard review')).toBe(false);
    expect(report.failed).toEqual([]);
    expect(logs.some((l) => l.includes('keep "ready for vanguard review"'))).toBe(true);
  });

  it('records a failed rename and carries on', async () => {
    const { gh } = makeGh();
    const failing = async (args: string[]): Promise<string> => {
      if (args[1] === 'edit' && args[2] === 'vanguard:running') throw new Error('403');
      return gh(args);
    };
    const report = await migrateLabels({ repoSlug: 'o/r', apply: true, gh: failing, log: () => {} });
    expect(report.failed).toEqual([{ from: 'vanguard:running', reason: '403' }]);
    expect(report.renamed).toHaveLength(1);
  });
});
