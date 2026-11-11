import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from '../core/state-path.js';
import { resolveBaselineVerify } from './baseline-verify.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';

const SHA = 'a'.repeat(40);
const CMD = 'pnpm test';
const GREEN: ExecResult = { stdout: 'all good', stderr: '', exitCode: 0 };
const RED: ExecResult = { stdout: 'FAILED one.test.ts', stderr: '', exitCode: 1 };

/** Sandbox that answers every exec the same way and counts the calls. */
function countingSandbox(result: ExecResult): { sandbox: IsolatedSandboxProvider; calls: () => number } {
  let calls = 0;
  const sandbox = {
    exec: async (): Promise<ExecResult> => {
      calls += 1;
      return result;
    },
  } as unknown as IsolatedSandboxProvider;
  return { sandbox, calls: () => calls };
}

function baselineDir(repo: string): string {
  return join(stateDir(repo), 'baseline-verify');
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-baseline-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('resolveBaselineVerify', () => {
  it('masks the run\'s extra secret values in the cached record', async () => {
    const secret = 'custom-provider-key-value-123';
    const sandbox = countingSandbox({ stdout: `leaked ${secret}`, stderr: '', exitCode: 0 }).sandbox;
    await resolveBaselineVerify(repo, SHA, sandbox, CMD, undefined, [secret]);
    const dir = baselineDir(repo);
    const [file] = await readdir(dir);
    expect(await readFile(join(dir, file as string), 'utf8')).not.toContain(secret);
  });

  it('caches a green verdict and serves it without re-running', async () => {
    const first = countingSandbox(GREEN);
    const result = await resolveBaselineVerify(repo, SHA, first.sandbox, CMD);
    expect(result.passed).toBe(true);
    expect(first.calls()).toBe(1);

    const second = countingSandbox(GREEN);
    const cached = await resolveBaselineVerify(repo, SHA, second.sandbox, CMD);
    expect(cached.passed).toBe(true);
    expect(second.calls()).toBe(0);
  });

  it('never caches a red verdict — it is re-run on every attempt', async () => {
    const first = countingSandbox(RED);
    expect((await resolveBaselineVerify(repo, SHA, first.sandbox, CMD)).passed).toBe(false);
    expect(first.calls()).toBe(1);
    await expect(readdir(baselineDir(repo))).rejects.toThrow();

    const second = countingSandbox(RED);
    expect((await resolveBaselineVerify(repo, SHA, second.sandbox, CMD)).passed).toBe(false);
    expect(second.calls()).toBe(1);
  });

  it('ignores a leftover red record on disk instead of serving it as a verdict', async () => {
    await mkdir(baselineDir(repo), { recursive: true });
    await writeFile(
      join(baselineDir(repo), `${SHA}.json`),
      JSON.stringify({ command: CMD, exitCode: 1, passed: false, sha256: 'abc', outputTail: 'FAILED' }),
    );
    const run = countingSandbox(GREEN);
    expect((await resolveBaselineVerify(repo, SHA, run.sandbox, CMD)).passed).toBe(true);
    expect(run.calls()).toBe(1);
  });

  it('does not serve a cached verdict for a different command', async () => {
    await resolveBaselineVerify(repo, SHA, countingSandbox(GREEN).sandbox, CMD);
    const run = countingSandbox(GREEN);
    await resolveBaselineVerify(repo, SHA, run.sandbox, 'pnpm test -- --other');
    expect(run.calls()).toBe(1);
  });

  it('masks credential material in the cached output', async () => {
    const token = `ghp_${'C'.repeat(36)}`;
    const { sandbox } = countingSandbox({ stdout: `leaked ${token}`, stderr: '', exitCode: 0 });
    await resolveBaselineVerify(repo, SHA, sandbox, CMD);
    const raw = await readFile(join(baselineDir(repo), `${SHA}.json`), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain('[REDACTED-GH]');
  });

  it('neither reads nor writes for a sha git could not produce', async () => {
    const run = countingSandbox({ ...GREEN, stdout: '' });
    expect((await resolveBaselineVerify(repo, '../etc', run.sandbox, CMD)).passed).toBe(true);
    expect(run.calls()).toBe(1);
    await expect(readdir(baselineDir(repo))).rejects.toThrow();
  });
});
