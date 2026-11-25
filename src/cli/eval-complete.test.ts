import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import { makeCliComplete } from './eval.js';

describe('makeCliComplete env', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'tok-1\ntok-2';
    execaMock.mockReset();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'reply', stderr: '', timedOut: false });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = saved;
  });

  it('hands claude only the first token and does not re-extend the process env', async () => {
    expect(await makeCliComplete('m')('p')).toBe('reply');
    const opts = execaMock.mock.calls[0]![2] as { env: Record<string, string>; extendEnv: boolean };
    expect(opts.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok-1');
    expect(opts.extendEnv).toBe(false);
  });
});
