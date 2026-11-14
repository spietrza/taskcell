// Seed data for demo mode (`taskcell hub --demo`, or `?demo=1` from the empty Home): one fictional
// project with realistic history. Served by the in-browser fixture backend (mockBackend.ts), so
// nothing here ever reaches a repo, remote or hub store. Everything is labelled "demo" in the UI.
import type { Project, ActiveRun, RunSummary, RunDetail, RunRecord } from '../taskcell-output';
import type { BoardTask, NeedsYouItem, RepoLesson } from '../wire';

export const DEMO_REPO_PATH = '/demo/storefront';
const REPO_SLUG = 'demo-org/storefront';

export const demoProject: Project = {
  path: DEMO_REPO_PATH,
  name: 'storefront (demo)',
  runCount: 5,
  taskCount: 9,
  totalCostUsd: 1.37,
  failedCount: 1,
  lastRun: '2026-07-14T10:30:00.000Z',
  runningCount: 1,
  runsLast24h: 3,
  color: '#0ea5e9',
};

export const demoRuns: RunSummary[] = [
  { taskId: 'DEMO-101', timestamp: '2026-07-14T10:30:00.000Z', stages: ['planner', 'implement', 'reviewer'], totalCostUsd: 0.42, anyFailed: false, prUrl: `https://github.com/${REPO_SLUG}/pull/101` },
  { taskId: 'DEMO-102', timestamp: '2026-07-14T08:10:00.000Z', stages: ['planner', 'implement', 'reviewer'], totalCostUsd: 0.37, anyFailed: false, prUrl: `https://github.com/${REPO_SLUG}/pull/102` },
  { taskId: 'DEMO-099', timestamp: '2026-07-13T16:45:00.000Z', stages: ['planner', 'implement'], totalCostUsd: 0.31, anyFailed: true },
  { taskId: 'DEMO-097', timestamp: '2026-07-12T11:20:00.000Z', stages: ['implement', 'reviewer'], totalCostUsd: 0.27, anyFailed: false, prUrl: `https://github.com/${REPO_SLUG}/pull/97` },
];

const record = (taskId: string, stage: string, over: Partial<RunRecord> = {}): RunRecord => ({
  taskId,
  stage,
  completed: true,
  exitReason: 'complete',
  turns: 6,
  sessionId: `demo-${taskId}-${stage}`,
  worktreePath: `${DEMO_REPO_PATH}/.taskcell/worktrees/${taskId}`,
  worktreePreserved: false,
  finalText: 'Done.',
  usage: { inputTokens: 38000, outputTokens: 6400, cacheReadInputTokens: 9000 },
  costUsd: 0.14,
  cacheEfficiency: 0.2,
  durationMs: 95000,
  model: 'claude-sonnet-4-6',
  timestamp: '2026-07-14T10:30:00.000Z',
  ...over,
});

const transcript = (...texts: string[]): string =>
  texts.map((text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })).join('\n');

const CART_DIFF = [
  'diff --git a/src/cart/totals.ts b/src/cart/totals.ts',
  '--- a/src/cart/totals.ts',
  '+++ b/src/cart/totals.ts',
  '@@ -8,7 +8,9 @@ export function cartTotal(items: CartItem[]): number {',
  '-  return items.reduce((sum, i) => sum + i.price * i.qty, 0);',
  '+  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);',
  '+  // Round once at the end so per-line cents never drift.',
  '+  return Math.round(subtotal * 100) / 100;',
  ' }',
  'diff --git a/src/cart/totals.test.ts b/src/cart/totals.test.ts',
  '--- a/src/cart/totals.test.ts',
  '+++ b/src/cart/totals.test.ts',
  '@@ -12,3 +12,8 @@ describe("cartTotal", () => {',
  '   it("sums line totals", () => {',
  '     expect(cartTotal([{ price: 2, qty: 3 }])).toBe(6);',
  '   });',
  '+  it("does not drift on fractional cents", () => {',
  '+    expect(cartTotal([{ price: 0.1, qty: 3 }])).toBe(0.3);',
  '+  });',
  ' });',
  '',
].join('\n');

