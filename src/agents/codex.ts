import { AgentError, isProviderLimitError, ProviderLimitError } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import type { ExecOptions, ExecResult } from '../sandbox/provider.js';
import { shellQuote } from './shell.js';
import { parseCodexUtilization, recordUtilization } from '../core/usage-cap.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: unknown;
  error?: { message?: unknown };
  item?: {
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

/**
 * Sandbox setup command run before `codex exec`, branching at runtime on the credential in the env. The
 * two writes are independent `if`s, not one chain, because the ChatGPT-plan proxy mode needs BOTH.
 *
 * auth.json (`$CODEX_AUTH_JSON` set): write its content to `$CODEX_HOME/auth.json` (0600) and skip login
 * entirely. Direct mode forwards the real ChatGPT-subscription credential (`auth_mode: chatgpt`, no API
 * key), which `codex exec` reads like the file `codex login` would have written and self-refreshes via
 * the embedded refresh_token. Under `--llm-proxy` the real credential stays in its sidecar and the value
 * here is the generated PLACEHOLDER auth.json instead (nonce as access_token, run-bound refresh
 * placeholder, synthetic id_token — see llmProxySandboxEnv), which the base-URL branch below completes.
 *
 * Normal mode (no auth.json, no base URL): log in with the real key from `$OPENAI_API_KEY`, piped via
 * stdin so the secret never reaches argv. `codex exec` then reads the auth.json that `codex login` wrote.
 *
 * Proxy mode (the runner set `$TASKCELL_OPENAI_BASE_URL` to a trusted sidecar): never run `codex login`.
 * Instead write `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) declaring a custom
 * OpenAI-compatible provider pointed at the sidecar. With `wire_api = "responses"`, Codex POSTs
 * `<base_url>/responses` (the OpenAI-key sidecar's URL ends in `/v1`, the ChatGPT-plan one does not) and
 * sends `env_key`'s value (`$OPENAI_API_KEY`, which in proxy mode holds only a nonce, not the real
 * credential) as `Authorization: Bearer`; the sidecar validates the nonce and swaps in the real one.
 * Fail clearly if the nonce is missing. `login --with-api-key` is reached only when there is no auth.json
 * at all — never with an empty key just because the credential went to a sidecar.
 *
 * The `\n` sequences are emitted as literal backslash-n into the sandbox shell so `printf` interprets
 * them; the base URL is expanded inside the sandbox via printf's `%s` arg, never interpolated host-side.
 */
const CODEX_SETUP =
  'if [ -n "${CODEX_AUTH_JSON:-}" ]; then mkdir -p "${CODEX_HOME:-$HOME/.codex}"; printf %s "$CODEX_AUTH_JSON" > "${CODEX_HOME:-$HOME/.codex}/auth.json"; chmod 600 "${CODEX_HOME:-$HOME/.codex}/auth.json"; fi; if [ -n "${TASKCELL_OPENAI_BASE_URL:-}" ]; then if [ -z "${OPENAI_API_KEY:-}" ]; then echo \'taskcell: codex proxy mode requires the OPENAI_API_KEY nonce\' >&2; exit 1; fi; mkdir -p "${CODEX_HOME:-$HOME/.codex}"; printf \'model_provider = "vanguardproxy"\\n[model_providers.vanguardproxy]\\nname = "vanguard-proxy"\\nbase_url = "%s"\\nwire_api = "responses"\\nenv_key = "OPENAI_API_KEY"\\n\' "$TASKCELL_OPENAI_BASE_URL" > "${CODEX_HOME:-$HOME/.codex}/config.toml"; elif [ -z "${CODEX_AUTH_JSON:-}" ]; then printf %s "$OPENAI_API_KEY" | codex login --with-api-key; fi';

function buildArgs(input: AgentRunInput): string[] {
  const args = ['exec', '--json', '--sandbox', 'danger-full-access'];
  if (input.model !== undefined) args.push('-m', input.model);
  return args;
}

function toUsage(raw: CodexEvent['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadInputTokens: raw.cached_input_tokens ?? 0,
  };
}

/** A stuck lookup (huge agent-planted rollout) must not hold the stage open after codex has finished. */
const SESSION_LOOKUP_TIMEOUT_MS = 10_000;

/** Best-effort: the model recorded in the thread's session rollout, or undefined when it cannot be read. */
async function sessionModel(
  sh: (command: string, opts?: ExecOptions) => Promise<ExecResult>,
  threadId: string,
  execOpts: ExecOptions,
): Promise<string | undefined> {
  if (!/^[0-9A-Za-z-]+$/.test(threadId)) return undefined; // interpolated into the command below
  const command = `timeout 10 grep -rhoE -m1 '"model":"[^"]+"' "${'$'}{CODEX_HOME:-${'$'}HOME/.codex}/sessions" --include='*${threadId}*.jsonl' | head -n 1`;
  try {
    const res = await sh(command, { ...execOpts, timeoutMs: SESSION_LOOKUP_TIMEOUT_MS });
    // The agent can write that file, and this string is published unredacted: accept a model-id shape only.
    const model = /^"model":"([A-Za-z0-9._:/-]{1,100})"\n?$/.exec(res.stdout)?.[1];
    // The rollout is agent-writable: never record a value the secret scan would redact.
    return model !== undefined && redactForPublish(model) === model ? model : undefined;
  } catch {
    return undefined;
  }
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const sh = input.sandbox.exec.bind(input.sandbox);
    const execOpts = {
      cwd: input.workdir,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };

    // Authenticate before exec: normal mode logs in with the real key (piped from $OPENAI_API_KEY so the
    // secret never reaches argv); proxy mode instead points codex at a trusted sidecar via config.toml.
    // See CODEX_SETUP. Best-effort: a missing/invalid key surfaces as an auth failure on the exec below,
    // caught by the graceful-exit guard.
    await sh(CODEX_SETUP, execOpts);

    // Feed the prompt on stdin (`-` as the PROMPT arg), never on argv: the command runs through
    // `sh -lc "<command>"`, so the whole prompt lands in ONE argv string, which Linux caps at
    // MAX_ARG_STRLEN (128 KiB). A PR-review prompt embeds the diff; past the cap `codex` never starts
    // (exit 1 within seconds, empty stdout AND stderr), which surfaces below as "no parseable output".
    const args = buildArgs(input);
    args.push('-');
    const command = `codex ${args.map(shellQuote).join(' ')}`;

    const res = await sh(command, { ...execOpts, input: input.prompt });

    let sessionId: string | undefined;
    let finalText = '';
    let turns = 0;
    let usage: AgentUsage | undefined;
    let sawTurnCompleted = false;
    let parsedAny = false;
    // Codex's own error / turn.failed messages (never agent prose): with stderr, what a provider limit is recognised from.
    const errorMessages: string[] = [];

    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed) as CodexEvent;
      } catch {
        continue;
      }
      parsedAny = true;
      const utilization = parseCodexUtilization(event);
      if (utilization !== undefined) recordUtilization(this.name, utilization);

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        const text = event.item.text;
        if (text !== '') {
          turns += 1;
          finalText = text;
          yield sessionId !== undefined ? { text, sessionId } : { text };
        }
      } else if (event.type === 'error' || event.type === 'turn.failed') {
        const message = event.type === 'error' ? event.message : event.error?.message;
        if (typeof message === 'string') errorMessages.push(message);
      } else if (event.type === 'turn.completed') {
        sawTurnCompleted = true;
        usage = toUsage(event.usage);
      }
    }

    // On a silent network/auth failure codex often leaves stderr empty and stdout holding only a startup
    // line, so surface BOTH streams (not just one) and the exit code. Redact credential material first:
    // in subscription mode auth.json (JWTs + Bearer tokens) lives in the sandbox, and this string is both
    // dumped to the run log AND posted as a public issue comment by the runner — a token must never ride along.
    const detail = (): string => {
      const err = redactForPublish(res.stderr.trim());
      const out = redactForPublish(res.stdout.trim()).slice(-1500);
      return [err !== '' ? `stderr: ${err}` : '', out !== '' ? `stdout: ${out}` : ''].filter(Boolean).join(' | ') || '(no output)';
    };
    if (!parsedAny || !sawTurnCompleted) {
      const reason = parsedAny ? 'exited without a result' : 'produced no parseable output';
      console.error(`codex ${reason} (exit ${res.exitCode})\n--- codex stdout ---\n${redactForPublish(res.stdout)}\n--- codex stderr ---\n${redactForPublish(res.stderr)}`);
      const message = `Agent ${reason} (exit ${res.exitCode}): ${detail()}`;
      // A usage/rate limit is a structured limit: the hub rotates to the next account or parks the run.
      throw isProviderLimitError([res.stderr, ...errorMessages].join('\n')) ? new ProviderLimitError(message) : new AgentError(message);
    }

    const output: AgentRunOutput = { finalText, turns, transcript: res.stdout, cachedInInput: true };
    // `exec --json` names no model in its events or on stderr; with no `-m`, read it from the session
    // rollout codex writes (the `turn_context` line), so the run can be priced.
    if (input.model === undefined && sessionId !== undefined) {
      const model = await sessionModel(sh, sessionId, execOpts);
      if (model !== undefined) output.model = model;
    }
    if (sessionId !== undefined) output.sessionId = sessionId;
    if (usage !== undefined) output.usage = usage;
    return output;
  }
}
