import { encodeProject } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { GhRunner } from '../tasks/github.js';

/** Asks the forge whether CI on a commit is green. */
export interface ForgeCi {
  /**
   * A short description of where the green verdict came from (for the run log), or `undefined` for
   * anything else — failed, pending-only, none, API error — so the caller runs the baseline itself.
   * Never throws.
   */
  greenOn(sha: string): Promise<string | undefined>;
}

const GITHUB_OK = new Set(['success', 'skipped', 'neutral']);

/** GitHub: at least one completed check run, and every completed one `success`/`skipped`/`neutral`. */
export function githubForgeCi(repoSlug: string, gh: GhRunner): ForgeCi {
  return {
    async greenOn(sha) {
      try {
        const out = await gh([
          'api', `repos/${repoSlug}/commits/${sha}/check-runs?per_page=100`, '--paginate',
          '--jq', '.check_runs[] | [.status, .conclusion // ""] | @tsv',
        ]);
        const runs = out.split('\n').filter((l) => l.trim() !== '').map((l) => l.split('\t'));
        const completed = runs.filter(([status]) => status === 'completed');
        if (completed.length === 0 || !completed.every(([, conclusion]) => GITHUB_OK.has(conclusion ?? ''))) return undefined;
        return `GitHub checks on ${sha}`;
      } catch {
        return undefined;
      }
    },
  };
}

/** GitLab: the newest pipeline for the SHA has status `success`. */
export function gitlabForgeCi(project: string, glab: GlabRunner): ForgeCi {
  return {
    async greenOn(sha) {
      try {
        const out = await glab(['api', `projects/${encodeProject(project)}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=1`]);
        const pipelines = JSON.parse(out) as Array<{ id?: number; status?: string }>;
        const latest = pipelines[0];
        if (latest?.status !== 'success') return undefined;
        return `GitLab pipeline ${latest.id} on ${sha}`;
      } catch {
        return undefined;
      }
    },
  };
}