const SEARCH_DIFF = [
  'diff --git a/src/search/index.ts b/src/search/index.ts',
  '--- a/src/search/index.ts',
  '+++ b/src/search/index.ts',
  '@@ -3,4 +3,6 @@ import { catalog } from "../catalog";',
  ' export function search(query: string) {',
  '-  return catalog.filter((p) => p.name.includes(query));',
  '+  const q = query.trim().toLowerCase();',
  '+  return catalog.filter((p) => p.name.toLowerCase().includes(q));',
  ' }',
  '',
].join('\n');

const detail = (taskId: string, timestamp: string, diff: string, verdict: 'pass' | 'changes', passed: boolean): RunDetail => ({
  taskId,
  timestamp,
  prUrl: `https://github.com/${REPO_SLUG}/pull/${taskId.slice(-3)}`,
  diffUrl: `https://github.com/${REPO_SLUG}/pull/${taskId.slice(-3)}/files`,
  stages: [
    { record: record(taskId, 'planner', { turns: 4, costUsd: 0.05, timestamp }), transcript: transcript('Reading the cart module, then planning a minimal fix.', 'Plan: 1. Fix the rounding. 2. Add a regression test. 3. Open a PR.') },
    { record: record(taskId, 'implement', { turns: 9, costUsd: 0.24, timestamp }), diff, transcript: transcript('Applying the change and running the test suite.', '✓ 58 tests passed') },
    {
      record: record(taskId, 'reviewer', {
        turns: 3,
        costUsd: 0.07,
        timestamp,
        verdict,
        prUrl: `https://github.com/${REPO_SLUG}/pull/${taskId.slice(-3)}`,
        ...(verdict === 'changes'
          ? { findings: [{ severity: 'medium' as const, kind: 'correctness' as const, title: 'Empty query matches every product', evidence: 'search("") returns the whole catalog.' }] }
          : {}),
      }),
      transcript: transcript(verdict === 'pass' ? 'The change is correct and covered by a test. Verdict: pass.' : 'One finding needs a fix before merge. Verdict: changes.'),
    },
  ],
  proof: {
    command: 'pnpm test',
    exitCode: passed ? 0 : 1,
    passed,
    sha256: 'd3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0',
    outputTail: passed ? '✓ 58 tests passed in 4.1s' : '✗ 1 test failed: search > empty query',
  },
});

export const demoRunDetails: Record<string, RunDetail> = {
  'DEMO-101': detail('DEMO-101', '2026-07-14T10:30:00.000Z', CART_DIFF, 'pass', true),
  'DEMO-102': detail('DEMO-102', '2026-07-14T08:10:00.000Z', SEARCH_DIFF, 'changes', true),
  'DEMO-099': detail('DEMO-099', '2026-07-13T16:45:00.000Z', SEARCH_DIFF, 'changes', false),
  'DEMO-097': detail('DEMO-097', '2026-07-12T11:20:00.000Z', CART_DIFF, 'pass', true),
};

export const demoActiveRuns: ActiveRun[] = [
  { taskId: 'DEMO-104', sessionFile: `${DEMO_REPO_PATH}/.taskcell/sessions/DEMO-104.jsonl`, lastActivityMs: Date.now() },
];

const chips = (...c: [string, string, 'pass' | 'changes' | 'failed'][]): { key: string; label: string; tone: 'pass' | 'changes' | 'failed' }[] =>
  c.map(([key, label, tone]) => ({ key, label, tone }));

