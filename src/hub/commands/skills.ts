// Hub commands: the skills of a repository (src/cli/skills.ts): status, usage, and PR-only changes. One module per feature —
// contract, validation and handler live here; `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertMutationsAllowed } from '../allowlist.js';
import { aggregateSkills } from '../../core/skill-stats.js';
import { parseMetrics } from '../../core/stats.js';
import { cachedResolver, recordedMetrics, skillsAddPr, skillsChecked, skillsRemovePr, skillsUpdate } from '../../cli/skills.js';
import type { RepoSkill } from '../../wire.js';
import { defineCommands, optionalString, requireString, repoItemTarget, repoTarget } from '../command-kit.js';
import { safeUrl } from '../audit.js';
import { BadRequestError } from '../../sidecar/sidecar.js';
import * as teams from '../teams.js';

export interface SkillsCommands {
  /** HUB_ONLY, read-only: the skills of a repo (as in the hub checkout's working tree) with their lock status, upstream check and usage. */
  list_repo_skills: { args: { repoPath: string }; result: { skills: RepoSkill[] } };
  /** HUB_ONLY, owner only: `skills update <name> --pr`; the skill only ever changes on a new branch, delivered as a PR. Resolves to its URL. */
  update_skill_pr: { args: { repoPath: string; name: string }; result: { prUrl: string } };
  /** HUB_ONLY, owner only: `skills add` delivered as a PR. A failure carries the command's reason. */
  add_skill_pr: { args: { repoPath: string; source: string; ref?: string; path?: string; name?: string }; result: { prUrl: string } };
  /** HUB_ONLY, owner only: `skills remove` delivered as a PR. */
  remove_skill_pr: { args: { repoPath: string; name: string }; result: { prUrl: string } };
}

// One cache for the hub's lifetime: each pinned skill costs a `git ls-remote`.
const upstreamHead = cachedResolver();

/** `<git-url>[#ref]` as the CLI takes it; an explicit `ref` wins over the fragment. */
export function splitSource(source: string, ref?: string): { source: string; ref?: string } {
  const hash = source.indexOf('#');
  if (hash === -1) return { source, ...(ref !== undefined ? { ref } : {}) };
  const frag = source.slice(hash + 1);
  if (frag === '') throw new BadRequestError('empty #ref in the skill source');
  return { source: source.slice(0, hash), ref: ref ?? frag };
}

const skillsDir = (repo: string): string => join(repo, 'skills');

/** The PR URL the command printed; a run that opened none (nothing to change) is an error carrying its output. */
async function prUrlOf(run: (out: (line: string) => void) => Promise<void>, what: string): Promise<{ prUrl: string }> {
  const lines: string[] = [];
  await run((line) => lines.push(line));
  const opened = lines.map((l) => /^opened (\S+)$/.exec(l)?.[1]).find((u) => u !== undefined);
  if (opened === undefined) throw new BadRequestError(`${what} opened no pull request: ${lines.join(' | ').slice(0, 500) || 'nothing to change'}`);
  return { prUrl: opened };
}

export const commands = defineCommands<SkillsCommands>({
  list_repo_skills: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const dir = skillsDir(real);
    // A project without a skills directory has no skills: the empty state, not an error.
    const present = await stat(dir).then((st) => st.isDirectory(), () => false);
    const [rows, metrics] = await Promise.all([present ? skillsChecked(dir, upstreamHead) : Promise.resolve([]), recordedMetrics(real)]);
    const usage = new Map(aggregateSkills(parseMetrics(metrics)).map((r) => [r.skill, r.with]));
    const skills = rows.map((r): RepoSkill => {
      const u = usage.get(r.name);
      return {
        name: r.name,
        source: r.source,
        commit: r.commit.slice(0, 7),
        status: r.status,
        check: r.state,
        ...(u !== undefined ? { usage: { runs: u.runs, ...(u.passRate !== undefined ? { passRate: u.passRate } : {}), avgRepairRounds: u.avgRepairRounds, avgCostUsd: u.avgCostUsd } } : {}),
      };
    });
    return { skills };
  },
  update_skill_pr: async ({ ctx, args, caller, allow }) => {
    assertMutationsAllowed(ctx.bind);
    teams.assertOwner(caller);
    const real = await allow(requireString(args, 'repoPath'));
    const name = requireString(args, 'name');
    // Always `--pr`, never a dry run: the skill is never updated without opening a PR.
    return prUrlOf((out) => skillsUpdate({ dir: skillsDir(real), repo: real, name, dryRun: false, pr: true }, {}, out), 'The update');
  },
  add_skill_pr: async ({ ctx, args, caller, allow }) => {
    assertMutationsAllowed(ctx.bind);
    teams.assertOwner(caller);
    const real = await allow(requireString(args, 'repoPath'));
    const { source, ref } = splitSource(requireString(args, 'source'), optionalString(args, 'ref'));
    const path = optionalString(args, 'path');
    const name = optionalString(args, 'name');
    return prUrlOf(
      (out) => skillsAddPr({ dir: skillsDir(real), repo: real, source, ...(ref !== undefined ? { ref } : {}), ...(path !== undefined ? { path } : {}), ...(name !== undefined ? { name } : {}) }, {}, out),
      'The add',
    );
  },
  remove_skill_pr: async ({ ctx, args, caller, allow }) => {
    assertMutationsAllowed(ctx.bind);
    teams.assertOwner(caller);
    const real = await allow(requireString(args, 'repoPath'));
    const name = requireString(args, 'name');
    return prUrlOf((out) => skillsRemovePr({ dir: skillsDir(real), repo: real, name }, {}, out), 'The remove');
  },
}, {
  update_skill_pr: { action: 'settings-change', target: repoItemTarget('name') },
  // The source may carry credentials (even a refused one is audited): log only scheme, host and path.
  add_skill_pr: { action: 'settings-change', target: (a) => `${repoTarget(a) ?? ''}:${safeUrl(optionalString(a, 'source') ?? '')}` },
  remove_skill_pr: { action: 'settings-change', target: repoItemTarget('name') },
});
