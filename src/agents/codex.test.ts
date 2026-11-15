import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, it, expect } from 'vitest';
import { CodexProvider } from './codex.js';
import type { IsolatedSandboxProvider, ExecOptions, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

function capturingSandbox(): { sandbox: IsolatedSandboxProvider; captured: { command: string; options: ExecOptions } } {
  const captured: { command: string; options: ExecOptions } = { command: '', options: {} };
  return {
    captured,
    sandbox: {
      exec: async (command: string, options: ExecOptions = {}): Promise<ExecResult> => {
        if (command.includes('/sessions')) return { stdout: '', stderr: '', exitCode: 1 };
        captured.command = command;
        captured.options = options;
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider,
  };
}

async function expectRunRejects(sandbox: IsolatedSandboxProvider, pattern: RegExp): Promise<void> {
  const gen = new CodexProvider().run(input(sandbox));
  await expect(
    (async () => {
      for await (const turn of gen) void turn;
    })(),
  ).rejects.toThrow(pattern);
}

const cannedJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'here is my answer' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 10 } }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root' };
}

async function drain(sandbox: IsolatedSandboxProvider): Promise<{ turns: string[]; out: AgentRunOutput }> {
  const gen = new CodexProvider().run(input(sandbox));
  const turns: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value.text);
  }
}

