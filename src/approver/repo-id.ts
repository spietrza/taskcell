import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';

/**
 * The repository's GraphQL node id: it survives a rename and a transfer, which the `owner/name` slug does not.
 * Recorded on every decision so the scorecard can follow a repository across a rename; undefined when gh cannot say.
 */
export async function repoNodeId(slug: string, gh: GhRunner = defaultGhRunner): Promise<string | undefined> {
  try {
    const id = (await gh(['api', `repos/${slug}`, '--jq', '.node_id'])).trim();
    return id === '' ? undefined : id;
  } catch {
    return undefined;
  }
}
