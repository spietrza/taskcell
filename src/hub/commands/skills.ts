// Hub commands: the skills of a repository (src/core/skills.ts): status, usage, and PR-only changes. One module per feature —
// contract, validation and handler live here; `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateSkills } from '../../core/skill-stats.js';
import { parseMetrics } from '../../core/stats.js';
import { cachedResolver, recordedMetrics, skillsAddPr, skillsDiscover, skillsChecked, skillsRemovePr, skillsUpdate, type SkillsPrResult } from '../../core/skills.js';
import type { DiscoveredSkill, PendingSkillPr, RepoSkill } from '../../wire.js';
import { assertHasRemote, defineCommands, githubSlug, optionalString, requireString, repoItemTarget, repoTarget } from '../command-kit.js';
import { safeUrl } from '../audit.js';
import { pullCheckout } from '../pull-checkout.js';
import { listPendingSkillPrs } from '../skills-pending.js';
import { BadRequestError } from '../../sidecar/sidecar.js';

export interface SkillsCommands {
  /** HUB_ONLY, read-only: the skills of a repo (as in the hub checkout's working tree) with their lock status, upstream check and usage. */
  list_repo_skills: { args: { repoPath: string }; result: { skills: RepoSkill[] } };
  /** HUB_ONLY, owner only: `skills update <name> --pr`; the skill only ever changes on a new branch, delivered as a PR. Resolves to its URL. */
  update_skill_pr: { args: { repoPath: string; name: string }; result: { prUrl: string } };
  /** HUB_ONLY, owner only: `skills add` delivered as a PR. A failure carries the command's reason. `paths` adds several skills of
   * one repository in one PR (the folders `discover_skills` found, `ref` pinned to its commit); `source` may be a GitHub or GitLab browse link to a folder. */
  add_skill_pr: { args: { repoPath: string; source: string; ref?: string; path?: string; paths?: string[]; name?: string }; result: { prUrl: string } };
  /** HUB_ONLY, owner only (it reads the network): the skills a repository holds, from its tree listing alone. `commit` is what to pin them to. */
  discover_skills: { args: { repoPath: string; source: string; ref?: string; path?: string }; result: { commit: string; skills: DiscoveredSkill[] } };
  /** HUB_ONLY, owner only (it reads the forge): the project's open skill-add PRs, by branch prefix. GitHub only; others get an empty list. */
  list_pending_skill_prs: { args: { repoPath: string }; result: { prs: PendingSkillPr[] } };
  /** HUB_ONLY, owner only, a write: fast-forward the hub's checkout to origin's default branch, so merged skills appear. Refuses (changing nothing)
   * on a dirty tree, a branch other than the default, or a diverged history; the reason is the error. */
  pull_checkout: { args: { repoPath: string }; result: { updated: boolean } };
  /** HUB_ONLY, owner only: `skills remove` delivered as a PR. */
  remove_skill_pr: { args: { repoPath: string; name: string }; result: { prUrl: string } };
}

// One cache for the hub's lifetime: each pinned skill costs a `git ls-remote`.
const upstreamHead = cachedResolver();

/**
 * `<git-url>[#ref]` as the CLI takes it, or a GitHub / GitLab browse link to a folder (`/tree/<ref>/<path>`, `/blob/<ref>/<path>/SKILL.md`);
 * an explicit `ref` wins over the fragment and the link.
 * shortcut: a ref containing "/" is not parsed from a browse link (its first segment is taken); pass `ref` separately in that case.
 */
export function splitSource(source: string, ref?: string): { source: string; ref?: string; path?: string } {
  const hash = source.indexOf('#');
  if (hash !== -1 && source.slice(hash + 1) === '') throw new BadRequestError('empty #ref in the skill source');
  const bare = hash === -1 ? source : source.slice(0, hash);
  const frag = hash === -1 ? undefined : source.slice(hash + 1);
  const browse = browseLink(bare);
  const found = ref ?? frag ?? browse?.ref;
  return { source: browse?.source ?? bare, ...(found !== undefined ? { ref: found } : {}), ...(browse?.path !== undefined ? { path: browse.path } : {}) };
}

