import { execa } from 'execa';
import type { DockerRunner } from './docker.js';

/** GHCR repository the push-to-main workflow publishes `docker/` builds to, tagged by the tree hash of `docker/`. */
export const GHCR_SANDBOX_REPO = 'ghcr.io/spietrza/taskcell-sandbox';

const defaultRunner: DockerRunner = async (cmd, args, opts) => {
  const { stdout } = await execa(cmd, args, { cwd: opts.cwd });
  return { stdout };
};

/** Git tree hash of `docker/` at `ref`: the tag the publish workflow pushes, identical across commits that leave `docker/` untouched. */
export async function dockerDirHash(repoRoot: string, ref = 'HEAD', run: DockerRunner = defaultRunner): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', `${ref}:docker`], { cwd: repoRoot });
  return stdout.trim();
}

export interface PullOrBuildResult {
  image: string;
  digest: string;
  /** True when no published tag existed and the image was built from `dockerDir` instead. */
  built: boolean;
}

/**
 * Pull-first: the GHCR tag for the current `docker/` hash is normally already published, so a run
 * must not pay a from-scratch build (npm + GitHub Releases) on its critical path (#657). Builds
 * locally only when the pull fails (hash not pushed yet, or no registry access).
 */
export async function pullOrBuildSandboxImage(hash: string, dockerDir: string, run: DockerRunner = defaultRunner): Promise<PullOrBuildResult> {
  const image = `${GHCR_SANDBOX_REPO}:${hash}`;
  let built = false;
  try {
    await run('docker', ['pull', image], { cwd: dockerDir });
  } catch {
    await run('docker', ['build', '-t', image, dockerDir], { cwd: dockerDir });
    built = true;
  }
  const { stdout } = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { cwd: dockerDir });
  return { image, digest: stdout.trim(), built };
}
