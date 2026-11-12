import { diffSections, extractDiffFiles } from '../pipeline/conformance-gate.js';
import { matchGlob } from '../approver/policy.js';
import { resolveRemoteBaseRef } from '../core/base-branch.js';
import { showStateFile } from '../core/state-path.js';

/**
 * A file the verify gate's own repo config touches. `patch` is the file's diff hunk text (one
 * `diff --git ...` block) — only consulted for package.json, to tell a scripts.verify/test/lint/
 * typecheck edit from an unrelated change (e.g. a dependency bump).
 */
export interface GateConfigDiffFile {
  path: string;
  patch?: string | undefined;
}

/**
 * Built-in gate-config path globs — the same mini-glob syntax as the approver's pathRules (see
 * approver/policy.ts#compileGlob). A repo can add to this list via `.taskcell/gate-config.json`
 * (see loadGateConfigExtraGlobs). package.json is handled separately (packageJsonScriptsChanged):
 * whether it counts as gate config depends on which script changed, not just the path.
 */
export const DEFAULT_GATE_CONFIG_GLOBS: readonly string[] = [
  '**/vitest.config.*',
  '**/jest.config.*',
  '**/eslint.config.*',
  '**/.eslintrc*',
  '**/tsconfig*.json',
  '**/.prettierrc*',
  '**/pyproject.toml',
  '**/setup.cfg',
  '**/pytest.ini',
  '**/.coveragerc',
  'skills/**',
  '.github/vanguard-skills/**',
  'skills.lock.json',
  // The list that decides what counts as gate config is gate config itself: narrowing it (or
  // deleting it) weakens every check above, so it goes through the same human gate.
  '.taskcell/gate-config.json',
  '.vanguard/gate-config.json',
  // The auto-approver's policy (required checks, path rules, size caps): loosening it is the same
  // kind of change, read by approver/policy.ts.
  '.taskcell/approver.json',
  '.vanguard/approver.json',
];

/** The heading gateConfigChangedBlock emits. */
const GATE_CONFIG_HEADING = '## Gate config changed';
/**
 * Explicit delimiters around the block, so extractGateConfigBlock knows exactly where it ends. A
 * `##`-heading scan is not enough: in a real first-delivery body the block is followed by the
 * `Closes`/`Part of` line and the attribution line before the next heading (see source-adapter.ts),
 * so such a scan over-captures those lines and can carry a stale `Closes #N` into a re-derived body.
 * Same sentinel idiom as the AGENTS.md block in context/skill-registry.ts.
 */
const GATE_CONFIG_BLOCK_START = '<!-- vanguard:gate-config:start -->';
const GATE_CONFIG_BLOCK_END = '<!-- vanguard:gate-config:end -->';

const PACKAGE_JSON_PATH = /(^|[\\/])package\.json$/;
/** Every `"key": "value"` pair on a line (compact JSON can hold several), key and value captured. */
const STRING_ENTRY_RE = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
/** A gate script, a pre/post hook npm runs around one, or a `<gate>:*` sub-script: always gate config. */
const GATE_SCRIPT_KEY_RE = /^(?:pre|post)?(?:verify|test|lint|typecheck)(?::.*)?$/;
/** Values a dependency entry can take: semver ranges, tags and protocol specifiers. */
const DEPENDENCY_VALUE_RE = /^(?:[\^~<>=*\d]|v\d|latest$|next$|workspace:|npm:|file:|link:|portal:|patch:|catalog:|git[+:]|github:|https?:)/;
/** Top-level package.json string fields that are not scripts. */
const NON_SCRIPT_KEYS = new Set(['name', 'version', 'description', 'main', 'module', 'browser', 'types', 'typings', 'type', 'license', 'author', 'homepage', 'packageManager', 'private', 'node', 'pnpm', 'npm', 'yarn']);

/**
 * Whether a package.json diff hunk may add, remove or edit a script. Any script counts, not only
 * verify/test/lint/typecheck: npm runs `pretest`/`posttest` around `test`, and a gate script often
 * delegates (`"verify": "pnpm test:unit"`), so an edit to any of them can change what a gate runs.
 * A hunk only carries a few context lines, so it cannot tell which object a line sits in; instead a
 * changed `"key": "value"` line counts unless the value is a dependency specifier or the key a known
 * non-script field; a gate script key (or its pre/post hook) counts whatever its value. Heuristic, same spirit as the diff-content checks in approver/diff-facts.ts: a
 * dependency bump never matches, and an odd non-script string field may over-match.
 */
