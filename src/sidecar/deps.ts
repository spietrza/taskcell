import { capabilities } from '../api/capabilities.js';
import { assertFlowResolvable, deleteRepoFlow, listRepoFlows, readRepoFlow, writeRepoFlow } from '../flows/repo.js';
import { fetchTaskSpec, listBoardTasks } from '../tasks/board-list.js';
import { listRepoFiles, readRepoFile } from '../tasks/repo-files.js';
import { listRuns as listRunSummaries, readRun as readRunDetail, runsRoot } from '../core/run-store.js';
import { TaskcellError } from '../core/errors.js';
import { loadCustomProviders } from '../agents/custom.js';
import {
  assertProvidersResolvable,
  customEgressHosts,
  validateProviderChoice,
  assertEgressCompatible,
  llmProxySupported,
  subscriptionCredentialProvider,
  claudeCliKeyEnv,
  providerKeyEnvNames,
  usedProviderNames,
} from '../agents/registry.js';
import { createGithubIssue, createGitlabIssue, createLinearIssue } from '../tasks/create.js';
import { beginRun, endRun } from './cancel.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { SANDBOX_STAGE, withSandboxStage } from './sandbox-stage.js';
import { githubDepsFromEnv, runGithubIssue } from '../runners/github.js';
import { gitlabDepsFromEnv, runGitlabIssue } from '../runners/gitlab.js';
import { runLinearIssue } from '../runners/linear.js';
import { runHubTask } from '../runners/hub.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { assertSkillsInstalled } from '../context/named-skills.js';
import { hubSkillsDir, skillRegistryForRun } from '../context/skill-registry.js';
import { BadRequestError } from './sidecar.js';
import { ACCOUNT_ENV, CREDENTIAL_NAMES } from '../hub/credentials.js';
import { fallbackFlags, fundableChain, loneEntryRefused } from '../hub/fallback-chain.js';
import { parseFallbackList } from '../core/model-pool.js';
import { codexAuthSecretValues, forgetInjectedSecretValue, registerInjectedSecretValue } from '../core/secret-scan.js';
import { AgentError } from '../core/errors.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { RunEvent } from '../pipeline/events.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from './sidecar.js';
import { CredentialLimited } from '../runners/run-execution.js';
import type { CredentialRotation, RunCredential } from '../wire.js';

/**
 * The env a hub run reads its provider keys from. A `user` credential replaces every host provider
 * credential — the storable names AND every key env the run's providers read (a repo custom's
 * `keyEnv`, meridian's `MERIDIAN_BASE_URL`) — so a run funded by the starter never silently falls
 * back to the instance's; a provider whose key the user has not saved (or cannot save) is refused.
 * An `instance` one overlays the host env; no credential (desktop) is the host env as before.
 */
export function credentialEnv(credential: RunCredential | undefined, choice: ProviderChoice): NodeJS.ProcessEnv {
  if (credential === undefined) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (credential.source === 'user') {
    for (const name of [...CREDENTIAL_NAMES, ...providerKeyEnvNames(choice)]) delete env[name];
    for (const name of usedProviderNames(choice)) {
      const keyEnvs = claudeCliKeyEnv(name, choice.customProviders);
      if (keyEnvs?.length === 0) {
        // A keyless custom provider authenticates on its own host: letting it run here would spend the instance's proxy, like meridian.
        throw new BadRequestError(`provider "${name}" cannot run on your own credentials: it has no keyEnv to save, so it would use the instance's endpoint; pick another provider`);
      }
      if (keyEnvs !== undefined && !keyEnvs.some((k) => credential.env[k] !== undefined)) {
        throw new BadRequestError(`provider "${name}" cannot run on your own credentials: save ${keyEnvs.join(' or ')} in Settings → Credentials, or pick another provider`);
      }
    }
  }
  // A stored account is the run's one Anthropic credential: a host one must not outrank it (authFromEnv prefers the OAuth token).
  if (credential.accountId !== undefined) for (const name of Object.values(ACCOUNT_ENV)) delete env[name];
  return Object.assign(env, credential.env);
}

