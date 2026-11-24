// Hub commands: the "Needs you" read model and its reply/merge actions. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { mergeNeedsYou, MAX_COMMENT_FETCHES, needsYouComment, replyNeedsYou } from '../needs-you.js';
import { readAppConfig } from '../app-config.js';
import { answerCard, cachedNeedsYou, forgetBoardWaiting } from '../asking.js';
import * as projects from '../projects.js';
import type { MigrateLabelsReport, NeedsYouItem, RepoReadFailure, RepoStamp } from '../../wire.js';
import { migrateLabels } from '../../runners/migrate-labels.js';
import { actorOf, defineCommands, requireString, githubSlug, repoItemTarget, repoTarget } from '../command-kit.js';

export interface NeedsYouCommands {
  /** HUB_ONLY: rename the repo's old `vanguard:*` labels to `taskcell:*` (as `taskcell migrate-labels`). Dry-run unless `apply`. */
  migrate_labels: { args: { repoPath: string; apply?: boolean }; result: MigrateLabelsReport };
  /** HUB_ONLY: the hub "Needs you" read model (src/hub/needs-you.ts) — `gh` and labels only, no model call. */
  list_needs_you: { args: { repoPath: string }; result: { items: NeedsYouItem[]; unchecked?: true } };
  /** HUB_ONLY: the factory's last comment on one waiting issue or PR (the lists carry none), for the view of the item that is opened. */
  needs_you_comment: { args: { repoPath: string; id: string; kind: 'issue' | 'pr' }; result: { lastComment?: { author: string; body: string }; ask?: 'question' | 'too-vague' } };
  /** HUB_ONLY: `list_needs_you` across every hub repository, each item stamped with its repository. */
  list_needs_you_all: { args: { teamId?: string } | undefined; result: { items: (NeedsYouItem & RepoStamp)[]; failures: RepoReadFailure[] } };
  /** HUB_ONLY: post a reply with the caller's own `gh` identity and move the item on. `card`: answer a card whose run stopped
   *  to ask (src/hub/asking.ts): a hub-board card takes the answer into its body and goes back to To do. */
  reply_needs_you: { args: { repoPath: string; id: string; kind: 'issue' | 'pr' | 'card'; body: string }; result: void };
  /** HUB_ONLY: merge a waiting PR (refused when not in "Needs you", verify failed on it, or required checks are not green). */
  merge_needs_you: { args: { repoPath: string; id: string }; result: void };
}

export const commands = defineCommands<NeedsYouCommands>({
  migrate_labels: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const apply = args.apply === true;
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('migrate_labels: this project has no GitHub remote');
    return migrateLabels({ repoSlug, apply, log: () => {} });
  },
  list_needs_you: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const { items, unchecked } = await cachedNeedsYou(ctx.configDir, real, ctx.gh, { remaining: MAX_COMMENT_FETCHES });
    return { items, ...(unchecked ? { unchecked } : {}) };
  },
  needs_you_comment: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const kind = requireString(args, 'kind');
    if (kind !== 'issue' && kind !== 'pr') throw new BadRequestError("kind must be 'issue' or 'pr'");
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('needs_you_comment: this project has no GitHub remote');
    return needsYouComment(repoSlug, requireString(args, 'id'), kind, ctx.gh);
  },
  list_needs_you_all: async ({ ctx, allow, scope }) => {
    // Named as registered (the path the UI knows the project by), not as resolved.
    const registered = new Map<string, string>();
    const unchecked: string[] = [];
    // One comment-fetch budget for every repository, not MAX_COMMENT_FETCHES each.
    const commentBudget = { remaining: MAX_COMMENT_FETCHES };
    const { items, failures } = await projects.listAcrossProjects(
      ctx.configDir,
      async (path) => {
        const real = await allow(path);
        registered.set(real, path);
        return real;
      },
      async (real) => {
        const read = await cachedNeedsYou(ctx.configDir, real, ctx.gh, commentBudget);
        if (read.unchecked) unchecked.push(registered.get(real) ?? real);
        return read.items;
      },
      await scope(),
    );
    // A repository whose read failed still lists its last good items; the failure says they may be stale.
    for (const repoPath of unchecked) failures.push({ repoPath, repoName: projects.repoDisplayName(repoPath), error: 'Could not check GitHub; showing the last known items' });
    return { items, failures };
  },
  reply_needs_you: async ({ ctx, caller, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const kind = requireString(args, 'kind');
    if (kind !== 'issue' && kind !== 'pr' && kind !== 'card') throw new BadRequestError("kind must be 'issue', 'pr' or 'card'");
    const body = requireString(args, 'body');
    const repoSlug = await githubSlug(real);
    if (kind === 'card') {
      const { label } = await readAppConfig(real);
      // The board's kept read of what waits is dropped either way: answered, the item no longer waits.
      try {
        await answerCard({ configDir: ctx.configDir, repoPath: real, id, body, owner: { actor: actorOf(ctx), caller }, ...(repoSlug !== undefined ? { repoSlug } : {}), ...(label?.trim() ? { agentLabel: label } : {}) });
      } finally {
        forgetBoardWaiting(real);
      }
      return null;
    }
    if (repoSlug === undefined) throw new BadRequestError('reply_needs_you: this project has no GitHub remote');
    // The slug comes from the allowlisted repo, never from `id` — `replyNeedsYou` refuses an `id`
    // naming any other repo, so a reply can only ever touch a registered project.
    // The repo's configured trigger label (app.json `label`, as api_create_task applies), else the default.
    const { label } = await readAppConfig(real);
    try {
      await replyNeedsYou(repoSlug, id, kind, body, undefined, label?.trim() ? label : undefined);
    } finally {
      forgetBoardWaiting(real);
    }
    return null;
  },
  merge_needs_you: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('merge_needs_you: this project has no GitHub remote');
    try {
      await mergeNeedsYou(repoSlug, id);
    } finally {
      forgetBoardWaiting(real);
    }
    return null;
  },
}, {
  // A dry run only lists labels; renaming them is a remote mutation.
  migrate_labels: { write: true, remote: true, remoteWhen: (a) => a.apply === true, repo: 'repoPath' },
  list_needs_you: { write: false, repo: 'repoPath' },
  needs_you_comment: { write: false, repo: 'repoPath' },
  list_needs_you_all: { write: false },
  reply_needs_you: { write: true, remote: true, repo: 'repoPath' },
  merge_needs_you: { write: true, remote: true, repo: 'repoPath' },
}, {
  // A dry run only lists labels and writes nothing, so only `apply: true` is audited.
  migrate_labels: { action: 'labels-migrate', target: repoTarget, applies: (a) => a.apply === true },
  reply_needs_you: { action: 'needs-reply', target: repoItemTarget('id') },
  merge_needs_you: { action: 'needs-merge', target: repoItemTarget('id') },
});
