// Enable factory (#hub): turn on the Taskcell factory on the platform the user picks, from the
// hub's "Add project" -> "Enable factory" action. GitHub Actions only for now (the ticket's scope);
// GitLab and Linear plug into the same `FactoryProvider` seam later (see docs/hub.md).
//
// Three steps, matching docs/onboarding-another-repo.md: plan (read the repo, show what will
// change), apply (branch + the five callers from templates/github/ + a PR + the three labels —
// NEVER a push to the default branch), secret (print the `gh secret set` command text — the hub
// never reads, prints or stores a secret value), verify (dispatch the doctor workflow once the PR
// is merged, report its latest run).
import { execa } from 'execa';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { resolveVerifyCommand } from '../pipeline/verify.js';
import { listRemoteRuns } from './remote.js';
import type { FactoryApplyResult, FactoryPlan, FactoryProviderId, FactorySecretStep, FactoryVerifyResult } from '../wire.js';

// FactoryPlan/FactoryApplyResult/FactorySecretStep/FactoryVerifyResult/FactoryProviderId live in
// src/wire.ts (the shared desktop contract — S7); re-exported here so callers can keep importing
// them from './enable-factory.js'.
export type { FactoryApplyResult, FactoryPlan, FactoryProviderId, FactorySecretStep, FactoryVerifyResult } from '../wire.js';

/** The caller templates this adapter copies into a target repo (see templates/github/). */
export const CALLER_NAMES = ['implement', 'doctor', 'pr-review', 'revise', 'resume'] as const;
export type CallerName = (typeof CALLER_NAMES)[number];

/** Labels `apply` creates — the routing/rejection labels an issue or PR needs (see
 * docs/onboarding-another-repo.md's label reference). Color is GitHub's default label palette. */
export const FACTORY_LABELS = [
  { name: 'ready for agent', color: '0E8A16' },
  { name: 'needs revision', color: 'D93F0B' },
  { name: 'needs info', color: 'FBCA04' },
] as const;

const TEMPLATES_DIR = new URL('../../templates/github/', import.meta.url);

/** Placeholder every template carries; `apply` replaces it with the signed-in gh login. */
const LOGIN_PLACEHOLDER = 'YOUR_LOGIN';

/** Injectable shell-out, defaulting to the real `execa` — tests pass a fake (no network, no git). */
export interface FactoryExec {
  (file: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
}

const defaultExec: FactoryExec = (file, args, options) => execa(file, args, options);

export interface GithubFactoryDeps {
  exec?: FactoryExec;
}

/** The provider-adapter seam: GitLab and Linear (UI "coming soon") implement this later. */
export interface FactoryProvider {
  plan(): Promise<FactoryPlan>;
  apply(plan: FactoryPlan): Promise<FactoryApplyResult>;
  secretCommand(plan: FactoryPlan): FactorySecretStep;
  verify(plan: FactoryPlan): Promise<FactoryVerifyResult>;
}

function workflowFileName(caller: CallerName): string {
  return `vanguard-${caller}.yml`;
}

/** Nothing detected — the fallback when the repo has no readable package.json. */
export function noScripts(): FactoryPlan['scripts'] {
  return { typecheck: false, lint: false, test: false, build: false };
}

/** What `apply` will write: the caller paths it stages and the labels it creates. Always derived
 * from this process's own constants — never read off a plan a client echoes back (see rpc.ts's
 * `requirePlan`), so a tampered plan cannot widen `git add` or `gh label create`. */
export function factoryPlanTargets(): Pick<FactoryPlan, 'callerFiles' | 'labels'> {
  return {
    callerFiles: CALLER_NAMES.map((name) => join('.github', 'workflows', workflowFileName(name))),
    labels: FACTORY_LABELS.map((l) => l.name),
  };
}

async function execJson(exec: FactoryExec, file: string, args: string[], options?: { cwd?: string }): Promise<unknown> {
  const result = await exec(file, args, options);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new BadRequestError(`${file} ${args.join(' ')} returned unexpected output: ${result.stdout}`);
  }
}

function strField(obj: unknown, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
}

/** Read the target repo's package.json scripts — plan-only, no exec: a plain file read. */
async function detectScripts(repoPath: string): Promise<{ packageManager: string; scripts: FactoryPlan['scripts'] }> {
  let raw: string | undefined;
  try {
    raw = await readFile(join(repoPath, 'package.json'), 'utf8');
  } catch {
    return { packageManager: 'none', scripts: noScripts() };
  }
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; packageManager?: string };
    const scripts = pkg.scripts ?? {};
    const field = pkg.packageManager ?? '';
    const packageManager = field.startsWith('pnpm') ? 'pnpm' : field.startsWith('yarn') ? 'yarn' : 'npm';
    return {
      packageManager,
      scripts: {
        typecheck: scripts.typecheck !== undefined || scripts['check-types'] !== undefined || scripts['type-check'] !== undefined,
        lint: scripts.lint !== undefined,
        test: scripts.test !== undefined,
        build: scripts.build !== undefined,
      },
    };
  } catch {
    return { packageManager: 'none', scripts: noScripts() };
  }
}

