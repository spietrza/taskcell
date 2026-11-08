import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, writeFile, chmod, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// docker/retry.sh wraps a release download inside the sandbox image build (docker/Dockerfile) and
// docker/build-ci.sh wraps the image build itself for CI -- both address #657, where a GitHub
// Releases 504 outage failed every factory run before any agent work started. Exercised directly as
// shell scripts (no Docker needed): a fake `cmd`/`docker` on PATH stands in for the real download or
// build, and a fake `gh` proves the scripts never touch an issue/PR label or comment.
const DOCKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker');
const RETRY_SH = join(DOCKER_DIR, 'retry.sh');
const BUILD_CI_SH = join(DOCKER_DIR, 'build-ci.sh');

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tmpBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vg-retry-'));
  cleanups.push(dir);
  return dir;
}

/** Writes an executable script into `dir` and returns its path. */
async function writeScript(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return path;
}

/** A `gh` stub that records every invocation, so a test can assert it was never run. */
async function ghSentinel(dir: string): Promise<{ wasCalled: () => Promise<boolean> }> {
  const ghLog = join(dir, 'gh.log');
  await writeScript(dir, 'gh', `echo "$@" >> ${ghLog}\nexit 0\n`);
  return {
    wasCalled: async () => {
      try {
        await access(ghLog);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Shell snippet that increments a persistent call counter in `counter` on each invocation. */
const countCall = (counter: string): string => `n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 )); echo "$n" > ${counter}\n`;

describe('docker/retry.sh', () => {
  it('retries a simulated 504 on the first attempt and succeeds on the second', async () => {
    const dir = await tmpBin();
    const counter = join(dir, 'count');
    const cmd = await writeScript(
      dir,
      'flaky',
      countCall(counter) + `if [ "$n" -eq 1 ]; then echo "HTTP/1.1 504 Gateway Timeout" >&2; exit 1; fi\n` + `echo ok\n`,
    );
    const { wasCalled } = await ghSentinel(dir);

    const result = await execa(RETRY_SH, ['5', '0', cmd], { reject: false, env: { PATH: `${dir}:${process.env['PATH']}` } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok');
    expect((await readFile(counter, 'utf8')).trim()).toBe('2');
    expect(await wasCalled()).toBe(false);
  });

  it('gives up after max attempts on a persistent transient failure and reports it as infrastructure, not a task failure', async () => {
    const dir = await tmpBin();
    const counter = join(dir, 'count');
    const cmd = await writeScript(dir, 'always-504', countCall(counter) + `echo "HTTP/1.1 504 Gateway Timeout" >&2\nexit 1\n`);
    const { wasCalled } = await ghSentinel(dir);

    const result = await execa(RETRY_SH, ['3', '0', cmd], { reject: false, env: { PATH: `${dir}:${process.env['PATH']}` } });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('VANGUARD_INFRA_FAILURE');
    expect((await readFile(counter, 'utf8')).trim()).toBe('3');
    // The point of classifying it as infrastructure: nothing here ever calls out to GitHub.
    expect(await wasCalled()).toBe(false);
  });

  it.each([
    ['504 Gateway Error', true],
    ['download failed: HTTP 503', true],
    ['curl: (22) The requested URL returned error: 503', true],
    ['npm error code E429', true],
    ['unexpected status code 502', true],
    ['connection reset by peer', true],
    ['failed at Dockerfile:429', false],
    ['sha256:abc504def; command exited with code 1', false],
    ['package@1.500.0 not found', false],
  ])('classifies %s as transient=%s', async (message, transient) => {
    const result = await execa(RETRY_SH, ['1', '0', 'sh', '-c', 'echo "$1" >&2; exit 7', 'sh', message], { reject: false });
    expect(result.exitCode).toBe(7);
    expect(result.stderr.includes('VANGUARD_INFRA_FAILURE')).toBe(transient);
  });

  it('fails on the first attempt for a non-transient error, without retrying or claiming infrastructure', async () => {
    const dir = await tmpBin();
    const counter = join(dir, 'count');
    const cmd = await writeScript(dir, 'bad-version', countCall(counter) + `echo "npm ERR! 404 Not Found: @scope/pkg@9.9.9" >&2\nexit 1\n`);

    const result = await execa(RETRY_SH, ['5', '0', cmd], { reject: false, env: { PATH: `${dir}:${process.env['PATH']}` } });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain('VANGUARD_INFRA_FAILURE');
    expect((await readFile(counter, 'utf8')).trim()).toBe('1');
  });
});

describe('docker/build-ci.sh', () => {
  /** A `docker` stub that records build arguments and simulates network failures. */
  async function fakeDocker(dir: string, opts: { buildMode: 'success' | 'fail-504' }): Promise<{ log: string }> {
    const log = join(dir, 'docker.log');
    await writeScript(
      dir,
      'docker',
      [
        `echo "$@" >> ${log}`,
        `if [ "$1" = "build" ]; then`,
        opts.buildMode === 'success' ? '  exit 0' : '  echo "504 Gateway Timeout" >&2\n  exit 1',
        `fi`,
        `exit 0`,
      ].join('\n'),
    );
    return { log };
  }

  it('delegates caching to Docker and preserves build options', async () => {
    const dir = await tmpBin();
    const { log } = await fakeDocker(dir, { buildMode: 'success' });
    const { wasCalled } = await ghSentinel(dir);

    const result = await execa(BUILD_CI_SH, ['vanguard-sandbox:latest', '--no-cache'], {
      reject: false,
      env: { PATH: `${dir}:${process.env['PATH']}`, BUILD_CI_RETRY_ATTEMPTS: '1', BUILD_CI_RETRY_DELAY: '0' },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readFile(log, 'utf8');
    expect(invocations.trim()).toBe(`build --no-cache -t vanguard-sandbox:latest ${DOCKER_DIR}`);
    expect(await wasCalled()).toBe(false);
  });

  it('reports a persistent network failure as infrastructure and leaves no trace of a label/comment call', async () => {
    const dir = await tmpBin();
    await fakeDocker(dir, { buildMode: 'fail-504' });
    const { wasCalled } = await ghSentinel(dir);

    const result = await execa(BUILD_CI_SH, ['vanguard-sandbox:latest'], {
      reject: false,
      env: { PATH: `${dir}:${process.env['PATH']}`, BUILD_CI_RETRY_ATTEMPTS: '2', BUILD_CI_RETRY_DELAY: '0' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('VANGUARD_INFRA_FAILURE');
    expect(await wasCalled()).toBe(false);
  });
});
