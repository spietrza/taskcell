import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVIDER_NAMES } from './registry.js';
import { runClaudeCli } from './claude-stream.js';
import { buildClaudeArgs } from './claude-code.js';
import type { AgentProvider, AgentRunInput } from './provider.js';

/**
 * Custom providers (Subsystem 6): named, repo-configured, KEYED Anthropic-Messages-compatible
 * endpoints driven by the in-sandbox `claude` CLI — a generalized zai. Configured under
 * `customProviders` in `<repoPath>/.taskcell/app.json`; the key itself is never stored, only the
 * NAME of the host env var holding it (spec §2 — the credentials invariant).
 *
 * Trust model (spec §2): `.taskcell/` is trusted-as-code — flow refs already execute repo TS on the
 * host — so this loader treats the file as trusted input and validates shape, not intent.
 */
export type { CustomProviderSpec };

/**
 * One configured entry: healthy (`spec` set) or broken (`error` set). `index` = array position
 * (-1 for the whole-file pseudo-entry). Invariant: `error` absent ⇔ the entry is runnable.
 */
export interface CustomProviderEntry {
  index: number;
  name?: string;
  error?: string;
  spec?: CustomProviderSpec;
}

// One repo-name grammar + entry vocabulary + entry shape, shared with the desktop via src/wire.ts (S7).
import { FLOW_NAME_RE as NAME_RE, KEY_ENV_RE, CUSTOM_PROVIDER_KEYS } from '../wire.js';
import type { CustomProviderSpec } from '../wire.js';
import { INJECTED_SECRET_ENV_VARS } from '../core/secret-scan.js';
import { stateDir } from '../core/state-path.js';

const ENTRY_KEYS: ReadonlySet<string> = new Set(CUSTOM_PROVIDER_KEYS);

/** `AgentProvider.name` prefix for run records; the grammar forbids `:` so collision is impossible. */
export const CUSTOM_PROVIDER_PREFIX = 'custom:';

/**
 * The one validity predicate for a customProviders entry (spec §4). Returns the first violated
 * rule, or undefined for a healthy entry. `seen` = names of ALL earlier named entries — healthy or
 * broken — so a later same-name entry is always flagged a duplicate (see the loader's note).
 */
export function customProviderError(entry: unknown, seen: ReadonlySet<string>): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'entry must be an object';
  const rec = entry as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ENTRY_KEYS.has(key)) return `unknown key "${key}" (allowed: name, baseUrl, keyEnv, model)`;
  }
  const { name, baseUrl, keyEnv, model } = rec;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return `"name" must match ${NAME_RE.source}`;
  }
  if (PROVIDER_NAMES.some((builtin) => builtin === name)) return `"${name}" is a built-in provider name`;
  if (seen.has(name)) return `duplicate provider name "${name}"`;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl) || !isUrl(baseUrl)) {
    return '"baseUrl" must be an absolute http:// or https:// URL';
  }
  if (typeof keyEnv !== 'string' || !KEY_ENV_RE.test(keyEnv)) {
    return `"keyEnv" must name an environment variable (${KEY_ENV_RE.source})`;
  }
  // A repo-defined provider must not borrow a credential Taskcell itself holds: its baseUrl is repo-chosen,
  // so naming e.g. CLAUDE_CODE_OAUTH_TOKEN here would send the operator's token to that host.
  if (isReservedKeyEnv(keyEnv)) {
    const what = OWN_PREFIX_RE.test(keyEnv) ? "a name reserved for Taskcell's own settings" : 'a credential Taskcell uses itself';
    return `"keyEnv" must not name ${what} (${keyEnv}); give the provider its own variable`;
  }
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    return '"model" must be a non-empty string when present';
  }
  return undefined;
}

// Credentials of Taskcell and of the tools a run uses that the injected-secret list does not carry.
const EXTRA_RESERVED_KEY_ENVS = [
  'GLAB_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLOUDFLARE_AUTH_TOKEN', 'LANGFUSE_SECRET_KEY', 'OTEL_EXPORTER_OTLP_HEADERS',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
];

const OWN_PREFIX_RE = /^(TASKCELL|VANGUARD)_/i;

/**
 * True when `keyEnv` names a variable Taskcell owns: its own namespaces (TASKCELL_ and VANGUARD_, e.g. the
 * hub secret), or a built-in provider's or git host's credential. Case-insensitive, as env names are on Windows.
 */
function isReservedKeyEnv(keyEnv: string): boolean {
  const upper = keyEnv.toUpperCase();
  return OWN_PREFIX_RE.test(upper)
    || (INJECTED_SECRET_ENV_VARS as readonly string[]).includes(upper)
    || EXTRA_RESERVED_KEY_ENVS.includes(upper);
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `customProviders` from `<repoPath>/.taskcell/app.json`. Lenient at the edges, loud at
 * resolution (spec §5): missing file / missing key / null / [] ⇒ [] (the desktop's emit-all serde
 * writes `"customProviders": null` for absent). An unreadable file or non-array value yields ONE
 * error-flagged pseudo-entry (index -1) — never a throw, so a broken config cannot break
 * built-in-provider runs. Invalid entries come back error-flagged per entry.
 */
export async function loadCustomProviders(repoPath: string): Promise<CustomProviderEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir(repoPath), 'app.json'), 'utf8');
  } catch {
    return []; // no config file — every repo without customs pays nothing
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ index: -1, error: `.taskcell/app.json is not valid JSON: ${message}` }];
  }
  const value = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).customProviders
    : undefined;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ index: -1, error: '"customProviders" must be an array' }];

  const entries: CustomProviderEntry[] = [];
  // Duplicate detection covers EVERY named entry, healthy or broken: if only healthy names counted,
  // [broken "x", healthy "x"] would leave both un-flagged as duplicates while resolveSpec's find()
  // hits the broken first — a usable definition silently shadowed by a typo'd one.
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const error = customProviderError(entry, seen);
    const rawName = typeof (entry as { name?: unknown })?.name === 'string' ? (entry as { name: string }).name : undefined;
    if (rawName !== undefined) seen.add(rawName);
    if (error !== undefined) {
      entries.push({ index, ...(rawName !== undefined ? { name: rawName } : {}), error: `customProviders[${index}]: ${error}` });
      continue;
    }
    const rec = entry as { name: string; baseUrl: string; keyEnv: string; model?: string };
    entries.push({
      index,
      name: rec.name,
      spec: {
        name: rec.name,
        baseUrl: rec.baseUrl,
        keyEnv: rec.keyEnv,
        ...(rec.model !== undefined ? { model: rec.model } : {}),
      },
    });
  }
  return entries;
}

/**
 * Runs an Anthropic-Messages-compatible custom endpoint by reusing the in-sandbox `claude` CLI —
 * the zai pattern with a configured base URL and (optionally) a forced default model. The transport
 * is owned by the runner: registry synthesis injects ANTHROPIC_BASE_URL=<baseUrl> and
 * ANTHROPIC_AUTH_TOKEN=<$keyEnv> into the sandbox and suppresses Anthropic authSecrets.
 */
export class CustomProvider implements AgentProvider {
  readonly name: string;

  constructor(private readonly spec: CustomProviderSpec) {
    this.name = `${CUSTOM_PROVIDER_PREFIX}${spec.name}`;
  }

  run(input: AgentRunInput): ReturnType<AgentProvider['run']> {
    const model = this.spec.model;
    const buildArgs = (i: AgentRunInput): string[] =>
      buildClaudeArgs(model !== undefined ? { ...i, model: i.model ?? model } : i);
    return runClaudeCli(input, buildArgs);
  }
}
