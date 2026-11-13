import { labelForms } from '../core/labels.js';
import { parseSpecManifest } from '../pipeline/conformance-gate.js';
import { FACTORY_BRANCH_PREFIXES, isFactoryBranch } from '../worktree/manager.js';
import { trustedSpecText } from './comment-trust.js';
import { defaultGhRunner } from './github.js';
import type { GhRunner } from './github.js';
import type { Task } from './fetcher.js';
import { readEnv } from '../core/env.js';

const DEFAULT_OVERLAP_HOLD_HOURS = 6;
const LIST_LIMIT = 100;

/** Branch-name prefixes of factory runs for a GitHub task id (`owner/repo#N` or a slug): `chore/taskcell-gh-owner-repo-N-`, then the pre-rename `chore/vanguard-` form; parse with all of them. */
export function githubBranchPrefixes(taskId: string): string[] {
  return FACTORY_BRANCH_PREFIXES.map((p) => `${p}gh-${taskId.replace(/[^a-zA-Z0-9]/g, '-')}-`);
}

/**
 * Wait cap in ms from `TASKCELL_OVERLAP_HOLD_HOURS` (default 6; unset or empty also means the default);
 * `0` turns the overlap hold off.
 */
export function overlapHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = readEnv('TASKCELL_OVERLAP_HOLD_HOURS', env)?.trim();
  const hours = raw === undefined || raw === '' ? DEFAULT_OVERLAP_HOLD_HOURS : Number(raw);
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_OVERLAP_HOLD_HOURS) * 3_600_000;
}

/** An open factory PR or in-flight factory run and the files it touches (or, for a hold, the shared ones). */
export interface OverlapHold {
  kind: 'pr' | 'run';
  number: number;
  files: string[];
}

const SHARED_PATHS: ReadonlySet<string> = new Set([
  // Output of scripts/gen-desktop-wire.ts (src/wire.ts and src/hub-wire.ts are the hand-written sources).
  'apps/desktop/src/wire.ts',
  'apps/desktop/src/hub-wire.ts',
  'src/hub/commands/index.ts',
]);

/** Generated and aggregate files: every PR may legitimately touch them, so they never count as overlap. */
export function isSharedPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return (
    SHARED_PATHS.has(path) ||
    /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/.test(name) ||
    /^changelog(?:\.\w+)?$/i.test(name) ||
    /(?:^|[/.-])generated(?:[/.-]|$)/i.test(path)
  );
}

/** Marker on the hold comment: `until` is when the hold stops (fixed at the first hold), `refs` the `pr:N` / `run:N` it waits for. */
export const overlapMarker = (until: Date, holds: readonly OverlapHold[]): string =>
  `<!-- taskcell:overlap until="${until.toISOString()}" refs="${holds.map((h) => `${h.kind}:${h.number}`).join(',')}" -->`;
const OVERLAP_MARKER_RE = /<!-- (?:taskcell|vanguard):overlap until="([^"]+)" refs="([^"]*)" -->/;

/** The first overlap marker among comment bodies (pass newest first for the latest). */
export function findOverlapMarker(bodies: readonly string[]): { until: Date; refs: { kind: 'pr' | 'run'; number: number }[] } | undefined {
  for (const body of bodies) {
    const m = OVERLAP_MARKER_RE.exec(body);
    const until = m === null ? undefined : new Date(m[1]!);
    if (m === null || until === undefined || Number.isNaN(until.getTime())) continue;
    const refs = m[2]!.split(',').flatMap((ref) => {
      const parsed = /^(pr|run):(\d+)$/.exec(ref);
      return parsed === null ? [] : [{ kind: parsed[1] as 'pr' | 'run', number: Number(parsed[2]) }];
    });
    return { until, refs };
  }
  return undefined;
}

type Work = OverlapHold & { branch?: string };

const numberOf = (task: Task): number => Number(task.ref ?? task.id.slice(task.id.indexOf('#') + 1));

/** The manifest's file paths of a task (trusted spec text only); undefined when it has no manifest. */
const manifestFiles = (task: Task): string[] | undefined => parseSpecManifest(trustedSpecText(task))?.files?.map((f) => f.path);

export interface OverlapCheckerOptions {
  repo: string;
  /** Label of in-flight runs, e.g. `taskcell:running`. */
  claimedLabel: string;
  /** Full task (comments, author) for an issue id; list() carries neither. */
  fetch: (id: string) => Promise<Task>;
  list: (labels: string[], limit: number) => Promise<Task[]>;
  gh?: GhRunner;
}

/**
 * Returns a per-task overlap check; open work is loaded once, on first use. Open same-repo factory PRs
 * (`chore/taskcell-*` (or pre-rename `chore/vanguard-*`) branches; a fork's are ignored) contribute their diff files, in-flight runs their
 * manifest files, and so does each task this checker already let through (so issues labelled together
 * do not start side by side). A task without a manifest has no overlap; a task is never its own overlap,
 * nor held by the PR of an earlier run of itself. White-label runs (`feat/` branches) are not covered.
 */
export function createOverlapChecker(opts: OverlapCheckerOptions): (task: Task) => Promise<OverlapHold[]> {
  const gh = opts.gh ?? defaultGhRunner;
  let loaded: Promise<Work[]> | undefined;
  const admitted: Work[] = [];
  const load = (): Promise<Work[]> => {
    loaded ??= (async () => {
      const prs = JSON.parse(
        await gh(['pr', 'list', '--repo', opts.repo, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,headRefName,isCrossRepository,files']),
      ) as { number: number; headRefName?: string; isCrossRepository?: boolean; files?: { path: string }[] }[];
      const work: Work[] = prs
        .filter((pr) => pr.isCrossRepository !== true && isFactoryBranch(pr.headRefName))
        .map((pr) => ({ kind: 'pr' as const, number: pr.number, files: (pr.files ?? []).map((f) => f.path), branch: pr.headRefName! }));
      const runs = new Map<string, Task>();
      for (const form of labelForms(opts.claimedLabel)) for (const run of await opts.list([form], LIST_LIMIT)) runs.set(run.id, run);
      for (const run of runs.values()) {
        const files = manifestFiles(await opts.fetch(run.id));
        if (files !== undefined) work.push({ kind: 'run', number: numberOf(run), files });
      }
      return work;
    })();
    return loaded;
  };
  return async (task) => {
    const files = manifestFiles(task.author === undefined ? await opts.fetch(task.id) : task);
    if (files === undefined) return [];
    const mine = new Set(files.filter((f) => !isSharedPath(f)));
    const self = numberOf(task);
    const ownBranches = githubBranchPrefixes(task.id);
    const holds = [...(await load()), ...admitted].flatMap((work) => {
      if (work.kind === 'run' && work.number === self) return [];
      if (ownBranches.some((p) => work.branch?.startsWith(p) === true)) return [];
      const shared = [...new Set(work.files)].filter((f) => mine.has(f));
      return shared.length > 0 ? [{ kind: work.kind, number: work.number, files: shared }] : [];
    });
    if (holds.length === 0) admitted.push({ kind: 'run', number: self, files: [...mine] });
    return holds;
  };
}

/** `PR #12` / `run #34` plus the files, for the hold comment. */
export const describeHold = (hold: OverlapHold): string => `${hold.kind === 'pr' ? 'PR' : 'run'} #${hold.number} (${hold.files.map((f) => `\`${f}\``).join(', ')})`;
