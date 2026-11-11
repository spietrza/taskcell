import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa, execaSync } from 'execa';
import { mkdtemp, writeFile, readFile, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerSandboxProvider } from './docker.js';
import { sandboxSecurityOpts } from './limits.js';
import { WorktreeManager } from '../worktree/manager.js';

/**
 * Contract suite for the sandbox interface (1.15.2 follow-ups #745-#748, which all lived in this gap):
 * docker.test.ts's fixture is alpine (busybox tar) as root with no install, while production runs
 * node:24-bookworm (GNU tar) as the non-root agent user, with pnpm, and optionally a read-only rootfs.
 * Every test below runs against both the cheap alpine fixture and the real taskcell-sandbox image, in
 * both rootfs modes, so a GNU-tar- or non-root-specific regression shows up here instead of in a live run.
 */

const BUILD_SH = fileURLToPath(new URL('../../docker/build.sh', import.meta.url));
const TASKCELL_IMAGE = 'taskcell-sandbox:latest';

const hasDocker = ((): boolean => {
  try {
    execaSync('docker', ['version']);
    return true;
  } catch {
    return false;
  }
})();

/**
 * Builds (or pulls) the real sandbox image once, synchronously, before any test in this file runs — the
 * same thing a factory run does via docker/build.sh. Registry/network trouble must not fail the whole
 * file: this resolves to false and the taskcell-specific blocks below skip themselves, leaving the alpine
 * contract to run alone on that host.
 */
const hasTaskcellImage = ((): boolean => {
  if (!hasDocker) return false;
  try {
    execaSync('bash', [BUILD_SH], { timeout: 15 * 60_000 });
    return true;
  } catch {
    return false;
  }
})();

interface Config {
  label: string;
  image: string;
  readOnly: boolean;
  /** Only the real image's GNU tar (bookworm) reproduces tar's benign exit-1 wording; busybox does not. */
  gnuTar: boolean;
  available: boolean;
}

const CONFIGS: Config[] = [
  { label: 'alpine (busybox tar), read-write', image: 'alpine:3.20', readOnly: false, gnuTar: false, available: hasDocker },
  { label: 'alpine (busybox tar), read-only rootfs', image: 'alpine:3.20', readOnly: true, gnuTar: false, available: hasDocker },
  { label: 'taskcell image (GNU tar, non-root agent), read-write', image: TASKCELL_IMAGE, readOnly: false, gnuTar: true, available: hasTaskcellImage },
  { label: 'taskcell image (GNU tar, non-root agent), read-only rootfs', image: TASKCELL_IMAGE, readOnly: true, gnuTar: true, available: hasTaskcellImage },
];

for (const cfg of CONFIGS) {
  const run = cfg.available ? describe : describe.skip;

  run(cfg.label, () => {
    let sb: DockerSandboxProvider;

    beforeAll(async () => {
      sb = new DockerSandboxProvider({
        image: cfg.image,
        workdir: '/workspace',
        security: cfg.readOnly ? { ...sandboxSecurityOpts({}), readOnlyRootfs: true } : sandboxSecurityOpts({}),
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

    if (cfg.gnuTar) {
      // GNU tar's "this is still fine" exit-1 cases (see docker.ts's isBenignTarExit): busybox tar on
      // alpine does not reproduce either wording, which is exactly the gap #745-#748 lived in. These two
      // run copy-back's real tar command against the real image's GNU tar (bookworm) only.
      it('copies out a file that is still being appended to (GNU tar: "file changed as we read it")', async () => {
        const out = await mkdtemp(join(tmpdir(), 'vg-grow-'));
        try {
          await sb.exec('mkdir -p /tmp/grow && echo start > /tmp/grow/log && echo kept > /tmp/grow/other');
          await sb.exec('nohup sh -c "while :; do echo line >> /tmp/grow/log; done" >/dev/null 2>&1 &');
          await sb.copyFileOut('/tmp/grow', out);
          expect(await readFile(join(out, 'other'), 'utf8')).toBe('kept\n');
          expect(await readFile(join(out, 'log'), 'utf8')).toMatch(/^start\n/);
        } finally {
          await sb.exec('pkill -f "echo line" ; rm -rf /tmp/grow');
          await rm(out, { recursive: true, force: true });
        }
      }, 30_000);

      it('copies out a directory while a file inside it vanishes mid-archive (GNU tar: "File removed before we read it")', async () => {
        const out = await mkdtemp(join(tmpdir(), 'vg-vanish-'));
        try {
          await sb.exec('mkdir -p /tmp/vanish && echo keep > /tmp/vanish/keep');
          // A tight create/delete loop for the whole archive: GNU tar's readdir sees the entry, then its
          // open() loses the race often enough to hit the exit-1 path this test exists for.
          await sb.exec('nohup sh -c "while :; do : > /tmp/vanish/tmp; rm -f /tmp/vanish/tmp; done" >/dev/null 2>&1 &');
          await sb.copyFileOut('/tmp/vanish', out);
          expect(await readFile(join(out, 'keep'), 'utf8')).toBe('keep\n');
        } finally {
          await sb.exec('pkill -f "/tmp/vanish/tmp" ; rm -rf /tmp/vanish');
          await rm(out, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}

// Smoke test: the full loop a real run exercises — copy a project in, pnpm install, copy the workspace
// back out the same way syncSandboxToWorktree does (node_modules/.pnpm-store/.git excluded, see
// core/vanguard.ts's COPY_BACK_SKIP), and check the diff a human/PR would see. Runs once, read-write,
// against the real taskcell image only (alpine has neither pnpm nor node).
describe('smoke: pnpm install -> copy-back -> diff', () => {
  const run = hasTaskcellImage ? it : it.skip;

  run('installs with pnpm, copies the workspace back, and the resulting diff shows the lockfile landing', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'vg-smoke-'));
    const staging = await mkdtemp(join(tmpdir(), 'vg-smoke-staging-'));
    const sb = new DockerSandboxProvider({ image: TASKCELL_IMAGE, workdir: '/workspace' });
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

      await sb.copyFileOut('/workspace', staging, { exclude: ['node_modules', '.pnpm-store', '.git'] });
      await cp(staging, worktree, { recursive: true, force: true });

      // Copy-back drops node_modules at the source, same as production (see COPY_BACK_SKIP).
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
