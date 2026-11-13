import { Button, Card, Chip, Timestamp } from '@/ui';
import { verdictColor, verdictWord } from '../../status';
import { ArrowLeft, Play } from 'lucide-react';
import type { RunSummary } from '../../taskcell-output';
import { SpecPane } from '../inspector/SpecPane';
import { IssueHistory } from './IssueHistory';
import { taskRefKey } from './taskref';

export function TaskDetail({
  project,
  taskId,
  runs,
  canRun = true,
  onBack,
  onNewRun,
}: {
  project: string;
  taskId: string;
  runs: RunSummary[];
  /** False when the task belongs to a repository other than the one runs start in ("All repositories"). */
  canRun?: boolean;
  onBack: () => void;
  onNewRun: () => void;
}) {
  // Board ids are minted bare (gh-904); run records may carry a repo slug (gh-owner-repo-904).
  // Match on the normalized source-ref key so history isn't silently empty.
  const key = taskRefKey(taskId);
  const history = runs.filter((r) => taskRefKey(r.taskId) === key);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="text" color="secondary" onClick={onBack} startIcon={<ArrowLeft className="size-4" />}>
          Board
        </Button>
        <span className="font-mono font-semibold">{taskId}</span>
        {canRun ? (
          <Button className="ml-auto" onClick={onNewRun} startIcon={<Play className="size-4" />}>
            New Run
          </Button>
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">Pick this repository in the filter to start a run.</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Card.Root>
          <Card.Content className="p-4">
            <div className="mb-2 caption">
              Spec — from source
            </div>
            <SpecPane project={project} taskId={taskId} />
          </Card.Content>
        </Card.Root>

        <div>
          <div className="mb-2 caption">
            Run history
          </div>
          <div className="space-y-2">
            {history.length === 0 ? (
              <div className="text-sm text-muted-foreground">No runs yet.</div>
            ) : (
              history.map((r) => (
                <div key={r.timestamp} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <Timestamp ms={Date.parse(r.timestamp)} className="tabular-nums text-sm text-muted-foreground" />
                    <Chip color={verdictColor(!r.anyFailed)} variant="outlined">
                      {verdictWord(!r.anyFailed)}
                    </Chip>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{r.stages.join(', ')}</span>
                    <span className="tabular-nums">${r.totalCostUsd.toFixed(2)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <IssueHistory project={project} taskId={taskId} />
    </div>
  );
}
