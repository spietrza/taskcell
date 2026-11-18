import { execa } from 'execa';
import { resolveTargetBase } from '../core/base-branch.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import { hostGitArgs } from '../worktree/host-git.js';

const git = (repo: string, args: string[]) =>
  execa('git', hostGitArgs(args), { cwd: repo, reject: false, env: { GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 });

/**
 * Fast-forward the hub's checkout to its remote default branch, so merged skills show up. Refuses (changing nothing) unless the
 * checkout is on the default branch with a clean tree (untracked files count) and the remote only moved ahead; never switches
 * branches. Argument arrays only; `merge --ff-only` is the one step that writes.
 * @throws BadRequestError with the reason.
 */
export async function pullCheckout(repo: string): Promise<{ updated: boolean }> {
  const base = await resolveTargetBase(repo, []);
  const head = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = String(head.stdout).trim();
  if (head.exitCode !== 0 || current !== base) {
    throw new BadRequestError(`The checkout is on ${head.exitCode === 0 ? `"${current}"` : 'no branch'}, not on ${base}; the hub never switches branches. Switch it to ${base} yourself.`);
  }
  const status = await git(repo, ['status', '--porcelain']);
  if (status.exitCode !== 0) throw new BadRequestError(`Could not read the checkout's status: ${String(status.stderr).slice(0, 200)}`);
  if (String(status.stdout).trim() !== '') throw new BadRequestError('The checkout has uncommitted changes; commit or discard them first. Nothing was changed.');
  const fetched = await git(repo, ['fetch', '--quiet', 'origin', base]);
  if (fetched.exitCode !== 0) throw new BadRequestError(`Could not fetch ${base} from origin: ${String(fetched.stderr).slice(0, 200)}`);
  const before = String((await git(repo, ['rev-parse', 'HEAD'])).stdout).trim();
  const merged = await git(repo, ['merge', '--ff-only', 'FETCH_HEAD']);
  if (merged.exitCode !== 0) throw new BadRequestError(`The checkout has diverged from origin/${base} (or cannot fast-forward); resolve it by hand. Nothing was changed.`);
  return { updated: String((await git(repo, ['rev-parse', 'HEAD'])).stdout).trim() !== before };
}
