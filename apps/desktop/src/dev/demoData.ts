// Seed data for demo mode (`taskcell hub --demo`, or `?demo=1` from the empty Home): one fictional
// project with realistic history. Served by the in-browser fixture backend (mockBackend.ts), so
// nothing here ever reaches a repo, remote or hub store. Everything is labelled "demo" in the UI.
import type { Project, ActiveRun, RunSummary, RunDetail, RunRecord } from '../taskcell-output';
import type { BoardTask, FactoryState, NeedsYouItem, RepoLesson, RunEvent } from '../wire';
import { DEMO_REPO_URL } from '../transport';

export const DEMO_REPO_PATH = '/demo/storefront';
const REPO_SLUG = 'demo-org/storefront';
/** Dates are relative to now, so "in 24h" and the run ages agree whenever the demo is opened. */
const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
const T101 = ago(2);
const T102 = ago(5);
const T099 = ago(20);
const T097 = ago(50);

export const demoProject: Project = {
  path: DEMO_REPO_PATH,
  name: 'storefront (demo)',
  runCount: 5,
  taskCount: 10,
  totalCostUsd: 1.37,
  failedCount: 1,
  lastRun: T101,
  runningCount: 1,
  runsLast24h: 3,
  color: '#0ea5e9',
  taskSource: 'github',
};

/** The demo project is set up: its cards come from GitHub and the factory runs them. */
export const demoFactoryState: FactoryState = {
  state: 'ready',
  steps: (['pr', 'secret', 'merged', 'doctor'] as const).map((id) => ({ id, status: 'done' as const })),
};

