import { defaultGhRunner, type GhRunner } from '../tasks/github.js';
import type { PendingSkillPr } from '../wire.js';

/** The branch prefix `skills add --pr` opens its PRs on (task `skills-add`). */
const ADD_BRANCH_PREFIX = 'chore/taskcell-skills-add-';

/** `chore(skills): add a, b` -> ['a', 'b']; a title cut at 100 characters keeps what is left. */
const namesOf = (title: string): string[] => title.replace(/^chore\(skills\): add\s*/, '').split(',').map((n) => n.trim()).filter((n) => n !== '');

/** Open skill-add PRs of `repoSlug`, found by branch prefix: the skills they add are not in the checkout until they merge. */
export async function listPendingSkillPrs(repoSlug: string, gh: GhRunner = defaultGhRunner): Promise<PendingSkillPr[]> {
  const out = await gh(['pr', 'list', '--repo', repoSlug, '--state', 'open', '-L', '100', '--json', 'number,url,title,headRefName']);
  return (JSON.parse(out) as { number: number; url: string; title: string; headRefName: string }[])
    .filter((p) => p.headRefName.startsWith(ADD_BRANCH_PREFIX))
    .map((p) => ({ number: p.number, url: p.url, names: namesOf(p.title) }));
}
