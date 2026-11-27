import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_LABEL_PREFIX, flowOf, modelFromLabels, planIssuePipeline, planIssueRun, planIssueSkills, planRevision, planRevisionPipeline, resolveBaseStages, tierPick } from './run-plan.js';
import type { IssueRunPlan } from './run-plan.js';
import type { RunIssueDeps } from './source-adapter.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { Task } from '../tasks/fetcher.js';
import type { ReviseGithubPrDeps } from './revise-pr.js';
import type { AgentProvider } from '../agents/provider.js';

const task: Task = { id: 'group/project#1', title: 't', description: '', labels: [], children: [], comments: [] };
const STAGES: PipelineStage[] = [
  { name: 'implementer', promptTemplate: '', maxTurns: 30 },
  { name: 'reviewer', promptTemplate: '', maxTurns: 20 },
];
const tracker = { taskId: (): string => 'gl-1', stages: (): PipelineStage[] => STAGES };
const agent = (name: string): AgentProvider => ({ name }) as AgentProvider;

let repoPath: string;
beforeAll(async () => { repoPath = await mkdtemp(join(tmpdir(), 'run-plan-')); });
afterAll(() => rm(repoPath, { recursive: true, force: true }));

async function plan(over: { deps?: Partial<RunIssueDeps>; task?: Partial<Task>; specFileText?: string; skillIds?: string[]; cooldowns?: Map<string, Date>; exhausted?: Set<string> } = {}): Promise<IssueRunPlan> {
  const deps: RunIssueDeps = { repoPath, ...over.deps };
  return planIssueRun({
    fetchedTask: { ...task, ...over.task },
    deps,
    baseStages: await resolveBaseStages(flowOf(deps), repoPath, tracker, deps.customProviders),
    tracker,
    skillIds: over.skillIds ?? [],
    ...(over.specFileText !== undefined ? { specFileText: over.specFileText } : {}),
    cooldowns: over.cooldowns ?? new Map(),
    exhausted: over.exhausted ?? new Set(),
  });
}
const stagesOf = (p: IssueRunPlan, agents = { agent: agent('claude') }): PipelineStage[] => planIssuePipeline(p, agents);

describe('modelFromLabels', () => {
  it('last matching label wins, blanks ignored, none → undefined', () => {
    expect(modelFromLabels(['bug', 'taskcell:model=opus', 'taskcell:model=claude-fable-5'])).toBe('claude-fable-5');
    expect(modelFromLabels([`${MODEL_LABEL_PREFIX} `])).toBeUndefined();
    expect(modelFromLabels(['ready for agent'])).toBeUndefined();
  });

  it('malformed values are ignored and reported, well-formed slugs pass', () => {
    const bad: string[] = [];
    const labels = ['taskcell:model=opus; rm -rf /', 'taskcell:model=$(id)', 'taskcell:model=anthropic/claude-sonnet-4.6'];
    expect(modelFromLabels(labels, (l) => bad.push(l))).toBe('anthropic/claude-sonnet-4.6');
    expect(bad).toEqual(['taskcell:model=opus; rm -rf /', 'taskcell:model=$(id)']);
    expect(modelFromLabels(['taskcell:model=gpt-6-sol'])).toBe('gpt-6-sol');
    expect(modelFromLabels([`taskcell:model=${'a'.repeat(81)}`])).toBeUndefined();
  });
});

