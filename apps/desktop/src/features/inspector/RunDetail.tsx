import { useState } from 'react';
import { Tabs } from '@/ui';
import { ProofGate } from './ProofGate';
import { StageCard } from './StageCard';
import { DiffView } from './DiffView';
import { TranscriptView } from './TranscriptView';
import { SpecPane } from './SpecPane';
import { AppliedLessons } from '../lessons/Lessons';
import { ExternalLink, hostName } from '../../components/ExternalLink';
import type { RunDetail as RunDetailT } from '../../taskcell-output';
import { cn } from '@/ui';
import { estLabel, estTitle } from '../../cost';
import { fmtDuration, stageLabel, stagesFromRecords, withGateSteps, type PaneStage, type StagePhase } from './runStages';

const PHASE_ICON: Record<StagePhase, string> = { done: '✓', failed: '✕', running: '•', pending: '○' };

/** What the factory did, one line per step in the stage records (plus the gate and the PR), oldest first. */
function Activity({ detail, steps = withGateSteps(stagesFromRecords(detail.stages), detail.proof, detail.prUrl) }: { detail: RunDetailT; steps?: PaneStage[] | undefined }) {
  return (
    <ol aria-label="What the factory did" className="space-y-1.5">
      {steps.map((s, i) => {
        const record = s.src !== undefined ? detail.stages[s.src]?.record : undefined;
        const meta = record === undefined ? [] : [
          (record.attempts ?? 1) > 1 ? `${record.attempts} attempts` : undefined,
          record.costUsd != null ? `$${record.costUsd.toFixed(2)}` : estLabel(record.estCostUsd),
        ].filter((m): m is string => m !== undefined);
        const time = s.note ?? (s.ms !== undefined ? fmtDuration(s.ms) : undefined);
        return (
          <li key={i} data-testid={`step-${i}`} data-phase={s.phase} className="flex items-baseline gap-2 text-sm">
            <span aria-hidden className={cn('w-4 shrink-0 text-center', s.phase === 'failed' ? 'text-destructive-text' : 'text-success-text')}>{PHASE_ICON[s.phase]}</span>
            <span className={cn('font-medium', s.phase === 'failed' && 'text-destructive-text')}>{s.label ?? stageLabel(s.name)}</span>
            {record?.model !== undefined && <span className="font-mono text-xs text-muted-foreground">{record.model}</span>}
            {record?.verdict !== undefined && <span className="text-xs text-muted-foreground">{record.verdict === 'pass' ? 'passed' : record.verdict === 'changes' ? 'changes requested' : record.verdict}</span>}
            {meta.length > 0 && <span className="text-xs text-muted-foreground" {...estTitle(meta.join(' · '))}>{meta.join(' · ')}</span>}
            {time !== undefined && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{time}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** `prLink` off when the surrounding header already links the PR (the Runs split view); `steps` = the caller's own stage line (with the event log's timings). */
export function RunDetail({ detail, project, prLink = true, steps, flow }: { detail: RunDetailT; project: string; prLink?: boolean; steps?: PaneStage[]; flow?: string | undefined }) {
  const [tab, setTab] = useState('activity');
  const baseBranch = detail.stages.find((s) => s.record.baseBranch !== undefined)?.record.baseBranch;
  const configPaths = detail.stages.find((s) => s.record.configPaths !== undefined)?.record.configPaths;
  const credentialSource = detail.stages.find((s) => s.record.credentialSource !== undefined)?.record.credentialSource;
  const credentialName = detail.stages.find((s) => s.record.credentialName !== undefined)?.record.credentialName;
  const diffStages = detail.stages.filter((s) => s.diff || s.record.diffOmitted);
  const transcriptStages = detail.stages.filter((s) => s.transcript);

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => setTab(String(v))}
      className="flex h-full min-h-0 flex-col"
    >
      <Tabs.List className="shrink-0 overflow-x-auto">
        <Tabs.Tab value="activity" className="whitespace-nowrap">What the factory did</Tabs.Tab>
        <Tabs.Tab value="spec" className="whitespace-nowrap">Spec</Tabs.Tab>
        <Tabs.Tab value="diff" className="whitespace-nowrap">Diff</Tabs.Tab>
        <Tabs.Tab value="transcript" className="whitespace-nowrap">Transcript</Tabs.Tab>
        <Tabs.Indicator />
      </Tabs.List>

      <Tabs.Panel value="activity" className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-4">
        {/* The split view's header already names the target branch. */}
        {prLink && baseBranch && (
          <div className="text-sm text-muted-foreground">
            Target branch <code className="rounded bg-muted px-1 py-0.5">{baseBranch}</code>
          </div>
        )}
        {flow !== undefined && (
          <div className="text-sm text-muted-foreground">
            Flow <code className="rounded bg-muted px-1 py-0.5">{flow}</code>
          </div>
        )}
        {configPaths !== undefined && configPaths.length > 0 && (
          <div role="note" className="text-sm text-warning-text" title="This run changed a file your test commands come from. Check it before merging.">
            Gate config changed: <code className="rounded bg-muted px-1 py-0.5">{configPaths.join(', ')}</code>
          </div>
        )}
        {credentialSource !== undefined && (
          <div className="text-sm text-muted-foreground">
            Model usage billed to {credentialSource === 'user' ? "the starter's own account" : "the hub's account"}{credentialName !== undefined && ` "${credentialName}"`}
          </div>
        )}
        {((prLink && detail.prUrl !== undefined) || detail.ciUrl !== undefined) && (
          <div className="flex flex-wrap gap-3">
            {prLink && detail.prUrl !== undefined && <ExternalLink href={detail.prUrl}>{`Open in ${hostName(detail.prUrl)}`}</ExternalLink>}
            <ExternalLink href={detail.ciUrl}>CI run</ExternalLink>
          </div>
        )}
        <Activity detail={detail} steps={steps} />
        <ProofGate proof={detail.proof} />
        <AppliedLessons project={project} taskId={detail.taskId} />
        <div className="space-y-2">
          {detail.stages.map((s, i) => (
            <StageCard key={i} stage={s} />
          ))}
        </div>
      </Tabs.Panel>

      <Tabs.Panel value="spec" className="min-h-0 flex-1 overflow-y-auto pt-4">
        {tab === 'spec' && <SpecPane project={project} taskId={detail.taskId} />}
      </Tabs.Panel>

      <Tabs.Panel value="diff" className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4">
        {detail.diffUrl !== undefined && (
          <ExternalLink href={detail.diffUrl}>
            {hostName(detail.diffUrl) === 'GitLab' ? 'Changes on GitLab' : 'Files changed on GitHub'}
          </ExternalLink>
        )}
        {diffStages.length === 0 && <DiffView />}
        {diffStages.map((s, i) => (
          <div key={i} className="space-y-1">
            {diffStages.length > 1 && (
              <div className="font-mono text-xs text-muted-foreground">{s.record.stage ?? 'run'}</div>
            )}
            {s.record.diffOmitted ? (
              <div className="text-sm text-muted-foreground">diff withheld: {s.record.diffOmitted}</div>
            ) : (
              <DiffView diff={s.diff} />
            )}
          </div>
        ))}
      </Tabs.Panel>

      <Tabs.Panel value="transcript" className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4">
        {transcriptStages.length === 0 && <TranscriptView />}
        {transcriptStages.map((s, i) => (
          <div key={i} className="space-y-1">
            {transcriptStages.length > 1 && (
              <div className="font-mono text-xs text-muted-foreground">{s.record.stage ?? 'run'}</div>
            )}
            <TranscriptView transcript={s.transcript} />
          </div>
        ))}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
