// Hub command: have a factory PR reviewed again. One module per feature (see CONTRIBUTING.md). GitHub only; GitLab is out of scope.
import { BadRequestError } from '../../sidecar/sidecar.js';
import { defaultGhRunner } from '../../tasks/github.js';
import { hasInFlightLabel, REVIEW_TRIGGER_LABEL, resolveAdds, resolveRemovals } from '../../core/labels.js';
import { REVIEWED_LABEL } from '../../github-labels.js';
import { isFactoryBranch } from '../../worktree/manager.js';
import { assertRepoSlug, itemNumber } from '../needs-you.js';
import { defineCommands, requireString, githubSlug, repoItemTarget } from '../command-kit.js';

export interface RereviewCommands {
  /** HUB_ONLY: put an open factory PR (same-repo, factory branch, no review or revise in flight) back through review: drops
   *  `taskcell:reviewed` and the review trigger and re-adds the trigger, as the hub's `gh` identity. The review starts only
   *  if that identity is an allowed actor of the repo's review workflow, which the hub cannot check. GitHub only. */
  rereview_pr: { args: { repoPath: string; id: string }; result: void };
}

export const commands = defineCommands<RereviewCommands>({
  rereview_pr: async ({ ctx, args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const repoSlug = await githubSlug(real);
    if (repoSlug === undefined) throw new BadRequestError('rereview_pr: this project has no GitHub remote');
    assertRepoSlug(repoSlug);
    const number = itemNumber(repoSlug, id);
    const gh = ctx.gh ?? defaultGhRunner;
    const pr = JSON.parse(await gh(['pr', 'view', number, '--repo', repoSlug, '--json', 'state,labels,headRefName,isCrossRepository'])) as {
      state: string;
      labels: { name: string }[];
      headRefName: string;
      isCrossRepository: boolean;
    };
    const have = pr.labels.map((l) => l.name);
    if (pr.state !== 'OPEN') throw new BadRequestError(`${id} is not open`);
    if (pr.isCrossRepository) throw new BadRequestError(`${id} is from a fork`);
    if (!isFactoryBranch(pr.headRefName)) throw new BadRequestError(`${id} is not on a factory branch`);
    if (hasInFlightLabel(have)) throw new BadRequestError(`${id} is being reviewed or revised`);
    // The spelling the repo already has (a workflow may gate on the old name only); created only when it has neither.
    const [trigger = REVIEW_TRIGGER_LABEL] = await resolveAdds([REVIEW_TRIGGER_LABEL], repoSlug, gh, [REVIEW_TRIGGER_LABEL]);
    const remove = await resolveRemovals([REVIEWED_LABEL, trigger], async () => have);
    if (remove.length > 0) await gh(['pr', 'edit', number, '--repo', repoSlug, ...remove.flatMap((l) => ['--remove-label', l])]);
    await gh(['pr', 'edit', number, '--repo', repoSlug, '--add-label', trigger]);
    return null;
  },
}, {
  rereview_pr: { write: true, remote: true, repo: 'repoPath' },
}, {
  rereview_pr: { action: 'pr-rereview', target: repoItemTarget('id') },
});