describe('planIssueRun: model routing', () => {
  it('a taskcell:model label pins the implementer model over --provider-model; --review-model is untouched', async () => {
    const p = await plan({ task: { labels: ['ready for agent', 'taskcell:model=claude-fable-5'] }, deps: { providerModel: 'claude-sonnet-5', reviewModel: 'claude-opus-4-8' } });
    expect(p.labelModel).toBe('claude-fable-5');
    const stages = stagesOf(p);
    expect(stages.find((s) => s.name === 'implementer')?.model).toBe('claude-fable-5');
    expect(stages.find((s) => s.name === 'reviewer')?.model).toBe('claude-opus-4-8');
  });

  it('the label routes like --provider-model: a same-provider reviewer without --review-model takes it too', async () => {
    const p = await plan({ task: { labels: ['taskcell:model=claude-fable-5'] }, deps: { provider: 'claude' } });
    expect(stagesOf(p).every((s) => s.model === 'claude-fable-5')).toBe(true);
  });

  it('a malformed label is dropped and reported as a warning', async () => {
    const p = await plan({ task: { labels: ['taskcell:model=$(id)'] } });
    expect(p.labelModel).toBeUndefined();
    expect(p.warnings).toEqual([expect.stringContaining('ignoring malformed model label')]);
  });

  it('a model pool resolves to one provider/model, recorded as a pick and logged', async () => {
    const p = await plan({ deps: { providerModel: 'codex/gpt-6-sol:1' } });
    expect(p.deps).toMatchObject({ provider: 'codex', providerModel: 'gpt-6-sol' });
    expect(p.choice).toMatchObject({ provider: 'codex', providerModel: 'gpt-6-sol' });
    expect(p.recordedPicks.implementer).toMatchObject({ provider: 'codex', model: 'gpt-6-sol' });
    expect(p.logs[0]).toContain('implementer → codex/gpt-6-sol');
    expect(p.routing.pooled).toBe(true);
  });

  it('a plain model leaves the options untouched and records no picks', async () => {
    const p = await plan({ deps: { providerModel: 'sonnet' } });
    expect(p.deps).toMatchObject({ providerModel: 'sonnet' });
    expect(p.routing.pooled).toBe(false);
    expect(p.recordedPicks).toEqual({});
  });

  it('a cooling or exhausted entry is skipped, and reroute() moves on once more entries are out', async () => {
    const deps = { providerModel: 'claude/sonnet:1, claude/opus:1' };
    const first = await plan({ deps });
    const picked = first.deps.providerModel!;
    const other = picked === 'sonnet' ? 'opus' : 'sonnet';
    expect((await plan({ deps, cooldowns: new Map([[`claude/${picked}`, new Date()]]) })).deps.providerModel).toBe(other);
    expect((await plan({ deps, exhausted: new Set([`claude/${picked}`]) })).deps.providerModel).toBe(other);
    expect(first.reroute(new Set([`claude/${picked}`])).routing.options.providerModel).toBe(other);
  });

  it('a flow stage pool naming a repo custom provider resolves against the loaded customProviders', async () => {
    const customProviders = [{ index: 0, name: 'myproxy', spec: { name: 'myproxy', baseUrl: 'https://llm.example.com' } }];
    const p = await planIssueRun({
      fetchedTask: task,
      deps: { repoPath, customProviders },
      baseStages: [{ ...STAGES[0]!, model: 'myproxy/m1:1, claude/sonnet:1' }, STAGES[1]!],
      tracker,
      skillIds: [],
      cooldowns: new Map(),
      exhausted: new Set(),
    });
    // The custom owns the Claude CLI transport, so it cannot be pinned beside the claude run: only claude/sonnet serves.
    // Without the customs the flow pool resolver cannot tell that and throws on an unknown provider.
    expect(p.flowPools.picks['implementer']).toMatchObject({ provider: 'claude', model: 'sonnet' });
  });

  it('--escalate-model survives planning for the repair loop', async () => {
    expect((await plan({ deps: { escalateModel: 'opus' } })).deps.escalateModel).toBe('opus');
  });

  it('tierPick: the reviewer draws on the reviewer pick, the implementer tier on the implementer pick', async () => {
    const p = await plan({ deps: { providerModel: 'claude/sonnet:1', reviewModel: 'codex/gpt-6-sol:1', reviewProvider: 'codex' } });
    expect(tierPick(p, 'implementer', 'claude')?.provider).toBe('claude');
    expect(tierPick(p, 'reviewer', 'claude')?.provider).toBe('codex');
    expect(tierPick(p, 'simplifier', 'claude')?.provider).toBe('claude');
    expect(tierPick((await plan()), 'implementer', 'claude')).toBeUndefined();
  });
});

