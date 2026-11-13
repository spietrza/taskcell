import type { SetupStatus, SetupToolStatus } from '../../wire';

export type StepId = 'git-host' | 'model' | 'repo';
export type StepState = 'done' | 'needs-action' | 'skipped';

export const STEP_IDS: readonly StepId[] = ['git-host', 'model', 'repo'];

export const STEP_TITLE: Record<StepId, string> = {
  'git-host': 'Connect your Git host and tasks',
  model: 'Choose the model credential',
  repo: 'Add your first repository',
};

export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  'needs-action': 'Needs action',
  skipped: 'Skipped',
};

/** What the wizard remembers (localStorage): finished/dismissed, and the steps the user skipped. */
export interface OnboardingStored {
  completed: boolean;
  skipped: StepId[];
}

export const EMPTY_STORED: OnboardingStored = { completed: false, skipped: [] };

const KEY = 'vanguard.onboarding';

export function loadOnboarding(): OnboardingStored {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return EMPTY_STORED;
    const r = raw as Partial<OnboardingStored>;
    return {
      completed: r.completed === true,
      skipped: Array.isArray(r.skipped) ? r.skipped.filter((s): s is StepId => STEP_IDS.includes(s as StepId)) : [],
    };
  } catch {
    return EMPTY_STORED;
  }
}

export function saveOnboarding(s: OnboardingStored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the wizard simply shows again next time */
  }
}

export interface StepInput {
  /** The hub's detection; null until it answers (or when it cannot, e.g. outside the hub). */
  status: SetupStatus | null;
  projectCount: number;
  skipped: readonly StepId[];
}

const ready = (tools: SetupToolStatus[], id: SetupToolStatus['id']): boolean =>
  tools.some((t) => t.id === id && t.state === 'ready');

/** Detected facts win over a skip; a skip only hides "needs action". */
export function stepState(id: StepId, input: StepInput): StepState {
  const detected =
    id === 'git-host'
      ? input.status !== null && (ready(input.status.tools, 'gh') || ready(input.status.tools, 'glab'))
      : id === 'model'
        ? input.status !== null && (input.status.models.claude || input.status.models.codex)
        : input.projectCount > 0;
  if (detected) return 'done';
  return input.skipped.includes(id) ? 'skipped' : 'needs-action';
}

/** First run = no projects and onboarding neither finished nor dismissed. */
export function showOnFirstRun(stored: OnboardingStored, projectCount: number): boolean {
  return !stored.completed && projectCount === 0;
}

/** Skip or un-skip a step. */
export function withSkipped(stored: OnboardingStored, id: StepId, skip: boolean): OnboardingStored {
  const rest = stored.skipped.filter((s) => s !== id);
  return { ...stored, skipped: skip ? [...rest, id] : rest };
}

/** The "you run this" lines per tool or credential; the hub never reads or stores the value. */
export type RunStepId = 'gh' | 'glab' | 'linear' | 'claude' | 'codex';
export const RUN_STEPS: Record<RunStepId, { label: string; commands: string[] }> = {
  gh: { label: 'GitHub (gh)', commands: ['gh auth login'] },
  glab: { label: 'GitLab (glab)', commands: ['glab auth login'] },
  linear: { label: 'Linear', commands: ['export LINEAR_API_KEY=<your key>   # on the machine running the hub'] },
  claude: { label: 'Claude subscription', commands: ['claude setup-token', 'export CLAUDE_CODE_OAUTH_TOKEN=<the token it prints>   # on the machine running the hub'] },
  codex: { label: 'Codex', commands: ['codex login   # sign in with ChatGPT', '# or, instead of signing in:', 'export OPENAI_API_KEY=<your key>   # on the machine running the hub'] },
};

/** A small first task the factory can deliver quickly, with acceptance criteria. */
export const STARTER_TASK = {
  title: 'Add a "Getting started" section to the README',
  body: [
    'Add a short "Getting started" section to the README that says how to install, run and test this project.',
    '',
    '## Acceptance criteria',
    '- [ ] The README has a "Getting started" section',
    '- [ ] It lists the install, run and test commands this repo actually uses',
    '- [ ] No source files other than the README are changed',
    '- [ ] Existing tests still pass',
  ].join('\n'),
} as const;
