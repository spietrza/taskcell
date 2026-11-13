import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback, proofBlock, extractFirstErrorLines, failingTaskName } from './verify.js';

// ---------------------------------------------------------------------------
// Fake sandbox
// ---------------------------------------------------------------------------
function fakeSandbox(stdout: string, stderr: string, exitCode: number): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr, exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'vg-verify-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveVerifyCommand
// ---------------------------------------------------------------------------
describe('resolveVerifyCommand', () => {
  it('returns explicit cmd immediately (wins over everything)', async () => {
    const result = await resolveVerifyCommand('/nonexistent', { cmd: 'my-custom-cmd' });
    expect(result).toBe('my-custom-cmd');
  });

  it('returns env TASKCELL_VERIFY_CMD when no explicit cmd', async () => {
    const result = await resolveVerifyCommand('/nonexistent', {
      env: { TASKCELL_VERIFY_CMD: 'env-cmd' },
    });
    expect(result).toBe('env-cmd');
  });

  it('env wins over auto-detect', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'pnpm@8.0.0' }),
    );
    const result = await resolveVerifyCommand(tmpDir, {
      env: { TASKCELL_VERIFY_CMD: 'env-cmd' },
    });
    expect(result).toBe('env-cmd');
  });

  it('auto-detects pnpm command with typecheck script', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest', typecheck: 'tsc --noEmit' },
        packageManager: 'pnpm@8.15.0',
      }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test');
  });

  it('auto-detects check-types (Turborepo convention) as the typecheck step', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'turbo run test', 'check-types': 'turbo run check-types' },
        packageManager: 'pnpm@9.15.9',
      }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('pnpm install --frozen-lockfile && pnpm run check-types && pnpm test');
  });

  it('prefers typecheck over check-types when both exist', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest', typecheck: 'tsc --noEmit', 'check-types': 'tsc -b' },
        packageManager: 'pnpm@9.15.9',
      }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test');
  });

  it('auto-detects pnpm command without typecheck script', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'pnpm@8.15.0' }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('pnpm install --frozen-lockfile && pnpm test');
  });

  it('auto-detects npm when no packageManager field', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('npm install --frozen-lockfile && npm test');
  });

  it('auto-detects yarn when packageManager starts with yarn', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' }, packageManager: 'yarn@3.0.0' }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('yarn install --frozen-lockfile && yarn test');
  });

  it('a verify script wins over the typecheck/test auto-detect', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest', typecheck: 'tsc --noEmit', verify: 'tsc --noEmit && vitest run' },
        packageManager: 'pnpm@9.15.9',
      }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('pnpm install --frozen-lockfile && pnpm run verify');
  });

  it('an explicit cmd still wins over a verify script', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { verify: 'pnpm run verify' } }),
    );
    const result = await resolveVerifyCommand(tmpDir, { cmd: 'my-custom-cmd', env: {} });
    expect(result).toBe('my-custom-cmd');
  });

  it('an explicit env cmd still wins over a verify script', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { verify: 'pnpm run verify' } }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: { TASKCELL_VERIFY_CMD: 'env-cmd' } });
    expect(result).toBe('env-cmd');
  });

  it('npm project with a verify script gets the npm command', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { verify: 'npm run build' } }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('npm install --frozen-lockfile && npm run verify');
  });

  it('yarn project with a verify script gets the yarn command', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { verify: 'yarn build' }, packageManager: 'yarn@3.0.0' }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBe('yarn install --frozen-lockfile && yarn run verify');
  });

  it('returns undefined when package.json has no test script', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    const result = await resolveVerifyCommand(tmpDir, { env: {} });
    expect(result).toBeUndefined();
  });

  it('returns undefined when package.json does not exist', async () => {
    const result = await resolveVerifyCommand(join(tmpDir, 'nonexistent'), { env: {} });
    expect(result).toBeUndefined();
  });

  it('returns undefined when cmd is empty string', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'pnpm@8.0.0' }),
    );
    // empty cmd falls through to env
    const result = await resolveVerifyCommand(tmpDir, { cmd: '', env: {} });
    // no env and package.json has test -> auto-detect
    expect(result).toBe('pnpm install --frozen-lockfile && pnpm test');
  });
});