describe('planIssueRun: flow choice', () => {
  const names = (p: IssueRunPlan): string[] => stagesOf(p).map((s) => s.name);

  it("no flow keeps the tracker's own stages", async () => {
    const p = await plan();
    expect(p.flow).toBeUndefined();
    expect(names(p)).toEqual(['implementer', 'simplifier', 'reviewer'].filter((n) => n !== 'simplifier' || names(p).includes(n)));
    expect(p.baseStages).toBe(STAGES);
  });

  it('--plan swaps in the plan-implement-review pipeline (planner first)', async () => {
    const p = await plan({ deps: { plan: true } });
    expect(p.flow).toBe('plan');
    expect(names(p)[0]).toBe('planner');
    expect(names(p)).toContain('implementer');
  });

  it('--flow flow-b is planner→implementer→adversary→repairer', async () => {
    const p = await plan({ deps: { flow: 'flow-b' } });
    expect(p.flow).toBe('flow-b');
    expect(names(p)).toEqual(['planner', 'implementer', 'adversary', 'repairer']);
  });

  it("--flow default keeps the tracker's stages (a customised implementer survives)", async () => {
    const custom: PipelineStage[] = [{ name: 'implementer', promptTemplate: 'Use the linear-cli skill', maxTurns: 30 }, STAGES[1]!];
    const stages = await resolveBaseStages('default', repoPath, { stages: () => custom });
    expect(stages).toBe(custom);
  });

  it('an unknown flow throws listing the known ones', async () => {
    await expect(resolveBaseStages('nope', repoPath, tracker)).rejects.toThrow(/unknown flow "nope" — choose one of: default, plan, flow-b/);
  });

  it('--max-turns overrides only the implementer; other stages keep their value', async () => {
    const p = await plan({ deps: { flow: 'flow-b', maxTurns: 10 } });
    expect(stagesOf(p).find((s) => s.name === 'implementer')?.maxTurns).toBe(10);
    expect(stagesOf(p).find((s) => s.name === 'adversary')?.maxTurns).toBe(12);
  });

  it('--max-turns applies to the tracker flow and the --plan flow; the default stays 30', async () => {
    expect(stagesOf(await plan({ deps: { maxTurns: 80 } })).find((s) => s.name === 'implementer')?.maxTurns).toBe(80);
    expect(stagesOf(await plan({ deps: { plan: true, maxTurns: 80 } })).find((s) => s.name === 'implementer')?.maxTurns).toBe(80);
    expect(stagesOf(await plan()).find((s) => s.name === 'implementer')?.maxTurns).toBe(30);
  });

  it('--fallback-provider puts a fallback on the primary-agent stages, with --fallback-model', async () => {
    const p = await plan({ deps: { fallbackProvider: 'codex', fallbackModel: 'gpt-5' } });
    const stages = planIssuePipeline(p, { agent: agent('claude'), fallbackAgent: agent('codex') });
    expect(stages.find((s) => s.name === 'implementer')?.fallback).toMatchObject({ provider: { name: 'codex' }, model: 'gpt-5' });
  });
});

