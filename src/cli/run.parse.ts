import type { RunOptions } from '../runners/source-adapter.js';
import { namedSkillsProblem } from '../context/named-skills.js';
import type { RunOnlyKey } from './flags.js';
import { parseForkScorer, present, DEFAULT_CONCURRENCY, fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `run`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseRunCommand(ctx: ParseCtx): Command {
  const { values, repoPath, skills, fallbackProvider, proxyMode, runOptions } = ctx;
  const sources: Array<['linear' | 'github' | 'project' | 'gitlab', string]> = [];
  if (typeof values.linear === 'string') sources.push(['linear', values.linear]);
  if (typeof values.github === 'string') sources.push(['github', values.github]);
  if (typeof values.project === 'string') sources.push(['project', values.project]);
  if (typeof values.gitlab === 'string') sources.push(['gitlab', values.gitlab]);
  // Exactly one source is required.
  const picked = sources[0];
  if (sources.length !== 1 || picked === undefined) {
    return fail('run requires exactly one of --linear <id>, --github <ref>, --gitlab <ref>, or --project <number>.');
  }
  if (values.parent === true && picked[0] !== 'linear') {
    return fail('--parent is only supported with --linear.');
  }
  // One spec file cannot describe N different tasks — fan-out modes would inject it into every run.
  if (typeof values['spec-file'] === 'string' && (picked[0] === 'project' || values.parent === true)) {
    return fail('--spec-file is only supported for a single-issue run (not --parent / --project fan-out).');
  }
  if (skills.length > 0 && (picked[0] === 'project' || values.parent === true)) {
    return fail('--skill is only supported for a single-issue run (not --parent / --project fan-out); use a "Skills:" line in each issue.');
  }
  if (picked[0] === 'project') {
    const projectNum = Number(picked[1]);
    if (!Number.isInteger(projectNum) || projectNum < 1) {
      return fail(`--project expects a board number, got "${picked[1]}".`);
    }
  }
  const concurrency = Number(values.concurrency);
  const forkN = Number(values.fork);
  const forkScorer = parseForkScorer(values['fork-scorer']);
  if (forkScorer === null) return fail(`--fork-scorer expects llm or decision, got "${String(values['fork-scorer'])}".`);
  if (forkScorer !== undefined && !(Number.isFinite(forkN) && forkN >= 2)) return fail('--fork-scorer only applies with --fork <n> (n>=2).');
  // forkAndSelect runs every variant on the primary agent and returns before the stage fallback is
  // consulted, so the flag would be accepted and silently never fire.
  if (fallbackProvider !== undefined && Number.isFinite(forkN) && forkN >= 2) return fail('--fallback-provider does not apply to --fork variants; drop one of them.');
  // The single-task RunOptions (see RunOnlyKey): typed exhaustively so a new run-only field lands here.
  const skillProblem = namedSkillsProblem(skills);
  if (skillProblem !== undefined) return fail(`--skill ${skillProblem}.`);
  const runOnly = present<Pick<RunOptions, RunOnlyKey>>({
    forkScorer,
    specFile: typeof values['spec-file'] === 'string' ? values['spec-file'] : undefined,
    namedSkills: skills.length > 0 ? skills : undefined,
  });
  return {
    kind: 'run',
    source: picked[0],
    id: picked[1],
    parent: values.parent === true,
    gcBefore: values['gc-before'] === true,
    egress: values.egress === true,
    repoPath,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    ...(proxyMode ? { llmProxy: true } : {}),
    ...(Number.isFinite(forkN) && forkN >= 2 ? { forkN: Math.floor(forkN) } : {}),
    ...(values.reuse === true ? { reuse: true } : {}),
    ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
    ...(typeof values.label === 'string' ? { label: values.label } : {}),
    ...(typeof values['gitlab-project'] === 'string' && picked[0] === 'gitlab' ? { project: values['gitlab-project'] } : {}),
    ...runOptions,
    ...runOnly,
  };
}
