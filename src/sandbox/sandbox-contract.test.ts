import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa, execaSync } from 'execa';
import { mkdtemp, writeFile, readFile, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandboxProvider, isBenignTarExit } from './docker.js';
import { resolveSandboxProfile } from './limits.js';
import { prunedNames } from './copy-back.js';
import { WorktreeManager } from '../worktree/manager.js';

/**
 * Contract suite for the sandbox interface (1.15.2 follow-ups #745-#748, which all lived in this gap):
 * docker.test.ts's fixture is alpine (busybox tar) as root with no install, while production runs
 * node:24-bookworm (GNU tar) as the non-root agent user, with pnpm, and optionally a read-only rootfs.
 * Everything below runs against the real taskcell-sandbox image, in both rootfs modes, so a GNU-tar- or
 * non-root-specific regression shows up here instead of in a live run.
 *
 * Opt-in via `TASKCELL_CONTRACT=1`: these tests need the real image to already exist locally. They never
 * build or pull it — `docker/build.sh` retags local images, which is not a test's business — so build it
 * by hand first. Without the opt-in the file says why it skipped and runs nothing; with it, a missing
 * image fails the run rather than quietly passing an empty suite.
 */

const CONTRACT_ENV = 'TASKCELL_CONTRACT';
const TASKCELL_IMAGE = 'taskcell-sandbox:latest';

const optedIn = process.env[CONTRACT_ENV] === '1';

const probe = (args: string[]): boolean => {
  try {
    execaSync('docker', args);
    return true;
  } catch {
    return false;
  }
};

/** Why this file is not running the real-image contract, or undefined when it is. */
const skipReason = ((): string | undefined => {
  if (!optedIn) return `${CONTRACT_ENV} is not set to 1 (the real-image contract is opt-in)`;
  if (!probe(['version'])) return 'docker is not available on this host';
  if (!probe(['image', 'inspect', TASKCELL_IMAGE])) {
    return `${TASKCELL_IMAGE} is not present locally — build it first with docker/build.sh`;
  }
  return undefined;
})();

if (skipReason !== undefined) {
  // Say it out loud: a file that silently ran nothing reads like a pass in CI output.
  console.warn(`[sandbox-contract] skipping the real-image contract: ${skipReason}`);
}

// Opting in asks for the real image specifically, so a missing image is a failed run, not a skip.
describe.runIf(optedIn && skipReason !== undefined)('sandbox contract preconditions', () => {
  it('has the real sandbox image available', () => {
    expect.fail(`${CONTRACT_ENV}=1 but ${skipReason}`);
  });
});

const suite = skipReason === undefined ? describe : describe.skip;

/**
 * Runs copy-back's exact tar command against the same container, so the test can see the stderr
 * `copyFileOut` swallows: it treats GNU tar's benign exit 1 as success (see `isBenignTarExit`) and
 * reports nothing, which would let a race test pass without the race ever firing.
 */
async function tarStderr(sb: DockerSandboxProvider, path: string): Promise<{ exitCode: number; stderr: string }> {
  const res = await execa('docker', ['exec', '-u', '0', `vg-${sb.id}`, 'tar', '-C', path, '-cf', '-', '.'], {
    stdout: 'ignore',
    reject: false,
  });
  return { exitCode: res.exitCode ?? -1, stderr: res.stderr };
}

interface Race {
  title: string;
  /** Directory the background loop churns while copy-back archives it. */
  dir: string;
  /** Seeds `dir` with the files copy-back must still bring out intact. */
  setup: string;
  /** Body of the background loop that races the archive. */
  loop: string;
  /** GNU tar's wording for this race; missing from stderr means it never fired on this host. */
  wording: RegExp;
  /** How to describe that miss when skipping. */
  missed: string;
  /** What copy-back must have brought out, as file name -> expected contents. */
  expected: Record<string, RegExp>;
}

const RACES: Race[] = [
  {
    title: 'copies out a file that is still being appended to (GNU tar: "file changed as we read it")',
    dir: '/tmp/grow',
    setup: 'echo start > /tmp/grow/log && echo kept > /tmp/grow/other',
    loop: 'while :; do echo line >> /tmp/grow/log; done',
    wording: /file changed as we read it/,
    missed: 'tar never caught the growing file mid-read',
    expected: { other: /^kept\n$/, log: /^start\n/ },
  },
  {
    title: 'copies out a directory while a file inside it vanishes mid-archive (GNU tar: "File removed before we read it")',
    dir: '/tmp/vanish',
    setup: 'echo keep > /tmp/vanish/keep',
    // A tight create/delete loop for the whole archive: GNU tar's readdir sees the entry, then its
    // open() loses the race often enough to hit the exit-1 path this test exists for.
    loop: 'while :; do : > /tmp/vanish/tmp; rm -f /tmp/vanish/tmp; done',
    wording: /File removed before we read it/,
    missed: 'tar never lost the open() race',
    expected: { keep: /^keep\n$/ },
  },
];