/** Read the repo's default branch, slug and the signed-in gh login — nothing written yet. */
export async function planGithubFactory(repoPath: string, deps: GithubFactoryDeps = {}): Promise<FactoryPlan> {
  const exec = deps.exec ?? defaultExec;
  const [repoView, user, { packageManager, scripts }, verifyCommand] = await Promise.all([
    execJson(exec, 'gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd: repoPath }),
    execJson(exec, 'gh', ['api', 'user'], { cwd: repoPath }),
    detectScripts(repoPath),
    resolveVerifyCommand(repoPath),
  ]);

  const repoSlug = strField(repoView, ['nameWithOwner']);
  const defaultBranch = strField(repoView, ['defaultBranchRef', 'name']);
  const login = strField(user, ['login']);
  if (repoSlug === '') throw new BadRequestError('could not determine the repository (gh repo view returned no nameWithOwner)');
  if (defaultBranch === '') throw new BadRequestError('could not determine the default branch (gh repo view returned no defaultBranchRef)');
  if (login === '') throw new BadRequestError('could not determine the signed-in gh login (gh api user returned no login)');

  return {
    provider: 'github',
    repoSlug,
    defaultBranch,
    login,
    packageManager,
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    scripts,
    ...factoryPlanTargets(),
  };
}

/** Branch `apply` opens the PR from. Fixed, not random: a second `apply` on an already-open PR
 * updates the same branch instead of spawning a parallel one. */
export function enableFactoryBranch(): string {
  return 'vanguard/enable-factory';
}

async function run(exec: FactoryExec, file: string, args: string[], options?: { cwd?: string }): Promise<string> {
  const result = await exec(file, args, options);
  return result.stdout.trim();
}

/**
 * Create a branch, add the five callers (author gate set to `plan.login`), open a PR against
 * `plan.defaultBranch` (never push TO it), and create the three routing labels. Idempotent-ish:
 * label creation uses `--force` so re-running after a partial failure does not error on labels that
 * already exist.
 */
export async function applyGithubFactory(repoPath: string, plan: FactoryPlan, deps: GithubFactoryDeps = {}): Promise<FactoryApplyResult> {
  const exec = deps.exec ?? defaultExec;
  const branch = enableFactoryBranch();
  // Guard, not just convention: apply() must never push the branch it commits to the repo's own
  // default branch — see the hard constraint on CI config in CLAUDE.md and the PR-only rule above.
  if (branch === plan.defaultBranch) {
    throw new BadRequestError('refusing to use the default branch as the enable-factory branch');
  }

  await run(exec, 'git', ['checkout', '-b', branch], { cwd: repoPath });

  const workflowsDir = join(repoPath, '.github', 'workflows');
  await mkdir(workflowsDir, { recursive: true });
  for (const name of CALLER_NAMES) {
    const templateRaw = await readFile(new URL(`${name}.yml`, TEMPLATES_DIR), 'utf8');
    const content = templateRaw.split(LOGIN_PLACEHOLDER).join(plan.login);
    await writeFile(join(workflowsDir, workflowFileName(name)), content);
  }

  await run(exec, 'git', ['add', ...plan.callerFiles], { cwd: repoPath });
  await run(exec, 'git', ['commit', '-m', 'feat: enable the Taskcell factory (GitHub Actions)'], { cwd: repoPath });
  // Pushes the NEW branch, never plan.defaultBranch — the PR is the only path onto the default branch.
  await run(exec, 'git', ['push', '-u', 'origin', branch], { cwd: repoPath });

  const prUrl = await run(
    exec,
    'gh',
    [
      'pr',
      'create',
      '--title',
      'feat: enable the Taskcell factory (GitHub Actions)',
      '--body',
      'Adds the thin caller workflows (implement, doctor, pr-review, revise, resume) that run the Taskcell factory in GitHub Actions. See docs/onboarding-another-repo.md.',
      '--base',
      plan.defaultBranch,
      '--head',
      branch,
    ],
    { cwd: repoPath },
  );

  const labelsCreated: string[] = [];
  for (const label of FACTORY_LABELS) {
    await run(exec, 'gh', ['label', 'create', label.name, '--color', label.color, '--force'], { cwd: repoPath });
    labelsCreated.push(label.name);
  }

  return { branch, prUrl, labelsCreated };
}

/**
 * The secret-setup step: returns the command text only. NO exec call lives in this function — by
 * construction it cannot run `gh secret set` (it takes no `exec` dependency at all), matching the
 * hard rule that the hub never reads, prints or stores a secret value.
 */
export function githubSecretCommand(plan: FactoryPlan): FactorySecretStep {
  return {
    secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
    command: `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${plan.repoSlug}`,
  };
}

/** Dispatch the doctor workflow and report its latest run (called once the PR above is merged). */
export async function verifyGithubFactory(repoPath: string, plan: FactoryPlan, deps: GithubFactoryDeps = {}): Promise<FactoryVerifyResult> {
  const exec = deps.exec ?? defaultExec;
  await exec('gh', ['workflow', 'run', workflowFileName('doctor')], { cwd: repoPath });
  const runs = await listRemoteRuns(repoPath, exec);
  const doctorRun = runs.find((r) => r.workflow === 'Vanguard Doctor') ?? runs[0];
  if (doctorRun === undefined) return { dispatched: true };
  return { dispatched: true, run: { url: doctorRun.url, status: doctorRun.status, conclusion: doctorRun.conclusion } };
}

/** Build a `FactoryProvider` for GitHub Actions, bound to one repo. GitLab/Linear are "coming
 * soon" in the UI — no provider object for them exists yet (see docs/task-sources.md, docs/onboarding-linear.md). */
export function githubFactoryProvider(repoPath: string, deps: GithubFactoryDeps = {}): FactoryProvider {
  return {
    plan: () => planGithubFactory(repoPath, deps),
    apply: (plan) => applyGithubFactory(repoPath, plan, deps),
    secretCommand: (plan) => githubSecretCommand(plan),
    verify: (plan) => verifyGithubFactory(repoPath, plan, deps),
  };
}

export function enableFactory(repoPath: string, provider: FactoryProviderId, deps?: GithubFactoryDeps): FactoryProvider {
  if (provider !== 'github') {
    throw new BadRequestError(`enableFactory: provider "${provider}" is not implemented yet — see docs/task-sources.md / docs/onboarding-linear.md`);
  }
  return githubFactoryProvider(repoPath, deps);
}
