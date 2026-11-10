import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, it, expect } from 'vitest';

// Exercises docker/build.sh end to end against a fake `docker` and `git` on PATH: the pull-first path
// must tag the published image under both tags the script builds today and never reach `docker build`,
// and every failure path (no published tag, no git, a failing or dirty `git status`) must still build.
const BUILD_SH = fileURLToPath(new URL('../../docker/build.sh', import.meta.url));
const TREE = 'ffeedd00';
const PUBLISHED = `ghcr.io/spietrza/taskcell-sandbox:${TREE}`;
const DIGEST = 'ghcr.io/spietrza/taskcell-sandbox@sha256:abc123';

/** Fake binary that appends its argv to $ARGS_LOG, one invocation per line. */
const fake = (body: string): string => `#!/bin/sh\necho "$@" >>"$ARGS_LOG"\n${body}\n`;

const FAKE_DOCKER = fake(`case "$1" in
  pull) [ -z "\${FAKE_PULL_FAILS:-}" ] || exit 1 ;;
  inspect) echo ${DIGEST} ;;
esac
exit 0`);
// `gh attestation verify oci://<digest> ...`: provenance check, failing on demand.
const FAKE_GH = fake('[ -z "${FAKE_ATTEST_FAILS:-}" ] || exit 1\nexit 0');
// `git -C <dir> <subcommand> ...`: rev-parse yields the docker/ tree hash, status the dirty state.
const FAKE_GIT = fake(`shift 2
case "$1" in
  rev-parse) [ -z "\${FAKE_NO_GIT:-}" ] || exit 128; echo ${TREE} ;;
  status) [ -z "\${FAKE_STATUS_FAILS:-}" ] || exit 129; [ -z "\${FAKE_DIRTY:-}" ] || echo " M docker/Dockerfile" ;;
esac
exit 0`);

/** Run build.sh with the fakes first on PATH; returns one entry per fake invocation, argv joined. */
async function runBuild(env: Record<string, string>): Promise<{ calls: string[]; stdout: string }> {
  const bin = await mkdtemp(join(tmpdir(), 'build-sh-'));
  try {
    const log = join(bin, 'args.log');
    await writeFile(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    await writeFile(join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
    await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    await writeFile(log, '');
    // extendEnv: false — an ambient CLAUDE_CLI_VERSION/LINEAR_RETRY in the developer's shell is
    // exactly what the script treats as "build, do not pull", so inheriting it would flip the cases.
    const result = await execa('bash', [BUILD_SH], {
      env: { ...env, ARGS_LOG: log, PATH: `${bin}${delimiter}${process.env.PATH}` },
      extendEnv: false,
    });
    const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    return { calls, stdout: result.stdout };
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

describe('docker/build.sh pull-first', () => {
  it('pulls the published tag, verifies its digest and tags that digest instead of building', async () => {
    const { calls, stdout } = await runBuild({});

    expect(calls).toContain(`pull ${PUBLISHED}`);
    expect(calls.some((call) => call.startsWith(`attestation verify oci://${DIGEST} `))).toBe(true);
    expect(calls).toContain(`tag ${DIGEST} taskcell-sandbox:latest`);
    expect(calls).toContain(`tag ${DIGEST} vanguard-sandbox:latest`);
    expect(calls.filter((call) => call.startsWith('build '))).toEqual([]);
    expect(stdout).toContain('pomijam build');
  });

  it.each([
    ['the tag is not published', { FAKE_PULL_FAILS: '1' }],
    ['the pulled image has no verifiable provenance', { FAKE_ATTEST_FAILS: '1' }],
    ['git cannot resolve the docker/ tree', { FAKE_NO_GIT: '1' }],
    ['docker/ has uncommitted changes', { FAKE_DIRTY: '1' }],
    ['the dirty check itself errors', { FAKE_STATUS_FAILS: '1' }],
    ['a build arg is overridden', { LINEAR_RETRY: '1' }],
  ])('builds locally when %s', async (_case, env) => {
    const { calls, stdout } = await runBuild(env);

    const build = calls.find((call) => call.startsWith('build '));
    expect(build).toContain('-t taskcell-sandbox:latest -t vanguard-sandbox:latest');
    expect(calls.filter((call) => call.startsWith('tag '))).toEqual([]);
    expect(stdout).toContain('Zbudowano taskcell-sandbox:latest');
  });
});