describe('planIssueRun: task, white-label, base branch', () => {
  it('white-label is on exactly when a commit author is set; the run id comes from the tracker', async () => {
    expect((await plan()).whiteLabel).toBe(false);
    const p = await plan({ deps: { commitAuthor: { name: 'A', email: 'a@x' } } });
    expect(p.whiteLabel).toBe(true);
    expect(p.runTaskId).toBe('gl-1');
  });

  it('--base wins; else the repo default (main)', async () => {
    expect((await plan({ deps: { baseBranch: 'dev' } })).baseBranch).toBe('dev');
    expect((await plan()).baseBranch).toBe('main');
  });

  it('--spec-file text becomes a virtual comment on a copy; the fetched task is not mutated', async () => {
    const fetched = { ...task };
    const p = await planIssueRun({ fetchedTask: fetched, deps: { repoPath }, baseStages: STAGES, tracker, skillIds: [], specFileText: 'LOCAL SPEC', cooldowns: new Map(), exhausted: new Set() });
    expect(p.task.comments).toEqual([{ author: 'spec-file', authorAssociation: 'OWNER', body: 'LOCAL SPEC' }]);
    expect(fetched.comments).toHaveLength(0);
  });
});

describe('planIssueRun: hand-picked skills', () => {
  const ids = ['db', 'other', 'release']; // the registry lists ids sorted
  const implementerPrompt = (p: IssueRunPlan): string => stagesOf(p).find((s) => s.name === 'implementer')?.promptTemplate ?? '';
  const skills = (p: IssueRunPlan, agents = { agent: 'claude' }): ReturnType<typeof planIssueSkills> => planIssueSkills(p, agents);

  it('merges --skill with the body line, tells the implementer and records named vs available', async () => {
    const p = await plan({ skillIds: ids, deps: { namedSkills: ['release'] }, task: { description: 'Do it\n\nSkills: db' } });
    expect(implementerPrompt(p)).toMatch(/MUST load and follow each of them.*: release, db\./);
    expect(stagesOf(p).find((s) => s.name === 'reviewer')?.promptTemplate).not.toContain('MUST load');
    expect(skills(p).record).toEqual({ named: ['release', 'db'], available: ['other'] });
  });

  it('reaches the implementer of the plan flow too', async () => {
    expect(implementerPrompt(await plan({ skillIds: ids, deps: { plan: true }, task: { description: 'Skills: db' } }))).toContain('MUST load and follow each of them');
  });

  it('refuses a skill that is not installed, naming the installed ones', async () => {
    await expect(plan({ skillIds: ids, task: { description: 'Skills: nope' } })).rejects.toThrow('Unknown skill: nope. Installed skills: db, other, release.');
    await expect(plan({ skillIds: ids, deps: { namedSkills: ['nope'] } })).rejects.toThrow('Unknown skill: nope.');
  });

  it('prose after "Skills:" selects nothing and leaves a note', async () => {
    const p = await plan({ skillIds: ids, task: { description: 'Skills: TypeScript and SQL, good communication\n```\nSkills: nope\n```' } });
    expect(implementerPrompt(p)).not.toContain('MUST load');
    expect(skills(p).record).toEqual({ named: [], available: ['db', 'other', 'release'], notes: [expect.stringContaining('it was ignored')] });
  });

  it('the hub list replaces the body line', async () => {
    const p = await plan({ skillIds: ids, deps: { namedSkills: ['release'], namedSkillsOnly: true }, task: { description: 'Skills: db' } });
    expect(implementerPrompt(p)).toMatch(/: release\.$/);
    expect(skills(p).record).toEqual({ named: ['release'], available: ['db', 'other'], notes: [expect.stringContaining('was replaced by the list chosen in the hub (release)')] });
  });

  it('a provider that reads no skills is noted and lists none as loaded; every agent stage is checked', async () => {
    const p = await plan({ skillIds: ids, task: { description: 'Skills: db' } });
    const note = expect.stringContaining('provider pi does not support skills');
    expect(skills(p, { agent: 'pi' }).record).toEqual({ named: [], available: [], notes: [note] });
    expect(skills(p, { agent: 'claude', reviewAgent: 'pi' } as never).record).toEqual({ named: ['db'], available: ['other', 'release'], notes: [note] });
  });
});

