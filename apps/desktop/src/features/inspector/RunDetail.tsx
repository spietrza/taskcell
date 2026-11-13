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

export function RunDetail({ detail, project }: { detail: RunDetailT; project: string }) {
  const [tab, setTab] = useState('overview');
  const baseBranch = detail.stages.find((s) => s.record.baseBranch !== undefined)?.record.baseBranch;
  const diffStages = detail.stages.filter((s) => s.diff || s.record.diffOmitted);
  const transcriptStages = detail.stages.filter((s) => s.transcript);

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => setTab(String(v))}
      className="flex h-full min-h-0 flex-col"
    >
      <Tabs.List className="shrink-0">
        <Tabs.Tab value="overview">Overview</Tabs.Tab>
        <Tabs.Tab value="spec">Spec</Tabs.Tab>
        <Tabs.Tab value="diff">Diff</Tabs.Tab>
        <Tabs.Tab value="transcript">Transcript</Tabs.Tab>
        <Tabs.Indicator />
      </Tabs.List>

      <Tabs.Panel value="overview" className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-4">
        {baseBranch && (
          <div className="text-sm text-muted-foreground">
            Target branch <code className="rounded bg-muted px-1 py-0.5">{baseBranch}</code>
          </div>
        )}
        {(detail.prUrl !== undefined || detail.ciUrl !== undefined) && (
          <div className="flex flex-wrap gap-3">
            {detail.prUrl !== undefined && (
              <ExternalLink href={detail.prUrl}>{`Open in ${hostName(detail.prUrl)}`}</ExternalLink>
            )}
            <ExternalLink href={detail.ciUrl}>CI run</ExternalLink>
          </div>
        )}
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