/** A run credential's values to register for redaction, including the individual tokens inside a
 * `CODEX_AUTH_JSON` (an agent can copy one out of auth.json). */
export function credentialSecretValues(credential: RunCredential | undefined): string[] {
  const env = credential?.env ?? {};
  return [...new Set([...Object.values(env), ...(env.CODEX_AUTH_JSON !== undefined ? codexAuthSecretValues(env.CODEX_AUTH_JSON) : [])])];
}

/**
 * Resolve the run's provider choice against the target repo's customs (S6): load, validate the
 * pairing rules (the sync protocol validator only shape-checks the name now), and reject plain-http
 * customs — this path is always-egress. AgentError wraps into BadRequestError so a bad name/entry
 * classifies `bad-request` in the loop's catch, not `internal`.
 */
async function resolveRunChoice(params: CreateRunParams): Promise<ProviderChoice> {
  const customProviders = await loadCustomProviders(params.repoPath);
  const choice: ProviderChoice = {
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.fallbackProvider !== undefined ? { fallbackProvider: params.fallbackProvider } : {}),
    ...(customProviders.length > 0 ? { customProviders } : {}),
  };
  try {
    assertProvidersResolvable(choice);
    validateProviderChoice(choice, {});
    assertEgressCompatible(choice); // createRun hardwires egress: true below
  } catch (error) {
    if (error instanceof AgentError) throw new BadRequestError(error.message);
    throw error;
  }
  return choice;
}

/**
 * The Hub's fallback chain trimmed to the entries this run's credential can fund (a `user` run never borrows the instance's
 * keys). A chain entry must never refuse a run: an unfunded one is dropped with a warning, and so is a lone entry one
 * sandbox cannot host next to the Engine (the Engine itself, or its transport slot such as claude → zai; {@link loneEntryRefused}).
 */
async function fundedParams(params: CreateRunParams, credential: RunCredential | undefined): Promise<{ params: CreateRunParams; warnings: string[] }> {
  if (params.fallbackProvider === undefined) return { params, warnings: [] };
  let chain;
  try {
    chain = parseFallbackList(params.fallbackProvider, params.fallbackModel);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : String(error));
  }
  const { kept, dropped } = await fundableChain(chain, params.repoPath, credential);
  const warnings = dropped.map((name) => `fallback entry ${name} skipped: no stored credential for it`);
  const lone = kept[0];
  if (lone !== undefined && (await loneEntryRefused(kept, params.repoPath, params.provider))) {
    kept.length = 0;
    warnings.push(`fallback entry ${lone.model !== undefined ? `${lone.provider}/${lone.model}` : lone.provider} skipped: it cannot take over from the Engine alone (same provider or transport); add another entry`);
  }
  const { fallbackProvider: _p, fallbackModel: _m, ...rest } = params;
  return { params: { ...rest, ...fallbackFlags(kept) }, warnings };
}

/**
 * Why this run's credential sits in the sandbox rather than behind the proxy, phrased for the run view,
 * or undefined when nothing is exposed. The user never asked for the proxy to be off, so without an
 * advisory the exposure is invisible. At most one reason is reported — a subscription credential is the
 * more specific exposure, and it stays in the sandbox even when the proxy is on for the implementer's own.
 */
