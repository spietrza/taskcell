// Hub commands: enabling the factory on a repository (plan, apply, secret, verify). One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { enableFactory, factoryPlanTargets, noScripts } from '../enable-factory.js';
import type { FactoryApplyResult, FactoryPlan, FactoryProviderId, FactorySecretStep, FactoryVerifyResult } from '../../wire.js';
import { defineCommands, requireString, optionalString, requireOneOf, requireMatch, repoTarget } from '../command-kit.js';

export interface EnableFactoryCommands {
  /** HUB_ONLY: read the repo (default branch, package manager, verify command) and report what
   *  `enable_factory_apply` would change — no writes yet. GitHub only; `provider` is accepted for
   *  forward compatibility with GitLab/Linear, which the UI marks "coming soon" instead of calling this. */
  enable_factory_plan: { args: { repoPath: string; provider: FactoryProviderId }; result: FactoryPlan };
  /** HUB_ONLY: create a branch, add the five caller workflows, open a PR (never push to the default
   *  branch) and create the routing labels. */
  enable_factory_apply: { args: { repoPath: string; plan: FactoryPlan }; result: FactoryApplyResult };
  /** HUB_ONLY: the `gh secret set` command text for the user to run themselves — the hub never
   *  reads, prints or stores the secret value. */
  enable_factory_secret: { args: { repoPath: string; plan: FactoryPlan }; result: FactorySecretStep };
  /** HUB_ONLY: dispatch the doctor workflow (once the PR above is merged) and report the run that dispatch created. */
  enable_factory_verify: { args: { repoPath: string; plan: FactoryPlan }; result: FactoryVerifyResult };
}

/** The provider the client picked. Only `github` has an adapter; `enableFactory` itself rejects the
 * other two with a `not implemented` BadRequestError, so this only narrows the string. */
function requireProvider(args: Record<string, unknown>, key: string): FactoryProviderId {
  const v = requireString(args, key);
  if (v !== 'github' && v !== 'gitlab' && v !== 'linear') throw new BadRequestError(`${key} must be github, gitlab or linear`);
  return v;
}

// `login` is spliced into the callers' YAML and `repoSlug` into the displayed `gh secret set`
// command, `defaultBranch` into git argv — so each must match its GitHub shape, nothing wider.
// `_` for Enterprise Managed Users (`name_shortcode`).
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;

const GITHUB_REPO_SLUG = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

const GIT_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function requireScripts(raw: unknown): FactoryPlan['scripts'] {
  if (raw === undefined) return noScripts();
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const keys = ['typecheck', 'lint', 'test', 'build'] as const;
  if (keys.some((k) => typeof s[k] !== 'boolean')) throw new BadRequestError('plan.scripts must map typecheck/lint/test/build to booleans');
  return { typecheck: s.typecheck as boolean, lint: s.lint as boolean, test: s.test as boolean, build: s.build as boolean };
}

/** Re-read the plan the client echoes back from `enable_factory_plan`. The paths `apply` stages and
 * the labels it creates are NOT taken from the client: `factoryPlanTargets()` re-derives them from
 * this process's own constants, so a tampered plan cannot widen `git add` or `gh label create`; the
 * fields that reach YAML, shell text or git argv are shape-checked. */
function requirePlan(args: Record<string, unknown>, key: string): FactoryPlan {
  const raw = args[key];
  if (typeof raw !== 'object' || raw === null) throw new BadRequestError(`${key} is required`);
  const plan = raw as Record<string, unknown>;
  if (plan.provider !== 'github') throw new BadRequestError(`${key}.provider must be github`);
  const verifyCommand = optionalString(plan, 'verifyCommand');
  return {
    provider: 'github',
    repoSlug: requireMatch(plan, 'repoSlug', GITHUB_REPO_SLUG, 'owner/repo slug'),
    defaultBranch: requireMatch(plan, 'defaultBranch', GIT_BRANCH, 'branch name'),
    login: requireMatch(plan, 'login', GITHUB_LOGIN, 'GitHub login'),
    packageManager: requireOneOf(plan, 'packageManager', ['pnpm', 'yarn', 'npm', 'none']),
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    scripts: requireScripts(plan.scripts),
    ...factoryPlanTargets(),
  };
}

export const commands = defineCommands<EnableFactoryCommands>({
  enable_factory_plan: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return enableFactory(real, requireProvider(args, 'provider')).plan();
  },
  enable_factory_apply: async ({ ctx, args, allow }) => {
    // Writes a branch, a commit and a PR in the target repo — a mutation, like clone_project.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    const shown = requirePlan(args, 'plan');
    const provider = enableFactory(real, 'github');
    // `login` becomes the callers' actor gate: apply a plan re-derived here, never the client's echo,
    // and refuse one that no longer matches what the user was shown.
    const plan = await provider.plan();
    if (plan.login !== shown.login || plan.repoSlug !== shown.repoSlug || plan.defaultBranch !== shown.defaultBranch) {
      throw new BadRequestError('the plan no longer matches the repository (gh login, repo or default branch changed); review the new plan and apply again');
    }
    return provider.apply(plan);
  },
  enable_factory_secret: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    return enableFactory(real, 'github').secretCommand(requirePlan(args, 'plan'));
  },
  enable_factory_verify: async ({ ctx, args, allow }) => {
    // Dispatches the doctor workflow, so it mutates the remote too.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    return enableFactory(real, 'github').verify(requirePlan(args, 'plan'));
  },
}, {
  enable_factory_apply: { action: 'enable-factory', target: repoTarget },
  enable_factory_verify: { action: 'enable-factory', target: repoTarget },
});