/** The dependency chain: DEMO-107 waits on DEMO-106, which waits on DEMO-104 (running now). */
export const demoBoardTasks: BoardTask[] = [
  { id: 'DEMO-101', title: 'Fix cart total rounding', column: 'done', state: 'Done', chips: chips(['reviewer', 'reviewer: pass', 'pass'], ['proof', 'proof: pass', 'pass']) },
  { id: 'DEMO-097', title: 'Show stock level on product page', column: 'done', state: 'Done', chips: chips(['reviewer', 'reviewer: pass', 'pass']) },
  { id: 'DEMO-102', title: 'Case-insensitive product search', column: 'review', state: 'In Review', chips: chips(['reviewer', 'reviewer: changes', 'changes'], ['proof', 'proof: pass', 'pass']) },
  { id: 'DEMO-099', title: 'Paginate the order history', column: 'verify-failed', state: 'Verify failed', chips: chips(['proof', 'proof: fail', 'failed']) },
  { id: 'DEMO-104', title: 'Add wishlist to the account page', column: 'running', state: 'In Progress', stage: 'implement' },
  { id: 'DEMO-105', title: 'Email receipt after checkout', column: 'queued', state: 'Ready for agent', waiting: true },
  { id: 'DEMO-106', title: 'Wishlist: share by link (blocked by DEMO-104)', column: 'queued', state: 'Blocked by DEMO-104' },
  { id: 'DEMO-107', title: 'Wishlist: price-drop alerts (blocked by DEMO-106)', column: 'queued', state: 'Blocked by DEMO-106' },
  { id: 'DEMO-108', title: 'Dark mode for the storefront', column: 'queued', state: 'Ready for agent', waiting: true },
];

export const demoNeedsYou: NeedsYouItem[] = [
  {
    id: `${REPO_SLUG}#102`,
    kind: 'pr',
    number: 102,
    repoSlug: REPO_SLUG,
    title: 'Case-insensitive product search',
    url: `https://github.com/${REPO_SLUG}/pull/102`,
    reason: 'taskcell:needs-human-review',
    baseRef: 'main',
    lastComment: { author: 'taskcell[bot]', body: 'The reviewer found an empty-query edge case; a human call on scope is needed.' },
  },
  {
    id: `${REPO_SLUG}#110`,
    kind: 'issue',
    number: 110,
    repoSlug: REPO_SLUG,
    title: 'Checkout button misaligned on small screens',
    url: `https://github.com/${REPO_SLUG}/issues/110`,
    reason: 'needs info',
    lastComment: { author: 'taskcell[bot]', body: 'Which device and browser width does this reproduce on?' },
  },
  {
    id: `${REPO_SLUG}#99`,
    kind: 'pr',
    number: 99,
    repoSlug: REPO_SLUG,
    title: 'Paginate the order history',
    url: `https://github.com/${REPO_SLUG}/pull/99`,
    reason: 'taskcell:verify-failed',
    baseRef: 'main',
    lastComment: { author: 'taskcell[bot]', body: 'pnpm test failed: 1 test in orders/pagination.' },
  },
];

/** Each card's own spec, so no two runs show the same text. */
export const demoSpec = (taskId: string | undefined): string => {
  const title = demoBoardTasks.find((t) => t.id === taskId)?.title ?? 'Demo task';
  return `## Task\n\n${title}.\n\n## Acceptance criteria\n\n- [ ] ${title} works as described\n- [ ] A test covers it\n- [ ] \`pnpm test\` passes\n`;
};

export const demoLessons: RepoLesson[] = [
  { id: 'demo-l1', rule: 'Round money once, at the end of the sum.', why: 'Per-line rounding drifted the cart total by a cent.', evidence: `https://github.com/${REPO_SLUG}/pull/101`, paths: ['src/cart/**'], stage: 'review', prNumber: 101, timestamp: '2026-07-14T10:40:00.000Z' },
];

/** Commands that would write to a repo, remote or the hub's store: refused in demo mode. */
export const DEMO_WRITE_COMMANDS: readonly string[] = [
  'add_project', 'remove_project', 'clone_project', 'write_app_config', 'spawn_run', 'kill_run',
  'api_create_run', 'api_create_task', 'api_write_flow', 'api_delete_flow', 'api_cancel',
  'reply_needs_you', 'merge_needs_you', 'dismiss_lesson', 'start_task', 'import_remote_run',
  'enable_factory_plan', 'enable_factory_apply', 'enable_factory_secret', 'enable_factory_verify', 'enable_factory_start',
  'set_credential', 'delete_credential', 'save_user_credential', 'delete_user_credential',
  'set_credential_policy', 'save_instance_credential', 'delete_instance_credential',
  'add_team_member', 'remove_team_member', 'add_team_repository', 'remove_team_repository',
];