export function packageJsonScriptsChanged(patch: string): boolean {
  // A changed line that names the scripts object itself (compact JSON, adding or dropping the block).
  if (/^[+-].*"scripts"\s*:/m.test(patch)) return true;
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .some((line) =>
      [...line.matchAll(STRING_ENTRY_RE)].some(([, key = '', value = '']) =>
        GATE_SCRIPT_KEY_RE.test(key) || (!NON_SCRIPT_KEYS.has(key) && !DEPENDENCY_VALUE_RE.test(value)),
      ),
    );
}

/**
 * The gate-config paths among `files`, sorted. `extraGlobs` (from a repo's own
 * `.taskcell/gate-config.json`) are matched in addition to the built-in list. Empty ⇒ nothing to flag.
 */
export function gateConfigPaths(files: readonly GateConfigDiffFile[], extraGlobs: readonly string[] = []): string[] {
  const globs = [...DEFAULT_GATE_CONFIG_GLOBS, ...extraGlobs];
  return files
    .filter((f) => globs.some((g) => matchGlob(g, f.path)) || (PACKAGE_JSON_PATH.test(f.path) && packageJsonScriptsChanged(f.patch ?? '')))
    .map((f) => f.path)
    .sort();
}

/** Every file a unified diff touches, paired with its own hunk text — the input gateConfigPaths and gateConfigChangedBlock need. */
export function diffFilesWithPatches(diff: string): GateConfigDiffFile[] {
  const sections = diffSections(diff);
  return extractDiffFiles(diff).map((path) => ({ path, patch: sections.get(path) }));
}

const GATE_CONFIG_FILES_LISTED = 20;
const GATE_CONFIG_LINES_PER_FILE = 10;
/** Cap on a single excerpt line — a minified/generated changed line (e.g. a bundled config) can run
 * hundreds of KB, and `gh pr create --body` 422s over 65,536 chars with no partial-delivery recovery
 * (the branch is already pushed). Same bound style as retrospective-memory.ts's `truncate`. */
const GATE_CONFIG_LINE_MAX_CHARS = 200;

/** `+`/`-` content lines of a diff hunk, excluding the `+++`/`---` file headers, each capped to
 * GATE_CONFIG_LINE_MAX_CHARS so one oversized line cannot blow the PR body past GitHub's limit. */
function changedLinesOnly(patch: string): string[] {
  return patch
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .map((l) => (l.length > GATE_CONFIG_LINE_MAX_CHARS ? `${l.slice(0, GATE_CONFIG_LINE_MAX_CHARS)}…` : l));
}

/** The longest run of backticks in `text` (0 when it holds none). */
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
}

/**
 * Fence-safe: an agent-written file whose content has a ``` line would close a 3-backtick block and
 * inject PR-body markdown — forging the attestation blocks around this one. Use a fence one backtick
 * longer than the longest run in the content (same as proofBlock in pipeline/verify.ts).
 */
function fenceFor(content: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
}

/**
 * `text` as a Markdown code span whose delimiter is longer than any backtick run inside it, padded
 * with spaces when it starts or ends with a backtick (CommonMark strips one such pair). A path is
 * agent-written too, so it must not be able to close the span it sits in either.
 */