describe('planRevision', () => {
  const revise = (over: Partial<ReviseGithubPrDeps> = {}): ReviseGithubPrDeps => ({ repoPath, ...over });
  const input = (deps: ReviseGithubPrDeps, labelModel?: string, cooldowns = new Map<string, Date>()): Parameters<typeof planRevision>[0] => ({ deps, labelModel, taskKey: 'owner/repo#7', cooldowns });

  it('the source issue label beats --provider-model', () => {
    expect(planRevision(input(revise({ providerModel: 'sonnet' }), 'fable')).effectiveModel).toBe('fable');
    expect(planRevision(input(revise({ providerModel: 'sonnet' }))).effectiveModel).toBe('sonnet');
  });

  it('a model pool resolves to one entry, keyed on the source issue, with its picks', () => {
    const p = planRevision(input(revise({ providerModel: 'codex/gpt-6-sol:1' })));
    expect(p.deps).toMatchObject({ provider: 'codex', providerModel: 'gpt-6-sol' });
    expect(p.effectiveModel).toBe('gpt-6-sol');
    expect(p.poolPicks.implementer).toMatchObject({ provider: 'codex', model: 'gpt-6-sol' });
  });

  it('a label pins the pool pick to the label model', () => {
    const p = planRevision(input(revise({ providerModel: 'claude/sonnet:1' }), 'opus'));
    expect(p.poolPicks.implementer).toMatchObject({ model: 'opus', pick: 'label' });
    expect(p.effectiveModel).toBe('opus');
  });

  it('a cooling entry is skipped', () => {
    const deps = revise({ providerModel: 'claude/sonnet:1, claude/opus:1' });
    const picked = planRevision(input(deps)).deps.providerModel!;
    const other = picked === 'sonnet' ? 'opus' : 'sonnet';
    expect(planRevision(input(deps, undefined, new Map([[`claude/${picked}`, new Date()]]))).deps.providerModel).toBe(other);
  });

  it('a test agent skips pool routing', () => {
    const deps = revise({ providerModel: 'codex/gpt-6-sol:1', _agent: agent('claude') });
    const p = planRevision(input(deps));
    expect(p.deps).toBe(deps);
    expect(p.poolPicks).toEqual({});
  });

  it('pipeline: --no-simplify drops the simplifier; the model goes on every stage, but not a cross-provider reviewer', () => {
    const names = (s: PipelineStage[]): string[] => s.map((x) => x.name);
    expect(names(planRevisionPipeline(revise({ noSimplify: true }), { agent: agent('claude') }, undefined))).not.toContain('simplifier');
    expect(planRevisionPipeline(revise(), { agent: agent('claude') }, 'sonnet').every((s) => s.model === 'sonnet')).toBe(true);
    const cross = planRevisionPipeline(revise({ reviewProvider: 'codex' }), { agent: agent('claude'), reviewAgent: agent('codex') }, 'sonnet');
    expect(cross.find((s) => s.name === 'reviewer')?.model).toBeUndefined();
    expect(cross.find((s) => s.name === 'reviewer')?.provider).toMatchObject({ name: 'codex' });
    expect(cross.find((s) => s.name === 'implementer')?.model).toBe('sonnet');
  });

  it('pipeline: without a model no stage carries one (provider default)', () => {
    expect(planRevisionPipeline(revise(), { agent: agent('claude') }, undefined).every((s) => s.model === undefined)).toBe(true);
  });

  it('pipeline: --review-model pins the reviewer; the fallback agent rides on the primary stages', () => {
    const stages = planRevisionPipeline(revise({ reviewModel: 'opus', fallbackModel: 'gpt-5' }), { agent: agent('claude'), fallbackAgent: agent('codex') }, 'sonnet');
    expect(stages.find((s) => s.name === 'reviewer')?.model).toBe('opus');
    expect(stages.find((s) => s.name === 'implementer')?.fallback).toMatchObject({ provider: { name: 'codex' }, model: 'gpt-5' });
  });
});