// ---------------------------------------------------------------------------
// runVerification
// ---------------------------------------------------------------------------
describe('runVerification', () => {
  it('returns passed=true and correct exitCode on success', async () => {
    const sandbox = fakeSandbox('all tests pass', '', 0);
    const result = await runVerification(sandbox, 'pnpm test');
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('pnpm test');
  });

  it('returns passed=false and non-zero exitCode on failure', async () => {
    const sandbox = fakeSandbox('', 'FAILED 3 tests', 1);
    const result = await runVerification(sandbox, 'pnpm test');
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('produces a stable sha256 over combined stdout+stderr', async () => {
    const stdout = 'stdout line';
    const stderr = 'stderr line';
    const sandbox = fakeSandbox(stdout, stderr, 0);
    const result = await runVerification(sandbox, 'cmd');
    const expected = createHash('sha256').update(`${stdout}\n${stderr}`).digest('hex');
    expect(result.sha256).toBe(expected);
  });

  it('outputTail contains up to 40 lines trimmed', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const stdout = lines.join('\n');
    const sandbox = fakeSandbox(stdout, '', 0);
    const result = await runVerification(sandbox, 'cmd');
    const tailLines = result.outputTail.split('\n');
    // 40 lines from combined (stdout\n + \n stderr)
    expect(tailLines.length).toBeLessThanOrEqual(40);
  });

  it('a passing run keeps a stdout summary despite stderr noise', async () => {
    const stderr = Array.from({ length: 50 }, (_, i) => `Warning: act ${i}`).join('\n');
    const passed = await runVerification(fakeSandbox('Tests 42 passed', stderr, 0), 'cmd');
    expect(passed.outputTail.split('\n').at(-1)).toBe('Tests 42 passed');
    expect(passed.outputTail).not.toContain('Warning: act 39\n');
    const failed = await runVerification(fakeSandbox('Tests 1 failed', stderr, 1), 'cmd');
    expect(failed.outputTail).toContain('Warning: act 49');
  });

  it('a passing run keeps a stderr summary (Jest) after a stdout banner (pnpm)', async () => {
    const stdout = '> pkg@1.0.0 test\n> jest\n';
    const stderr = 'PASS src/a.test.js\nTests:       3 passed, 3 total\nTime:        1.2 s\n';
    const result = await runVerification(fakeSandbox(stdout, stderr, 0), 'cmd');
    expect(result.outputTail).toContain('Tests:       3 passed, 3 total');
    expect(result.outputTail).toContain('> jest');
  });

  it('sha256 is a 64-char hex string', async () => {
    const sandbox = fakeSandbox('hello', 'world', 0);
    const result = await runVerification(sandbox, 'cmd');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// renderVerificationFeedback
// ---------------------------------------------------------------------------
describe('renderVerificationFeedback', () => {
  const failed = {
    command: 'pnpm test',
    exitCode: 1,
    passed: false,
    sha256: 'abc123',
    outputTail: 'FAIL src/foo.test.ts\n  1 failing',
  };

  it('renders the command, exit code, and output tail', () => {
    const feedback = renderVerificationFeedback(failed);
    expect(feedback).toContain('pnpm test');
    expect(feedback).toContain('1');
    expect(feedback).toContain('FAIL src/foo.test.ts');
  });

  it('is compact and actionable — no full diff embedded', () => {
    const feedback = renderVerificationFeedback(failed);
    expect(feedback).not.toContain('diff --git');
    expect(feedback.length).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// proofBlock
// ---------------------------------------------------------------------------
describe('proofBlock', () => {
  const baseResult = {
    command: 'pnpm test',
    exitCode: 0,
    passed: true,
    sha256: 'abc123',
    outputTail: 'Tests passed: 42',
  };

  it('contains PASS when passed=true', () => {
    const block = proofBlock(baseResult);
    expect(block).toContain('PASS');
    expect(block).not.toContain('FAIL');
  });

  it('contains FAIL when passed=false', () => {
    const block = proofBlock({ ...baseResult, passed: false, exitCode: 1 });
    expect(block).toContain('FAIL');
    expect(block).not.toContain('PASS');
  });

  it('contains the command', () => {
    const block = proofBlock(baseResult);
    expect(block).toContain('pnpm test');
  });

  it('contains the sha256', () => {
    const block = proofBlock(baseResult);
    expect(block).toContain('abc123');
  });

  it('contains fenced output tail', () => {
    const block = proofBlock(baseResult);
    expect(block).toContain('```');
    expect(block).toContain('Tests passed: 42');
  });

  it('fences the output tail with more backticks than any run inside it', () => {
    const block = proofBlock({ ...baseResult, outputTail: 'before\n````\n## injected\n```' });
    expect(block).toContain('\n`````\nbefore\n````\n## injected\n```\n`````\n');
  });

  it('contains the exit code', () => {
    const block = proofBlock({ ...baseResult, exitCode: 42, passed: false });
    expect(block).toContain('42');
  });
});

describe('extractFirstErrorLines', () => {
  it.each([
    ['npm', 'install ok\nnpm ERR! code ELIFECYCLE\nmore'],
    ['tsc', 'ok\nsrc/a.ts(1,2): error TS2345: bad\nmore'],
    ['vitest ×', 'ok\n × suite > test\nmore'],
    ['vitest ✕', 'ok\n ✕ suite > test\nmore'],
    ['FAIL', 'ok\n FAIL  src/a.test.ts\nmore'],
  ])('starts at the first %s failure marker', (_name, output) => {
    expect(extractFirstErrorLines(output).split('\n')[0]).not.toBe('ok');
    expect(extractFirstErrorLines(output)).not.toBe('');
  });

  it('returns empty when nothing failed', () => {
    expect(extractFirstErrorLines('all good\nno errors here')).toBe('');
  });
});

describe('failingTaskName', () => {
  it('reads a turbo-style package:task prefix', () => {
    expect(failingTaskName('@app/web:test: FAIL src/a.test.ts')).toBe('@app/web:test');
  });

  it('does not read a file:line compiler location as a task', () => {
    expect(failingTaskName('src/a.ts:12: error something')).toBeUndefined();
  });
});

describe('OOM evidence after a failed verify', () => {
  /** Sandbox whose memory.events reads return `counters` in turn (last one repeats); the command exits `code`. */
  const sandbox = (counters: Array<string | Error>, code: number): IsolatedSandboxProvider => {
    let i = 0;
    return {
      exec: async (cmd: string) => {
        if (!cmd.includes('memory.events')) return { stdout: '', stderr: 'EPIPE', exitCode: code };
        const c = counters[Math.min(i++, counters.length - 1)] as string | Error;
        if (c instanceof Error) throw c;
        return { stdout: c, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
  };
  it('reports an OOM when oom_kill rose during the run', async () => {
    const r = await runVerification(sandbox(['low 0\noom_kill 1\n', 'low 0\noom 2\noom_kill 3\n'], 1), 'x');
    expect(r.oomKilled).toBe(true);
    expect(proofBlock(r)).toContain('OOM kill: yes');
  });
  it('does not blame a pre-existing OOM kill for a later ordinary failure', async () => {
    const r = await runVerification(sandbox(['oom_kill 4\n', 'oom_kill 4\n'], 1), 'x');
    expect(r.oomKilled).toBe(false);
    expect(proofBlock(r)).toContain('no OOM kill');
  });
  it('says nothing on a pass, or when memory.events is unreadable or throws', async () => {
    expect((await runVerification(sandbox(['oom_kill 0\n', 'oom_kill 3\n'], 0), 'x')).oomKilled).toBeUndefined();
    for (const bad of ['', new Error('no exec')]) {
      const r = await runVerification(sandbox([bad], 1), 'x');
      expect(r.oomKilled).toBeUndefined();
      expect(proofBlock(r)).not.toContain('OOM kill');
    }
  });
});
