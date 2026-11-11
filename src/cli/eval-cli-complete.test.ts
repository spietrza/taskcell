import { describe, it, expect, vi, beforeEach } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const { makeCliComplete, EVAL_CALL_ATTEMPTS } = await import('./eval.js');

const hung = { timedOut: true, exitCode: undefined, stdout: '', stderr: '' };
const ok = (stdout: string): object => ({ timedOut: false, exitCode: 0, stdout, stderr: '' });

describe('makeCliComplete', () => {
  beforeEach(() => execaMock.mockReset());

  it('retries a hung call and returns the answer of the attempt that finishes (#735)', async () => {
    execaMock.mockResolvedValueOnce(hung).mockResolvedValueOnce(ok('pong'));
    await expect(makeCliComplete('m')('ping')).resolves.toBe('pong');
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt times out', async () => {
    execaMock.mockResolvedValue(hung);
    await expect(makeCliComplete('m')('ping')).rejects.toThrow(`timed out ${EVAL_CALL_ATTEMPTS}x`);
    expect(execaMock).toHaveBeenCalledTimes(EVAL_CALL_ATTEMPTS);
  });

  it('does not retry a call that answered with an error', async () => {
    execaMock.mockResolvedValue({ timedOut: false, exitCode: 1, stdout: '', stderr: 'boom' });
    await expect(makeCliComplete('m')('ping')).rejects.toThrow('exited 1: boom');
    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});