function exposureReason(opts: {
  provider: string | undefined;
  subscriptionProvider: string | undefined;
  proxySupported: boolean;
  llmProxy: boolean;
}): string | undefined {
  const { subscriptionProvider, proxySupported, llmProxy } = opts;
  if (subscriptionProvider !== undefined) {
    return `${subscriptionProvider}'s subscription credential is not covered by the LLM proxy and is visible`;
  }
  if (llmProxy) return undefined;
  const implementer = opts.provider ?? 'claude';
  if (!proxySupported) {
    return `${implementer} runs in direct mode, which the LLM proxy cannot cover, so its credential is visible`;
  }
  // No env var is named here on purpose: exporting CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY does
  // NOT turn the proxy on for this run (needsAnthropicAuth is false, so the run never reads one),
  // and naming them would advertise a remedy that silently does nothing.
  return (
    `${implementer} authenticates with its own API key, which the LLM proxy's trusted sidecar cannot hold ` +
    `(this run consumes no Anthropic-family credential for a sidecar to front), so that key is visible`
  );
}

/** Env-derived required linear deps (mirrors run.ts `linearDeps`): key + skills dir + repo path. */
function linearExtras(
  repoPath: string,
  auth: AgentAuth | undefined,
): Pick<RunLinearIssueDeps, 'linearKey' | 'skillsDir' | 'repoPath' | 'auth'> {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = hubSkillsDir();
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR (a clone of schpet/linear-cli /skills) for --linear runs.');
  }
  return { linearKey, skillsDir, repoPath, ...(auth !== undefined ? { auth } : {}) };
}

/**
 * Production wiring: build a sandbox context + provider auth from env, then dispatch to the same
 * source runner the CLI uses (mirrors `src/cli/run.ts`), with `onEvent` + the cancel `signal` threaded
 * in. Smoke-verified (needs Docker + creds), not unit-tested. The process running this has NO
 * project cwd (a hub serves many projects — unlike the hub's raw-CLI spawn path, src/hub/spawn.ts,
 * which sets the cwd), so the target repo must arrive explicitly as
 * `params.repoPath`, per run. Keep this thin — logic belongs in the runners, not here.
 */