function codeSpan(text: string): string {
  const delim = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${delim}${pad}${text}${pad}${delim}`;
}

/**
 * PR-body block naming each gate-config file this diff touches, with a bounded excerpt of its
 * changed lines — so a human reviewer sees the weakening (or the justification) without a full
 * diff dump. `files` should already be filtered to the paths gateConfigPaths returned.
 */
export function gateConfigChangedBlock(files: readonly GateConfigDiffFile[]): string {
  if (files.length === 0) return '';
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const shown = sorted.slice(0, GATE_CONFIG_FILES_LISTED);
  const fileLines = shown.flatMap((f) => {
    const lines = changedLinesOnly(f.patch ?? '');
    const changed = lines.slice(0, GATE_CONFIG_LINES_PER_FILE);
    const more = lines.length - changed.length;
    if (changed.length === 0) return [`- ${codeSpan(f.path)}`];
    const fence = fenceFor(changed.join('\n'));
    return [`- ${codeSpan(f.path)}`, `  ${fence}diff`, ...changed.map((l) => `  ${l}`), `  ${fence}`, ...(more > 0 ? [`  …and ${more} more line(s).`] : [])];
  });
  const moreFiles = sorted.length > GATE_CONFIG_FILES_LISTED ? [`…and ${sorted.length - GATE_CONFIG_FILES_LISTED} more file(s).`] : [];
  const content = [
    GATE_CONFIG_HEADING,
    '',
    "This diff touches checker config the verify gate runs from the agent's own worktree (coverage thresholds, lint rules, type settings, or the verify/test/lint/typecheck scripts). Weakening a check here — lowering a threshold, disabling a rule, relaxing a type setting, loosening a script — is blocking for review unless the linked issue explicitly asked for it.",
    '',
    ...fileLines,
    ...moreFiles,
  ].join('\n');
  // Paths and excerpt lines are agent-written: a delimiter inside them would truncate (or forge) the
  // block extractGateConfigBlock carries forward, so they are defanged like skill-registry.ts does.
  return [GATE_CONFIG_BLOCK_START, defangBlockDelimiters(content), GATE_CONFIG_BLOCK_END].join('\n');
}

function defangBlockDelimiters(text: string): string {
  return text
    .replaceAll(GATE_CONFIG_BLOCK_START, '[vanguard:gate-config:start]')
    .replaceAll(GATE_CONFIG_BLOCK_END, '[vanguard:gate-config:end]');
}

/**
 * Recover an existing gate-config block from a previously-posted PR body, so a caller that re-derives
 * the whole body (revise-pr.ts, every round) can carry the disclosure forward even on a round that
 * itself touches no gate config — otherwise re-deriving the body silently drops the evidence of the
 * original weakening. Delimited strictly by the marker pair gateConfigChangedBlock emits, so nothing
 * around the block (the `Closes`/`Part of` line, the attribution line) is ever captured with it;
 * `undefined` when `body` carries no complete marker pair — a body posted before the markers existed
 * loses the carry-forward rather than risking a stale closing keyword, and keeps its gate label.
 */
export function extractGateConfigBlock(body: string): string | undefined {
  const start = body.indexOf(GATE_CONFIG_BLOCK_START);
  const end = body.indexOf(GATE_CONFIG_BLOCK_END, start);
  if (start === -1 || end === -1) return undefined;
  return body.slice(start, end + GATE_CONFIG_BLOCK_END.length);
}

/**
 * Extra gate-config globs from `.taskcell/gate-config.json` (`{ "extraGlobs": string[] }`) on the
 * base branch, read via the same remote-tracking-ref resolution as the approver's own base-branch
 * read (approver/policy.ts#loadPolicy) rather than the shorthand `origin/<base>` — which can resolve
 * to `refs/tags/origin/<base>` or `refs/heads/origin/<base>` before the remote-tracking ref, and which
 * silently reads nothing on a checkout with no remote-tracking ref for `base` (the common
 * actions/checkout single-ref/shallow fetch). A repo-configured `extraGlobs` disappearing without a
 * signal is a worse failure mode than a missing/malformed file, so the two are logged distinctly;
 * only the fall-through result (no extra globs) is the same for both, which only ever narrows
 * detection back to the built-in list, never below it.
 */
export async function loadGateConfigExtraGlobs(repoPath: string, base: string): Promise<string[]> {
  let ref: string;
  try {
    ref = await resolveRemoteBaseRef(repoPath, base, { label: 'gate-config', keepLocalIfAhead: false });
  } catch (err) {
    console.warn(`taskcell: gate-config extraGlobs — could not resolve base branch ${JSON.stringify(base)}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  let raw: string;
  try {
    raw = await showStateFile(repoPath, ref, 'gate-config.json');
  } catch {
    console.log(`taskcell: gate-config — no .taskcell/gate-config.json (or legacy .vanguard/) found at ${ref}; extraGlobs stay empty`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { extraGlobs?: unknown };
    return Array.isArray(parsed.extraGlobs) ? parsed.extraGlobs.filter((g): g is string => typeof g === 'string') : [];
  } catch (err) {
    console.warn(`taskcell: gate-config — gate-config.json at ${ref} is unparseable, ignoring extraGlobs: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