function browseLink(url: string): { source: string; ref: string; path?: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const segs = u.pathname.split('/').filter((x) => x !== '');
  // github.com/<owner>/<repo>/(tree|blob)/<ref>/<path…>; gitlab: <group…>/<project>/-/(tree|blob)/<ref>/<path…>.
  const at = u.hostname === 'github.com' ? 2 : segs.indexOf('-');
  const kind = segs[at + (u.hostname === 'github.com' ? 0 : 1)];
  if (at < 1 || (kind !== 'tree' && kind !== 'blob')) return undefined;
  const rest = segs.slice(at + (u.hostname === 'github.com' ? 1 : 2));
  const [ref, ...path] = rest;
  if (ref === undefined) return undefined;
  if (kind === 'blob' && path[path.length - 1] === 'SKILL.md') path.pop();
  return { source: `${u.origin}/${segs.slice(0, at).join('/')}`, ref, ...(path.length > 0 ? { path: path.join('/') } : {}) };
}

/** `paths`, when given: a non-empty list of folder names, as many as discovery returns at most. */
function optionalPaths(args: Record<string, unknown>): string[] | undefined {
  const v = args.paths;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.length > 50 || v.some((p) => typeof p !== 'string')) throw new BadRequestError('paths must be 1-50 folder names');
  return v as string[];
}

const skillsDir = (repo: string): string => join(repo, 'skills');

/** The PR the command opened; a run that opened none is an error carrying the command's report (why nothing moved). */
function prUrlOf({ prUrl }: SkillsPrResult, what: string, lines: string[] = []): { prUrl: string } {
  if (prUrl === undefined) throw new BadRequestError(`${what} opened no pull request: ${lines.join(' | ').slice(0, 500) || 'nothing to change'}`);
  return { prUrl };
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
  update_skill_pr: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const name = requireString(args, 'name');
    // Always `--pr`, never a dry run: the skill is never updated without opening a PR.
    const lines: string[] = [];
    return prUrlOf(await skillsUpdate({ dir: skillsDir(real), repo: real, name, dryRun: false, pr: true }, {}, (line) => lines.push(line)), 'The update', lines);
  },
  add_skill_pr: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const parsed = splitSource(requireString(args, 'source'), optionalString(args, 'ref'));
    const { source, ref } = parsed;
    const paths = optionalPaths(args);
    // An explicit path beats the one in a pasted browse link.
    const path = optionalString(args, 'path') ?? parsed.path;
    const name = optionalString(args, 'name');
    return prUrlOf(
      await skillsAddPr({
        dir: skillsDir(real),
        repo: real,
        source,
        ...(ref !== undefined ? { ref } : {}),
        ...(paths !== undefined ? { paths } : path !== undefined ? { path } : {}),
        ...(name !== undefined && paths === undefined ? { name } : {}),
      }),
      'The add',
    );
  },
  discover_skills: async ({ args, allow }) => {
    await allow(requireString(args, 'repoPath'));
    const { source, ref, path: linked } = splitSource(requireString(args, 'source'), optionalString(args, 'ref'));
    // A browse link to a folder scopes discovery to it.
    const path = optionalString(args, 'path') ?? linked;
    return skillsDiscover({ source, ...(ref !== undefined ? { ref } : {}), ...(path !== undefined ? { path } : {}) });
  },
  list_pending_skill_prs: async ({ args, allow }) => {
    const slug = await githubSlug(await allow(requireString(args, 'repoPath')));
    return { prs: slug === undefined ? [] : await listPendingSkillPrs(slug) };
  },
  pull_checkout: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    await assertHasRemote(real, false);
    return pullCheckout(real);
  },
  remove_skill_pr: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const name = requireString(args, 'name');
    return prUrlOf(await skillsRemovePr({ dir: skillsDir(real), repo: real, name }), 'The remove');
  },
}, {
  list_repo_skills: { write: false, repo: 'repoPath' },
  update_skill_pr: { write: true, remote: true, owner: true, repo: 'repoPath' },
  add_skill_pr: { write: true, remote: true, owner: true, repo: 'repoPath' },
  // Reads the network (the upstream's tree), writes nothing: the owner's, like browse_dirs.
  discover_skills: { write: false, remote: true, owner: true, repo: 'repoPath' },
  list_pending_skill_prs: { write: false, remote: true, owner: true, repo: 'repoPath' },
  remove_skill_pr: { write: true, remote: true, owner: true, repo: 'repoPath' },
  pull_checkout: { write: true, remote: true, owner: true, repo: 'repoPath' },
}, {
  update_skill_pr: { action: 'settings-change', target: repoItemTarget('name') },
  // The source may carry credentials (even a refused one is audited): log only scheme, host and path.
  add_skill_pr: { action: 'settings-change', target: (a) => `${repoTarget(a) ?? ''}:${safeUrl(optionalString(a, 'source') ?? '')}` },
  remove_skill_pr: { action: 'settings-change', target: repoItemTarget('name') },
  pull_checkout: { action: 'settings-change', target: repoTarget },
});