export function productionDeps(): SidecarDeps {
  return {
    capabilities,
    // The first WRITE to an external system from the app, and it cannot be undone from inside it.
    // Params are validated at the protocol boundary (validateCreateTask) before we get here.
    createTask: async (params) => {
      const input = {
        title: params.title,
        body: params.body,
        ...(params.labels !== undefined && params.labels.length > 0 ? { labels: params.labels } : {}),
        ...(params.dependsOn !== undefined && params.dependsOn.length > 0 ? { dependsOn: params.dependsOn } : {}),
      };
      if (params.source === 'linear') {
        // Labels are NOT applied on Linear: IssueCreateInput takes labelIds (uuids), not the names
        // AppConfig holds, so honouring them needs a name->id resolution we do not do. Not passed at all
        // rather than passed-and-ignored, so the omission is visible here instead of buried one layer down.
        // team is guaranteed by validateCreateTask — an issue in the wrong team is real work in the wrong
        // place, with no undo.
        const { labels: _dropped, ...linearInput } = input;
        return createLinearIssue(params.team as string, linearInput);
      }
      if (params.source === 'gitlab') return createGitlabIssue(params.repoPath, input);
      return createGithubIssue(params.repoPath, input);
    },
    // Flow-file methods (S5): thin pass-throughs to core. FlowError → bad-request in the loop's catch.
    listFlows: async ({ repoPath }) => ({ flows: await listRepoFlows(repoPath) }),
    // Custom-provider listing (S6): health report, never a throw — broken entries come back flagged.
    listProviders: async ({ repoPath }) => ({
      providers: (await loadCustomProviders(repoPath)).map(({ index, name, error }) => ({
        index,
        ...(name !== undefined ? { name } : {}),
        ...(error !== undefined ? { error } : {}),
      })),
    }),
    readFlow: ({ repoPath, file }) => readRepoFlow(repoPath, file),
    writeFlow: ({ repoPath, file, doc }) => writeRepoFlow(repoPath, file, doc),
    deleteFlow: async ({ repoPath, file }) => {
      await deleteRepoFlow(repoPath, file);
      return {};
    },
    // Board read path (S9): user-fixable failures (no source, wrong team key, not logged in,
    // undetectable remote) arrive as TaskcellError — wrap to bad-request so the board shows the
    // actionable message instead of an 'internal' shrug.
    listTasks: async ({ repoPath }) => {
      try {
        return await listBoardTasks(repoPath);
      } catch (error) {
        if (error instanceof TaskcellError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    fetchSpec: async ({ repoPath, taskId }) => {
      try {
        return await fetchTaskSpec(repoPath, taskId);
      } catch (error) {
        if (error instanceof TaskcellError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    // Composer `@`-mention autocomplete + inlining (Editor UX 7/7): repo-scoped reads. A git/FS
    // failure (not a repo, git absent, unreadable file) is user-fixable — wrap to bad-request so the
    // picker shows the actionable message instead of an 'internal' shrug, like the board path.
    listRepoFiles: async ({ repoPath }) => {
      try {
        return await listRepoFiles(repoPath);
      } catch (error) {
        if (error instanceof TaskcellError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    readRepoFile: async ({ repoPath, path }) => {
      try {
        return await readRepoFile(repoPath, path);
      } catch (error) {
        if (error instanceof TaskcellError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    // Run-record read path (#472): one reader. The desktop's `list_runs`/`read_run` forward here, so
    // the proof fallback and the skip-not-abort listing are shared instead of re-derived in Rust.
    listRuns: ({ repoPath }) => listRunSummaries(runsRoot(repoPath)),
    readRun: ({ repoPath, taskId, timestamp }) => readRunDetail(runsRoot(repoPath), taskId, timestamp),
    checkRun: async (raw, credential) => {
      const { params } = await fundedParams(raw, credential);
      const choice = await resolveRunChoice(params);
      try {
        agentAuthFromEnv(choice, credentialEnv(credential, choice));
      } catch (error) {
        throw error instanceof BadRequestError ? error : new BadRequestError(error instanceof Error ? error.message : String(error));
      }
    },
    createRun: async (params: CreateRunParams, onEvent: (e: RunEvent) => void, credential?: RunCredential, rotation?: CredentialRotation): Promise<CreateRunResult> => {
      // One attempt per credential: a stored account that hits a provider limit is cooled and the run restarts on the
      // next one in a fresh sandbox, so the sandbox and LLM proxy only ever hold ONE credential. Every credential used
      // stays registered for redaction until the run ends.
      let current = credential;
      const secrets = new Set<string>();
      try {
        for (;;) {
          for (const v of credentialSecretValues(current)) {
            secrets.add(v);
            registerInjectedSecretValue(v);
          }
          try {
            return await createRunAttempt(params, onEvent, current, rotation);
          } catch (error) {
            if (!(error instanceof CredentialLimited) || rotation === undefined || current?.accountId === undefined) throw error;
            const next = await rotation.limited(current.accountId, error.until);
            if (next === undefined) throw error.limit;
            onEvent({
              type: 'warning',
              message: `credential "${current.accountName ?? 'unnamed'}" hit a provider limit (cooling until ${error.until.toISOString()}); continuing on "${next.accountName ?? 'unnamed'}"`,
            });
            current = next;
          }
        }
      } finally {
        for (const v of secrets) forgetInjectedSecretValue(v);
      }
    },
  };
}

async function createRunAttempt(rawParams: CreateRunParams, onEvent: (e: RunEvent) => void, credential: RunCredential | undefined, rotation: CredentialRotation | undefined): Promise<CreateRunResult> {
      // FIRST statements, before beginRun() and the sandbox: an unresolvable flow (typo, broken or
      // duplicate .hcl) or provider (unknown name, broken customs entry, http custom on this
      // always-egress path) must cost nothing and classify bad-request — and must not leave an
      // armed AbortController behind (endRun's finally only wraps the post-sandbox region). Pure
      // checks: no lowering, no ref import — repo TS must not execute on the untimed run pipe (S5 D6).
      if (rawParams.flow !== undefined) await assertFlowResolvable(rawParams.flow, rawParams.repoPath);
      const { params, warnings: chainWarnings } = await fundedParams(rawParams, credential);
      const choice = await resolveRunChoice(params);
      // A hub run reads every provider key from its resolved credential env. A `user` run must never
      // fall back to the host's provider credentials, so those are dropped before its own overlay.
      const authEnv = credentialEnv(credential, choice);
      const transport = params.transport ?? 'github';
      const provider = params.provider;
      const customProviders = choice.customProviders;
      const repoPath = params.repoPath;
      // Auth is resolved BEFORE beginRun: it is a pure env read, and a missing key must not leave
      // an armed AbortController behind (same rationale as the resolvability checks above). Wrapped
      // as bad-request: a missing env var is caller-correctable, same class as an unknown name —
      // without the wrap it is the ONE dispatch-time failure that classified `internal`.
      let auth: AgentAuth | undefined;
      try {
        auth = agentAuthFromEnv(choice, authEnv);
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error));
      }
      const extraEgressHosts = customEgressHosts(choice);
      // A direct-mode-only provider (meridian, a repo custom) cannot run under the proxy at all. The
      // sidecar's choice carries an implementer and nothing else, so that provider IS the ineligible
      // one — and so may be a chain entry (a hub fallback chain is part of the choice).
      const proxySupported = llmProxySupported(choice);
      // The hub always wants the credential OUT of the sandbox, and there is no hub/sidecar knob to turn
      // that off (see docs/hub.md) — but the proxy's primary sidecar is the thing that HOLDS a credential,
      // so it needs one: `auth` is the Anthropic-family credential (or zai/openrouter's key riding the
      // same slot) it would hold. Without it startSandboxContext refuses, so a run that consumes no such
      // credential — codex or cursor on their own API key, with or without a Claude token exported, since
      // needsAnthropicAuth is false there — must run direct rather than not at all.
      const llmProxy = proxySupported && auth !== undefined;
      // A used provider's subscription credential (Codex's CODEX_AUTH_JSON) that `providerSecrets`
      // still cannot route to a sidecar lands in the sandbox verbatim — e.g. llmProxy off, or a
      // non-chatgpt-shaped auth.json even with it on. A ChatGPT-plan credential under an active proxy
      // is fronted by its own chatgpt sidecar instead, so it no longer shows up here.
      const subscriptionProvider = subscriptionCredentialProvider(choice, authEnv, { proxyMode: llmProxy });
      // A skill the hub named that is not installed costs nothing: refused before the sandbox context exists.
      // (A `Skills:` line is only known once the issue is fetched; runSourcedIssue refuses that before any model call.)
      const skillsDir = hubSkillsDir();
      if (params.skills !== undefined && params.skills.length > 0) {
        try {
          assertSkillsInstalled(params.skills, (await skillRegistryForRun(skillsDir, repoPath)).ids());
        } catch (error) {
          throw new BadRequestError(error instanceof Error ? error.message : String(error));
        }
      }
      const signal = beginRun();
      let ctx: SandboxContext;
      // The container start is the run's first stage; the log holds these two events until `run-start` names the task.
      onEvent({ type: 'stage-start', name: SANDBOX_STAGE, index: 0, of: 1 });
      try {
        ctx = await startSandboxContext({
          egress: true,
          llmProxy,
          ...(auth !== undefined ? { auth } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(extraEgressHosts.length > 0 ? { extraEgressHosts } : {}),
        });
      } catch (error) {
        // The controller is armed from beginRun() on, and the `finally` below only covers the region
        // after the context exists: a throw while provisioning must disarm it too, so no stale armed
        // controller outlives the failed run. The fault itself is rethrown as-is — everything
        // startSandboxContext raises is a SandboxError, which classifyCoreError already reports
        // bad-request, so wrapping could only relabel a genuine internal fault as a caller mistake.
        endRun();
        onEvent({ type: 'stage-end', name: SANDBOX_STAGE, index: 0, of: 1, outcome: 'error' });
        throw error;
      }
      onEvent({ type: 'stage-end', name: SANDBOX_STAGE, index: 0, of: 1, outcome: 'completed' });
      for (const message of chainWarnings) onEvent({ type: 'warning', message });
      const exposed = exposureReason({ provider, subscriptionProvider, proxySupported, llmProxy });
      if (exposed !== undefined) {
        onEvent({ type: 'warning', message: `${exposed} to the agent inside the sandbox for this run.` });
      }
      // The credential values (registered for redaction by createRun's loop) live in no host env var, so the
      // outgoing-diff gate and every redaction pass treat them like any injected secret.
      try {
        // The RunOptions the sidecar exposes + the sandbox wiring + the event seam, shared across transports.
        const common = {
          onEvent: withSandboxStage(onEvent),
          signal,
          ...(provider !== undefined ? { provider } : {}),
          ...(params.fallbackProvider !== undefined ? { fallbackProvider: params.fallbackProvider } : {}),
          ...(params.fallbackModel !== undefined ? { fallbackModel: params.fallbackModel } : {}),
          ...(customProviders !== undefined ? { customProviders } : {}),
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.baseBranch !== undefined ? { baseBranch: params.baseBranch } : {}),
          // The hub's list is the run's whole hand-picked list; the same skills dir list_skills offered it from.
          ...(params.skills !== undefined ? { namedSkills: params.skills, namedSkillsOnly: true } : {}),
          ...(skillsDir !== undefined ? { skillsDir } : {}),
          ...(params.startedBy !== undefined ? { startedBy: params.startedBy } : {}),
          // Named-flow dispatch: pass the validated flow key straight through. runSourcedIssue
          // resolves it via FLOWS[flow].build() (Subsystem 2). Any registered FLOWS entry works with
          // no per-flow wiring here; validation happened in sidecar.ts::validateCreateRun.
          ...(params.flow !== undefined ? { flow: params.flow } : {}),
          ...(credential !== undefined ? { credentialSource: credential.source, providerEnv: authEnv } : {}),
          ...(credential?.accountName !== undefined ? { credentialName: credential.accountName } : {}),
          ...(rotation !== undefined && credential?.accountId !== undefined
            ? {
                credentialRotation: { provider: rotation.provider, hasNext: () => rotation.hasNext() },
                onCredentialCooled: (until: Date) => rotation.cool(credential.accountId!, until),
              }
            : {}),
          sandboxContext: ctx,
        };
        const authChoice = {
          ...(provider !== undefined ? { provider } : {}),
          ...(params.fallbackProvider !== undefined ? { fallbackProvider: params.fallbackProvider } : {}),
          ...(customProviders !== undefined ? { customProviders } : {}),
        };
        if (transport === 'gitlab') {
          const deps = await gitlabDepsFromEnv(repoPath, undefined, authChoice, authEnv);
          return await runGitlabIssue(params.issueRef, { ...deps, ...common });
        }
        if (transport === 'linear') {
          return await runLinearIssue(params.issueRef, { ...common, ...linearExtras(repoPath, auth) });
        }
        // A hub-board task: the hub's scheduler passes the stored task; there is no tracker to fetch it from.
        // `hub` is not a client transport (validateCreateRun refuses it), so a client's `hubTask` never lands here.
        if (transport === 'hub') {
          if (params.hubTask === undefined) throw new BadRequestError('a hub run needs its stored task');
          return await runHubTask(params.hubTask, { ...common, repoPath, ...(auth !== undefined ? { auth } : {}) });
        }
        const deps = await githubDepsFromEnv(repoPath, undefined, authChoice, authEnv);
        return await runGithubIssue(params.issueRef, { ...deps, ...common });
      } finally {
        await ctx.destroy();
        endRun();
      }
}