for (const readOnly of [false, true]) {
  suite(`taskcell image (GNU tar, non-root agent), ${readOnly ? 'read-only rootfs' : 'read-write'}`, () => {
    let sb: DockerSandboxProvider;

    beforeAll(async () => {
      sb = new DockerSandboxProvider({
        image: TASKCELL_IMAGE,
        workdir: '/workspace',
        profile: resolveSandboxProfile({ TASKCELL_SANDBOX_READONLY: readOnly ? '1' : '0' } as NodeJS.ProcessEnv),
      });
      await sb.start();
    }, 120_000);

    afterAll(async () => {
      await sb.destroy();
    }, 60_000);

    it('execs a command inside the sandbox and reports its real exit code', async () => {
      const ok = await sb.exec('echo hi');
      expect(ok.stdout.trim()).toBe('hi');
      expect(ok.exitCode).toBe(0);

      const failed = await sb.exec('exit 3');
      expect(failed.exitCode).toBe(3);
    }, 30_000);

    it('round-trips a directory through copyIn/copyFileOut, editable by the sandbox user afterward', async () => {
      const host = await mkdtemp(join(tmpdir(), 'vg-contract-'));
      const out = await mkdtemp(join(tmpdir(), 'vg-contract-out-'));
      try {
        await writeFile(join(host, 'a.txt'), 'alpha');
        await sb.copyIn(host, '/workspace/in');
        const edit = await sb.exec('echo beta >> /workspace/in/a.txt && cat /workspace/in/a.txt');
        expect(edit.exitCode, edit.stderr).toBe(0);
        expect(edit.stdout).toBe('alphabeta');

        await sb.copyFileOut('/workspace/in', out);
        expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('alphabeta\n');
      } finally {
        await sb.exec('rm -rf /workspace/in');
        await rm(host, { recursive: true, force: true });
        await rm(out, { recursive: true, force: true });
      }
    }, 60_000);

    // GNU tar's "this is still fine" exit-1 cases (see docker.ts's isBenignTarExit): busybox tar on
    // alpine does not reproduce either wording, which is exactly the gap #745-#748 lived in. These two
    // run copy-back's real tar command against the real image's GNU tar (bookworm).
    // The image has no pkill, so each background loop's PID goes to a pidfile (outside the directory
    // being archived) and the cleanup kills exactly that process.
    for (const race of RACES) {
      it(race.title, async ({ skip }) => {
        const out = await mkdtemp(join(tmpdir(), 'vg-race-'));
        const pidfile = `${race.dir}.pid`;
        try {
          const setup = await sb.exec(`mkdir -p ${race.dir} && ${race.setup}`);
          expect(setup.exitCode, setup.stderr).toBe(0);
          const loop = await sb.exec(`nohup sh -c "${race.loop}" >/dev/null 2>&1 & echo $! > ${pidfile}`);
          expect(loop.exitCode, loop.stderr).toBe(0);

          await sb.copyFileOut(race.dir, out);
          for (const [name, contents] of Object.entries(race.expected)) {
            expect(await readFile(join(out, name), 'utf8')).toMatch(contents);
          }

          const archive = await tarStderr(sb, race.dir);
          if (!race.wording.test(archive.stderr)) {
            skip(`${race.missed} on this host: the benign exit-1 path was not exercised`);
          }
          expect(isBenignTarExit(archive.exitCode, archive.stderr), archive.stderr).toBe(true);
        } finally {
          await sb.exec(`kill "$(cat ${pidfile})" 2>/dev/null; rm -rf ${race.dir} ${pidfile}`);
          await rm(out, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}

// Smoke test: the full loop a real run exercises — copy a project in, pnpm install, copy the workspace
// back out the same way syncSandboxToWorktree does (node_modules/.pnpm-store/.git excluded, see
// copy-back.ts's PATH_POLICY), and check the diff a human/PR would see. Runs once, read-write,
// against the real taskcell image.
suite('smoke: pnpm install -> copy-back -> diff', () => {
  it('installs with pnpm, copies the workspace back, and the resulting diff shows the lockfile landing', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'vg-smoke-'));
    const staging = await mkdtemp(join(tmpdir(), 'vg-smoke-staging-'));
    const sb = new DockerSandboxProvider({ image: TASKCELL_IMAGE, workdir: '/workspace', profile: resolveSandboxProfile({}) });
    try {
      await execa('git', ['init', '-q'], { cwd: worktree });
      await execa('git', ['config', 'user.email', 'vanguard@example.com'], { cwd: worktree });
      await execa('git', ['config', 'user.name', 'vanguard'], { cwd: worktree });
      await writeFile(
        join(worktree, 'package.json'),
        `${JSON.stringify({ name: 'contract-fixture', version: '0.0.0', private: true }, null, 2)}\n`,
      );
      await execa('git', ['add', '-A'], { cwd: worktree });
      await execa('git', ['commit', '-q', '-m', 'baseline'], { cwd: worktree });

      await sb.start();
      await sb.copyIn(join(worktree, 'package.json'), '/workspace/package.json');
      // --offline: zero dependencies to resolve, so the lockfile materialises without reaching a registry.
      const install = await sb.exec('pnpm install --offline');
      expect(install.exitCode, install.stderr).toBe(0);
      expect(await sb.exists('/workspace/pnpm-lock.yaml')).toBe(true);
      expect(await sb.exists('/workspace/node_modules')).toBe(true);

      await sb.copyFileOut('/workspace', staging, { exclude: prunedNames() });
      await cp(staging, worktree, { recursive: true, force: true });

      // Copy-back drops node_modules at the source, same as production (see copy-back.ts's PATH_POLICY).
      await expect(stat(join(worktree, 'node_modules'))).rejects.toThrow();

      const wm = new WorktreeManager(worktree);
      const diff = await wm.diff(worktree);
      expect(diff).toContain('pnpm-lock.yaml');
    } finally {
      await sb.destroy();
      await rm(worktree, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }, 180_000);
});
