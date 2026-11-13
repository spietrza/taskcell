import { useEffect, useState } from 'react';
import { Button, Card, Chip, CodeBlock } from '@/ui';
import { setupStatus } from '../../ipc';
import type { SetupStatus, SetupToolState } from '../../wire';
import {
  RESTART_NOTE,
  RUN_STEPS,
  STEP_IDS,
  STEP_STATE_LABEL,
  STEP_TITLE,
  stepState,
  withSkipped,
  type OnboardingStored,
  type RunStepId,
  type StepId,
} from './steps';

const TOOL_IDS = ['gh', 'glab', 'linear'] as const;

const TOOL_STATE_TEXT: Record<SetupToolState, string> = {
  ready: 'signed in',
  'needs-login': 'not signed in',
  missing: 'not installed',
};

function Commands({ id }: { id: RunStepId }) {
  const r = RUN_STEPS[id];
  const { restartNote } = r;
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{r.label}</div>
      <p className="text-xs text-muted-foreground">You run this — the hub never reads or stores the secret value:</p>
      {restartNote ? (
        r.commands.map((c, i) => (
          <div key={i} className="space-y-1">
            <CodeBlock code={c} />
            {restartNote.includes(i) && <p className="text-xs text-muted-foreground">{RESTART_NOTE}</p>}
          </div>
        ))
      ) : (
        <CodeBlock code={r.commands.join('\n')} />
      )}
    </div>
  );
}

/**
 * The first-run guide: three steps (Git host and tasks, model credential, first repository), each
 * done / needs action / skipped. Works in the browser hub: detection is one read-only RPC, and the
 * credential steps only show commands for the user to run.
 */
export function Onboarding({
  projectCount,
  stored,
  onStored,
  onAddRepo,
  onClose,
}: {
  projectCount: number;
  stored: OnboardingStored;
  onStored: (s: OnboardingStored) => void;
  onAddRepo: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setupStatus()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setError(false);
        }
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [nonce]);

  const toggleSkip = (id: StepId): void => onStored(withSkipped(stored, id, !stored.skipped.includes(id)));
  // Until the RPC answers the rows say so; if it failed they say "unknown" instead of waiting forever.
  const unknown = error ? 'unknown' : 'checking…';
  const found = (v: boolean | undefined): string => (v === undefined ? unknown : v ? 'found' : 'not found');
  const finish = (): void => {
    onStored({ ...stored, completed: true });
    onClose();
  };
  const tool = (id: (typeof TOOL_IDS)[number]): SetupToolState | null => status?.tools.find((t) => t.id === id)?.state ?? null;

  return (
    <section aria-label="Get started" className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Get started</h2>
        <Button className="ml-auto" variant="text" color="secondary" onClick={() => setNonce((n) => n + 1)}>
          Check again
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Three short steps. Skip any of them and come back from Settings.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive-text">
          Could not check this machine. You can still follow the steps and use Check again.
        </p>
      )}
      {STEP_IDS.map((id, i) => {
        const state = stepState(id, { status, projectCount, skipped: stored.skipped });
        return (
          <Card.Root key={id} className="py-0">
            <Card.Content className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                <h3 className="font-semibold">{STEP_TITLE[id]}</h3>
                <Chip
                  color={state === 'done' ? 'success' : state === 'needs-action' ? 'warning' : 'secondary'}
                  variant="outlined"
                  className="ml-auto"
                >
                  {STEP_STATE_LABEL[state]}
                </Chip>
              </div>
              {id === 'git-host' && (
                <div className="space-y-3">
                  <ul className="space-y-1 text-sm">
                    {TOOL_IDS.map((t) => (
                      <li key={t} className="flex items-center gap-2">
                        <span className="w-28">{RUN_STEPS[t].label}</span>
                        <span className="text-muted-foreground">{tool(t) ? TOOL_STATE_TEXT[tool(t)!] : unknown}</span>
                      </li>
                    ))}
                  </ul>
                  {state !== 'done' && TOOL_IDS.filter((t) => tool(t) !== 'ready').map((t) => <Commands key={t} id={t} />)}
                </div>
              )}
              {id === 'model' && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Claude subscription: {found(status?.models.claude)} · Codex: {found(status?.models.codex)}
                  </p>
                  <div role="radiogroup" aria-label="Model credential" className="flex gap-2">
                    {(['claude', 'codex'] as const).map((m) => (
                      <Button
                        key={m}
                        role="radio"
                        aria-checked={stored.model === m}
                        variant={stored.model === m ? 'outlined' : 'text'}
                        color="secondary"
                        onClick={() => onStored({ ...stored, model: m })}
                      >
                        {RUN_STEPS[m].label}
                      </Button>
                    ))}
                  </div>
                  {state !== 'done' && <Commands id={stored.model} />}
                </div>
              )}
              {id === 'repo' && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {projectCount > 0 ? `${projectCount} ${projectCount === 1 ? 'repository' : 'repositories'} added.` : 'Pick an existing folder or clone a repository.'}
                  </p>
                  <Button onClick={onAddRepo}>{projectCount > 0 ? 'Add another repository' : 'Add a repository'}</Button>
                </div>
              )}
              {state !== 'done' && (
                <Button variant="text" color="secondary" onClick={() => toggleSkip(id)}>
                  {state === 'skipped' ? 'Undo skip' : 'Skip this step'}
                </Button>
              )}
            </Card.Content>
          </Card.Root>
        );
      })}
      <div className="flex justify-end">
        <Button variant="outlined" onClick={finish}>
          {projectCount > 0 ? 'Finish' : 'Dismiss'}
        </Button>
      </div>
    </section>
  );
}
