import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { readEnv } from '../core/env.js';
import { LinearCliTaskFetcher, linearGraphql } from './linear-cli.js';
import { applyLinearDependencyGate, checkLinearDependencies } from './linear-dependencies.js';
import type { LinearGraphql } from './linear-cli.js';

/**
 * The test that would have caught the bug this file exists because of.
 *
 * `LinearCliTaskFetcher.list()` used to shell `linear issue query`, a command that does not exist in
 * the installed CLI. Every unit test passed, because they all inject a fake `LinearCliRunner` — and a
 * fake will happily answer a command that isn't there. The suite proved the parsing and nothing about
 * the contract, so `taskcell watch --linear` was broken in production while CI stayed green.
 *
 * So: one test that touches the real CLI. It asserts the contract we actually depend on, and the
 * absence of the one we wrongly depended on.
 *
 * Opt-in — it needs the real `linear` binary and a login, which CI has neither of. Run with:
 *   TASKCELL_LINEAR_IT=1 pnpm vitest run src/tasks/linear-contract.test.ts
 */
const IT = readEnv('TASKCELL_LINEAR_IT') === '1';

/** Exit code only — never capture the output of `auth token`, which prints a live credential. */
async function exitCode(args: string[]): Promise<number> {
  const { exitCode } = await execa('linear', args, { reject: false, stdout: 'ignore', stderr: 'ignore' });
  return exitCode ?? -1;
}

describe.skipIf(!IT)('linear CLI contract (integration)', () => {
  it('still provides `auth token` — the credential fallback depends on it', async () => {
    expect(await exitCode(['auth', 'token'])).toBe(0);
  });

  it('still provides `issue view --json` — fetch() depends on it', async () => {
    // No id: the command exists but errors on usage. What matters is that it is not "unknown command".
    const help = await execa('linear', ['issue', 'view', '--help'], { reject: false });
    expect(help.exitCode).toBe(0);
  });

  it('does NOT provide `issue query` — the command list() used to shell', async () => {
    // If this ever starts passing, the CLI grew the command back. Do not go back to it: GraphQL is
    // version-independent, and this whole outage was a CLI-version mismatch.
    expect(await exitCode(['issue', 'query', '--json'])).not.toBe(0);
  });
});

/**
 * The dependency gate's queries against the real API (read-only: the `linear` runner is a stub, so
 * nothing is commented or moved). Every unit test answers them from a fake, which accepts a field or
 * a filter Linear would reject.
 */
describe.skipIf(!IT)('Linear dependency queries (integration)', () => {
  it('Linear accepts the probe, the issue lookup and the newest-comment query, and reports a missing issue as expected', async () => {
    const real = await linearGraphql();
    const errors: string[] = [];
    const send: LinearGraphql = async (body) => {
      const res = (await real(body)) as { errors?: { message?: string }[] };
      errors.push(...(res.errors ?? []).map((e) => e.message ?? ''));
      return res;
    };
    const [first] = await new LinearCliTaskFetcher({ graphql: send }).list({ limit: 1 });
    if (first === undefined) return; // an empty workspace has nothing to probe
    const logs: string[] = [];
    const gate = { graphql: send, linear: async (): Promise<string> => '', reported: new Map<string, string>(), log: (line: string): void => void logs.push(line) };
    await applyLinearDependencyGate([first], gate);
    // A far start date makes the issue wait, which reads its newest comment (unless it is in a cycle).
    await applyLinearDependencyGate([{ ...first, description: 'Start: 2999-01-01' }], gate);
    expect(logs.filter((line) => /probe failed|could not be recorded|lookup failed/.test(line))).toEqual([]);
    expect(await checkLinearDependencies(first, send)).not.toMatchObject({ status: 'error' });
    expect(await checkLinearDependencies({ ...first, description: 'Depends on ZZZZZ-999999' }, send)).toMatchObject({ status: 'invalid' });
    expect(errors.filter((message) => !/entity not found/i.test(message))).toEqual([]);
  });
});