export const demoRuns: RunSummary[] = [
  { taskId: 'DEMO-101', timestamp: T101, stages: ['planner', 'implement', 'reviewer'], totalCostUsd: 0.42, anyFailed: false, prUrl: `${DEMO_REPO_URL}/pull/101` },
  { taskId: 'DEMO-102', timestamp: T102, stages: ['planner', 'implement', 'reviewer'], totalCostUsd: 0.37, anyFailed: false, prUrl: `${DEMO_REPO_URL}/pull/102` },
  { taskId: 'DEMO-099', timestamp: T099, stages: ['planner', 'implement'], totalCostUsd: 0.31, anyFailed: true },
  { taskId: 'DEMO-097', timestamp: T097, stages: ['planner', 'implement', 'reviewer'], totalCostUsd: 0.27, anyFailed: false, prUrl: `${DEMO_REPO_URL}/pull/97` },
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
  timestamp: T101,
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

const ORDERS_DIFF = [
  'diff --git a/src/orders/history.ts b/src/orders/history.ts',
  '--- a/src/orders/history.ts',
  '+++ b/src/orders/history.ts',
  '@@ -5,4 +5,5 @@ import { orders } from "./store";',
  '-export function orderHistory(userId: string) {',
  '-  return orders.filter((o) => o.userId === userId);',
  '+export function orderHistory(userId: string, page = 1, size = 20) {',
  '+  const mine = orders.filter((o) => o.userId === userId);',
  '+  return mine.slice(page * size, (page + 1) * size);',
  ' }',
  '',
].join('\n');

const STOCK_DIFF = [
  'diff --git a/src/product/ProductPage.tsx b/src/product/ProductPage.tsx',
  '--- a/src/product/ProductPage.tsx',
  '+++ b/src/product/ProductPage.tsx',
  '@@ -14,3 +14,4 @@ export function ProductPage({ product }: Props) {',
  '       <h1>{product.name}</h1>',
  '       <Price value={product.price} />',
  '+      <p className="stock">{product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}</p>',
  '',
].join('\n');

/** One run's own story: what it planned, what it changed, what its tests said. `failed` runs stop after implement. */
const detail = (taskId: string, timestamp: string, diff: string, verdict: 'pass' | 'changes', passed: boolean, plan: string, costs: [number, number, number]): RunDetail => ({
  taskId,
  timestamp,
  ...(passed ? { prUrl: `${DEMO_REPO_URL}/pull/${Number(taskId.slice(-3))}`, diffUrl: `${DEMO_REPO_URL}/pull/${Number(taskId.slice(-3))}/files` } : {}),
  stages: [
    { record: record(taskId, 'planner', { turns: 4, costUsd: costs[0], timestamp }), transcript: transcript('Reading the code the task touches, then planning a minimal change.', plan) },
    {
      record: record(taskId, 'implement', { turns: 9, costUsd: costs[1], timestamp, ...(passed ? {} : { completed: false, exitReason: 'verify-failed' }) }),
      diff,
      transcript: transcript('Applying the change and running the test suite.', passed ? '✓ 58 tests passed' : '✗ 1 test failed: orders > pagination > first page'),
    },
    ...(passed ? [{
      record: record(taskId, 'reviewer', {
        turns: 3,
        costUsd: costs[2],
        timestamp,
        verdict,
        prUrl: `${DEMO_REPO_URL}/pull/${Number(taskId.slice(-3))}`,
        ...(verdict === 'changes'
          ? { findings: [{ severity: 'medium' as const, kind: 'correctness' as const, title: 'Empty query matches every product', evidence: 'search("") returns the whole catalog.' }] }
          : {}),
      }),
      transcript: transcript(verdict === 'pass' ? 'The change is correct and covered by a test. Verdict: pass.' : 'One finding needs a fix before merge. Verdict: changes.'),
    }] : []),
  ],
  proof: {
    command: 'pnpm test',
    exitCode: passed ? 0 : 1,
    passed,
    sha256: 'd3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0',
    outputTail: passed ? '✓ 58 tests passed in 4.1s' : '✗ 1 test failed: orders > pagination > first page',
  },
});

export const demoRunDetails: Record<string, RunDetail> = {
  'DEMO-101': detail('DEMO-101', T101, CART_DIFF, 'pass', true, 'Plan: 1. Round the cart total once. 2. Add a regression test. 3. Open a PR.', [0.05, 0.3, 0.07]),
  'DEMO-102': detail('DEMO-102', T102, SEARCH_DIFF, 'changes', true, 'Plan: 1. Compare names in lower case. 2. Add a test. 3. Open a PR.', [0.05, 0.25, 0.07]),
  'DEMO-099': detail('DEMO-099', T099, ORDERS_DIFF, 'changes', false, 'Plan: 1. Add page and size to orderHistory. 2. Test the first and last page. 3. Open a PR.', [0.05, 0.26, 0]),
  'DEMO-097': detail('DEMO-097', T097, STOCK_DIFF, 'pass', true, 'Plan: 1. Show the stock count under the price. 2. Add a test. 3. Open a PR.', [0.04, 0.17, 0.06]),
};

export const demoActiveRuns: ActiveRun[] = [
  { taskId: 'DEMO-104', sessionFile: `${DEMO_REPO_PATH}/.taskcell/sessions/DEMO-104.jsonl`, lastActivityMs: Date.now() },
];

/** The run in flight, as the hub's typed-run backlog would replay it: DEMO-104, plan done, implementing. */
export const DEMO_RUN_ID = 'demo-run-1';
export const DEMO_LIVE_COST_USD = 0.12;
const DEMO_RUN_STAGES = ['planner', 'implement', 'reviewer'];
export const demoRunBacklog: { runId: string; event: RunEvent | { type: 'run-accepted'; repoPath: string } }[] = [
  { type: 'run-accepted' as const, repoPath: DEMO_REPO_PATH },
  { type: 'run-start' as const, taskId: 'DEMO-104', flow: 'default', provider: 'claude', stages: DEMO_RUN_STAGES },
  { type: 'stage-start' as const, name: 'planner', index: 0, of: 3 },
  { type: 'stage-end' as const, name: 'planner', index: 0, of: 3, outcome: 'completed' },
  { type: 'stage-start' as const, name: 'implement', index: 1, of: 3 },
  { type: 'cost' as const, usdSpent: DEMO_LIVE_COST_USD },
].map((event) => ({ runId: DEMO_RUN_ID, event }));

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
  { id: 'DEMO-110', title: 'Checkout button misaligned on small screens', column: 'queued', state: 'Needs info' },
];

export const demoNeedsYou: NeedsYouItem[] = [
  {
    id: `${REPO_SLUG}#102`,
    kind: 'pr',
    number: 102,
    repoSlug: REPO_SLUG,
    title: 'Case-insensitive product search',
    url: `${DEMO_REPO_URL}/pull/102`,
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
    url: `${DEMO_REPO_URL}/issues/110`,
    reason: 'needs info',
    lastComment: { author: 'taskcell[bot]', body: 'Which device and browser width does this reproduce on?' },
  },
  {
    id: `${REPO_SLUG}#99`,
    kind: 'pr',
    number: 99,
    repoSlug: REPO_SLUG,
    title: 'Paginate the order history',
    url: `${DEMO_REPO_URL}/pull/99`,
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
  { id: 'demo-l1', rule: 'Round money once, at the end of the sum.', why: 'Per-line rounding drifted the cart total by a cent.', evidence: `${DEMO_REPO_URL}/pull/101`, paths: ['src/cart/**'], stage: 'review', prNumber: 101, timestamp: T101 },
];
/** The lessons a task's text calls for: the money lesson belongs to the cart, not to every card. */
export const demoLessonsFor = (taskText: string | undefined): RepoLesson[] =>
  taskText === undefined || /cart|checkout|receipt/i.test(taskText) ? demoLessons : [];

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
