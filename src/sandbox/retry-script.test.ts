import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, it, expect } from 'vitest';

// Exercises docker/retry.sh directly against a fake flaky command: the Dockerfile wraps every release
// download (npm installs, the Cursor curl) in this script so a transient GitHub Releases/npm 5xx or
// timeout (#657) does not fail the whole sandbox image build.
const RETRY_SH = fileURLToPath(new URL('../../docker/retry.sh', import.meta.url));

/** A fake command that counts its own invocations (via a file) and fails until the Nth call. */
async function writeFlaky(dir: string, opts: { failUntil: number; failureLine: string }): Promise<string> {
  const bin = join(dir, 'flaky');
  const counter = join(dir, 'count');
  await writeFile(counter, '0');
  await writeFile(
    bin,
    `#!/bin/sh
n=$(($(cat "${counter}") + 1))
echo "$n" >"${counter}"
if [ "$n" -lt ${opts.failUntil} ]; then
  echo "${opts.failureLine}" >&2
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  );
  return bin;
}

/** A fake command that always fails with the given line. */
async function writeAlwaysFails(dir: string, failureLine: string): Promise<{ bin: string; counter: string }> {
  const bin = join(dir, 'broken');
  const counter = join(dir, 'count');
  await writeFile(counter, '0');
  await writeFile(
    bin,
    `#!/bin/sh
n=$(($(cat "${counter}") + 1))
echo "$n" >"${counter}"
echo "${failureLine}" >&2
exit 1
`,
    { mode: 0o755 },
  );
  return { bin, counter };
}

function runRetry(args: string[]) {
  return execa('bash', [RETRY_SH, ...args], { reject: false });
}

describe('docker/retry.sh', () => {
  it('succeeds once a simulated 504 on the first attempt clears on retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retry-sh-'));
    try {
      const bin = await writeFlaky(dir, {
        failUntil: 2,
        failureLine: 'Error fetching release: Request failed with status code 504',
      });

      const result = await runRetry(['3', '0', '--', bin]);

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats curl -f's bare 5xx message as a network failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retry-sh-'));
    try {
      const { bin } = await writeAlwaysFails(dir, 'curl: (22) The requested URL returned error: 504');

      const result = await runRetry(['2', '0', '--', bin]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RETRY_EXHAUSTED_NETWORK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports RETRY_EXHAUSTED_NETWORK and exits non-zero on a persistent network failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retry-sh-'));
    try {
      const { bin, counter } = await writeAlwaysFails(dir, '504 Gateway Time-out');

      const result = await runRetry(['3', '0', '--', bin]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RETRY_EXHAUSTED_NETWORK');
      expect((await readFile(counter, 'utf8')).trim()).toBe('3');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports plain RETRY_EXHAUSTED (no NETWORK suffix) on a persistent non-network failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retry-sh-'));
    try {
      const { bin } = await writeAlwaysFails(dir, 'EINTEGRITY: checksum mismatch');

      const result = await runRetry(['3', '0', '--', bin]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RETRY_EXHAUSTED:');
      expect(result.stderr).not.toContain('RETRY_EXHAUSTED_NETWORK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
