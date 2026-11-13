// Hub commands: the "Needs you" read model and its reply/merge actions. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { listNeedsYou, mergeNeedsYou, replyNeedsYou, MAX_COMMENT_FETCHES } from '../needs-you.js';
import { readAppConfig } from '../app-config.js';
import * as projects from '../projects.js';
import type { MigrateLabelsReport, NeedsYouItem, RepoReadFailure, RepoStamp } from '../../wire.js';
import { migrateLabels } from '../../runners/migrate-labels.js';
import { defineCommands, requireString, githubSlug, repoItemTarget } from '../command-kit.js';

export interface NeedsYouCommands {
  /** HUB_ONLY: rename the repo's old `vanguard:*` labels to `taskcell:*` (as `taskcell migrate-labels`). Dry-run unless `apply`. */
  migrate_labels: { args: { repoPath: string; apply?: boolean }; result: MigrateLabelsReport };
  /** HUB_ONLY: the hub "Needs you" read model (src/hub/needs-you.ts) — `gh` and labels only, no model call. */
  list_needs_you: { args: { repoPath: string }; result: { items: NeedsYouItem[] } };
  /** HUB_ONLY: `list_needs_you` across every hub repository, each item stamped with its repository. */
  list_needs_you_all: { args: { teamId?: string } | undefined; result: { items: (NeedsYouItem & RepoStamp)[]; failures: RepoReadFailure[] } };
  /** HUB_ONLY: post a reply with the caller's own `gh` identity and move the item on. */
  reply_needs_you: { args: { repoPath: string; id: string; kind: 'issue' | 'pr'; body: string }; result: void };
  /** HUB_ONLY: merge a waiting PR (refused when not in "Needs you" or required checks are not green). */
  merge_needs_you: { args: { repoPath: string; id: string }; result: void };
}

export const commands = defineCommands<NeedsYouCommands>({
  migrate_labels: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const apply = args.apply === true;
    // A dry-run only lists labels; renaming them is a remote mutation.
    if (apply) assertMutationsAllowed(ctx.bind);
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('migrate_labels: this project has no GitHub remote');
    return migrateLabels({ repoSlug, apply, log: () => {} });
  },
  list_needs_you: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const repoSlug = await githubSlug(real);
    // Not a GitHub remote — nothing for this read model to show.
    return { items: repoSlug === undefined ? [] : await listNeedsYou(repoSlug) };
  },
  list_needs_you_all: async ({ ctx, allow, scope }) => {
    // One comment-fetch budget for every repository, not MAX_COMMENT_FETCHES each.
    const commentBudget = { remaining: MAX_COMMENT_FETCHES };
    const { items, failures } = await projects.listAcrossProjects(
      ctx.configDir,
      allow,
      async (real) => {
        const repoSlug = await githubSlug(real);
        return repoSlug === undefined ? [] : listNeedsYou(repoSlug, undefined, { commentBudget });
      },
      await scope(),
    );
    return { items, failures };
  },
  reply_needs_you: async ({ ctx, args, allow }) => {
    // Comments under the hub's `gh` identity and adds a trigger label — a remote mutation.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const kind = requireString(args, 'kind');
    if (kind !== 'issue' && kind !== 'pr') throw new BadRequestError("kind must be 'issue' or 'pr'");
    const body = requireString(args, 'body');
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('reply_needs_you: this project has no GitHub remote');
    // The slug comes from the allowlisted repo, never from `id` — `replyNeedsYou` refuses an `id`
    // naming any other repo, so a reply can only ever touch a registered project.
    // The repo's configured trigger label (app.json `label`, as api_create_task applies), else the default.
    const { label } = await readAppConfig(real);
    await replyNeedsYou(repoSlug, id, kind, body, undefined, label?.trim() ? label : undefined);
    return null;
  },
  merge_needs_you: async ({ ctx, args, allow }) => {
    // Merges under the hub's `gh` identity — a remote mutation.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('merge_needs_you: this project has no GitHub remote');
    await mergeNeedsYou(repoSlug, id);
    return null;
  },
}, {
  reply_needs_you: { action: 'needs-reply', target: repoItemTarget('id') },
  merge_needs_you: { action: 'needs-merge', target: repoItemTarget('id') },
});