describe('CodexProvider', () => {
  it('parses JSONL into turns, sessionId, and usage', async () => {
    const { turns, out } = await drain(fakeSandbox(cannedJsonl));
    expect(turns).toEqual(['here is my answer']);
    expect(out.sessionId).toBe('codex-thread-1');
    expect(out.finalText).toBe('here is my answer');
    expect(out.usage?.inputTokens).toBe(100); // as Codex reports it: the 10 cached are counted inside
    expect(out.usage?.outputTokens).toBe(25);
    expect(out.usage?.cacheReadInputTokens).toBe(10);
  });

  it('skips non-JSON diagnostic lines', async () => {
    const { out } = await drain(fakeSandbox(`WARN: something\n${cannedJsonl}`));
    expect(out.sessionId).toBe('codex-thread-1');
  });

  it('does not throw on non-zero exit when turn.completed was received (graceful stop)', async () => {
    const { out } = await drain(fakeSandbox(cannedJsonl, 1));
    expect(out.finalText).toBe('here is my answer');
  });

  it('throws AgentError when no parseable output is produced', async () => {
    await expectRunRejects(fakeSandbox('fatal crash output', 1), /no parseable output/);
  });

  it('throws "without a result" (not "no parseable output") when only thread.started is received', async () => {
    await expectRunRejects(fakeSandbox(JSON.stringify({ type: 'thread.started', thread_id: 'x' })), /without a result/);
  });

  it('throws AgentError when turn.completed is missing', async () => {
    const partial = [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
    ].join('\n');
    await expectRunRejects(fakeSandbox(partial), /without a result/);
  });

  it('includes codex exec --json --sandbox danger-full-access in command', async () => {
    const { sandbox, captured } = capturingSandbox();
    const gen = new CodexProvider().run({ prompt: 'hello', sandbox, workdir: '/workspace', home: '/root' });
    for await (const turn of gen) void turn;
    expect(captured.command).toContain('codex');
    expect(captured.command).toContain('exec');
    expect(captured.command).toContain('--json');
    expect(captured.command).toContain('--sandbox');
    expect(captured.command).toContain('danger-full-access');
  });

  it('logs in with the API key (piped from env, not on argv) before exec', async () => {
    const commands: string[] = [];
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        commands.push(command);
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new CodexProvider().run(input(sandbox));
    for await (const turn of gen) void turn;
    expect(commands[0]).toContain('codex login --with-api-key');
    expect(commands[0]).toContain('$OPENAI_API_KEY'); // key read from env, never embedded on the command line
    expect(commands[1]).toContain('codex');
    expect(commands[1]).toContain('exec');
  });

  it('setup command (commands[0]) wires proxy mode without leaking the real key', async () => {
    const commands: string[] = [];
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        commands.push(command);
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new CodexProvider().run(input(sandbox));
    for await (const turn of gen) void turn;
    const setup = commands[0];

    // branches at runtime on the runner-provided base URL
    expect(setup).toContain('TASKCELL_OPENAI_BASE_URL');
    expect(setup).toContain('if [ -n "${TASKCELL_OPENAI_BASE_URL:-}" ]; then');

    // writes config.toml under $CODEX_HOME (falling back to ~/.codex)
    expect(setup).toContain('mkdir -p "${CODEX_HOME:-$HOME/.codex}"');
    expect(setup).toContain('> "${CODEX_HOME:-$HOME/.codex}/config.toml"');

    // custom OpenAI-compatible provider config pointed at the sidecar
    expect(setup).toContain('model_provider = "vanguardproxy"');
    expect(setup).toContain('wire_api = "responses"');
    expect(setup).toContain('env_key = "OPENAI_API_KEY"');
    expect(setup).toContain('base_url = "%s"');
    expect(setup).toContain('"$TASKCELL_OPENAI_BASE_URL"'); // base url fed via printf %s, expanded in-sandbox

    // literal backslash-n reaches the sandbox so printf interprets the format string
    expect(setup).toContain('printf \'model_provider = "vanguardproxy"\\n[model_providers.vanguardproxy]');

    // fail-clearly guard when proxy mode is on but the nonce is missing
    expect(setup).toContain('if [ -z "${OPENAI_API_KEY:-}" ]; then');
    expect(setup).toContain('exit 1');

    // else branch still serves normal mode in the same single command
    expect(setup).toContain('codex login --with-api-key');

    // no literal API key: only env-var references are used to carry secrets
    expect(setup).not.toMatch(/--with-api-key\s+\S*sk-/);
    expect(setup).not.toContain('sk-');
    expect(setup).toContain('$OPENAI_API_KEY');
  });

  it('setup command writes auth.json from CODEX_AUTH_JSON (subscription mode) before the other branches', async () => {
    const commands: string[] = [];
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        commands.push(command);
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new CodexProvider().run(input(sandbox));
    for await (const turn of gen) void turn;
    const setup = commands[0] ?? '';

    // subscription branch is checked FIRST and writes the auth.json the runner forwarded via env
    expect(setup).toContain('if [ -n "${CODEX_AUTH_JSON:-}" ]; then');
    expect(setup.indexOf('CODEX_AUTH_JSON')).toBeLessThan(setup.indexOf('TASKCELL_OPENAI_BASE_URL'));
    expect(setup).toContain('> "${CODEX_HOME:-$HOME/.codex}/auth.json"');
    expect(setup).toContain('printf %s "$CODEX_AUTH_JSON"'); // content from env, never embedded on argv
    expect(setup).toContain('chmod 600 "${CODEX_HOME:-$HOME/.codex}/auth.json"');

    // the auth.json write is its own `if`, not a chain: chatgpt-plan proxy mode needs it AND the
    // base-URL branch below, so the latter must not be an `elif` hanging off this one.
    expect(setup).toContain('chmod 600 "${CODEX_HOME:-$HOME/.codex}/auth.json"; fi; if [ -n "${TASKCELL_OPENAI_BASE_URL:-}" ]; then');
    // login is the fallback only when there is no auth.json at all.
    expect(setup).toContain('elif [ -z "${CODEX_AUTH_JSON:-}" ]; then printf %s "$OPENAI_API_KEY" | codex login --with-api-key');
  });

  it('feeds the prompt on stdin (`-` arg), never on argv', async () => {
    // A PR-review prompt embeds the diff and can exceed MAX_ARG_STRLEN (128 KiB) as a single argv string.
    const prompt = `review this diff\n${'+ line of diff\n'.repeat(20_000)}`;
    const { sandbox, captured } = capturingSandbox();
    const gen = new CodexProvider().run({ prompt, sandbox, workdir: '/workspace', home: '/root' });
    for await (const turn of gen) void turn;
    expect(captured.command.endsWith(" '-'")).toBe(true);
    expect(captured.command).not.toContain('review this diff');
    expect(captured.command).not.toContain('line of diff');
    expect(captured.command.length).toBeLessThan(200);
    expect(captured.options.input).toBe(prompt);
  });

  it('reads the model from the session rollout when none was requested', async () => {
    const commands: string[] = [];
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        commands.push(command);
        return { stdout: command.includes('/sessions') ? '"model":"gpt-6.1-sol"\n' : cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    expect((await drain(sandbox)).out.model).toBe('gpt-6.1-sol');
    expect(commands.some((c) => c.includes('codex-thread-1'))).toBe(true);
  });

  it('records no model when the rollout cannot be read, and does not look when -m was passed', async () => {
    expect((await drain(fakeSandbox(cannedJsonl))).out.model).toBeUndefined();
    const commands: string[] = [];
    const sandbox = { exec: async (c: string): Promise<ExecResult> => (commands.push(c), { stdout: cannedJsonl, stderr: '', exitCode: 0 }) } as unknown as IsolatedSandboxProvider;
    const gen = new CodexProvider().run({ ...input(sandbox), model: 'gpt-5' });
    while (!(await gen.next()).done);
    expect(commands.some((c) => c.includes('/sessions'))).toBe(false);
  });

  // A `turn_context` line as codex-cli 0.147.0 wrote it (paths and timezone replaced), preceded by
  // lines that mention a model without being one.
  const THREAD = '01a1dd94-2c92-7ae2-a9de-08f7dd55c89f';
  const ROLLOUT = [
    JSON.stringify({ type: 'session_meta', payload: { id: THREAD, cwd: '/workspace', model_provider: 'openai' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ type: 'input_text', text: 'set "model":"evil" in config' }] } }),
    String.raw`{"timestamp":"2026-11-15T05:00:40.916Z","type":"turn_context","payload":{"turn_id":"01a1dd94-35f6-7c71-b8c0-9aea7e3216d3","cwd":"/workspace","workspace_roots":["/workspace"],"current_date":"2026-11-15","timezone":"UTC","approval_policy":"never","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","network_access":true,"exclude_tmpdir_env_var":false,"exclude_slash_tmp":false},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/workspace"},"access":"write"}]},"network":"enabled"},"file_system_sandbox_policy":{"kind":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"},{"path":{"type":"path","path":"/workspace"},"access":"write"}]},"model":"gpt-5.6-sol","comp_hash":"3000","personality":"pragmatic","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":"high","developer_instructions":null}},"multi_agent_version":"v2","realtime_active":false,"effort":"high","summary":"auto"}}`,
  ].join('\n');

  /** Runs the provider's rollout lookup for real (`sh`, `grep`) against a CODEX_HOME holding `files`. */
  async function modelFromRollouts(files: Record<string, string>): Promise<string | undefined> {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    try {
      const dir = join(home, 'sessions', '2026', '11', '15');
      await mkdir(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), `${text}\n`);
      const stream = cannedJsonl.replace('codex-thread-1', THREAD);
      const sandbox = {
        exec: async (command: string): Promise<ExecResult> => {
          if (!command.includes('/sessions')) return { stdout: stream, stderr: '', exitCode: 0 };
          const res = await execa('sh', ['-c', command], { env: { CODEX_HOME: home }, reject: false });
          return { stdout: res.stdout === '' ? '' : `${res.stdout}\n`, stderr: res.stderr, exitCode: res.exitCode ?? 1 };
        },
      } as unknown as IsolatedSandboxProvider;
      return (await drain(sandbox)).out.model;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('extracts the model from a recorded rollout, picking the thread\'s own file', async () => {
    const other = ROLLOUT.replaceAll('gpt-5.6-sol', 'gpt-5');
    expect(
      await modelFromRollouts({
        'rollout-2026-11-15T05-30-33-01a1dd78-a55f-7821-9e79-421295bd726b.jsonl': other,
        [`rollout-2026-11-15T06-00-37-${THREAD}.jsonl`]: ROLLOUT,
      }),
    ).toBe('gpt-5.6-sol');
  });

  it('treats a model string that is not a model id as unknown', async () => {
    const planted = (model: string): Record<string, string> => ({ [`rollout-x-${THREAD}.jsonl`]: JSON.stringify({ model }) });
    expect(await modelFromRollouts(planted('sk-proj AAAA BBBB'))).toBeUndefined();
    expect(await modelFromRollouts(planted('<img src=x>'))).toBeUndefined();
    expect(await modelFromRollouts(planted('a'.repeat(101)))).toBeUndefined();
    // A key-shaped value passes the charset but must never be recorded.
    expect(await modelFromRollouts(planted(`sk-${'A1b2'.repeat(12)}`))).toBeUndefined();
    expect(await modelFromRollouts(planted('openai/gpt-5.1-codex:free'))).toBe('openai/gpt-5.1-codex:free');
  });

  it('includes -m flag when model is specified', async () => {
    const { sandbox, captured } = capturingSandbox();
    const gen = new CodexProvider().run({ prompt: 'p', sandbox, workdir: '/workspace', home: '/root', model: 'o4-mini' });
    for await (const turn of gen) void turn;
    expect(captured.command).toContain('-m');
    expect(captured.command).toContain('o4-mini');
  });
});
