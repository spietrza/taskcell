import { useState, type CSSProperties } from 'react';
import { Button, Card, Chip, Empty } from '@/ui';
import { Factory, FolderPlus, LayoutGrid, X } from 'lucide-react';
import { projectColor } from '../../color';
import { combinationNote, runLocationLabel, taskSourceLabel } from '../../platform';
import { relTime } from '../../time';
import type { Project } from '../../taskcell-output';
import type { FactoryState } from '../../wire';
import { factoryLabel } from './factoryLabel';

function Stat({
  label,
  value,
  accent,
  dot,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  dot?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="caption">{label}</div>
      <div className={`mt-1 flex items-center gap-1.5 text-2xl font-semibold tabular-nums ${accent ? 'text-success-text' : ''}`}>
        {dot && <span className="size-2 rounded-full bg-success" />}
        {value}
      </div>
    </div>
  );
}

export function Dashboard({
  projects,
  onOpen,
  onAdd,
  onRemove,
  onEnableFactory,
  factory,
}: {
  projects: Project[];
  onOpen: (p: { path: string; name: string }) => void;
  onAdd: () => void;
  onRemove: (path: string) => void;
  /** Hub-only (the `enable_factory_*` commands are HUB_ONLY): omitted, the card has no button. */
  onEnableFactory?: (p: { path: string; name: string }) => void;
  /** Each project's factory checklist state by path (hub-only); a project without an entry shows no factory line. */
  factory?: Record<string, FactoryState>;
}) {
  // Path of the card whose × was clicked: removal waits for a second, explicit click.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const totals = {
    projects: projects.length,
    running: projects.reduce((n, p) => n + p.runningCount, 0),
    runs: projects.reduce((n, p) => n + p.runCount, 0),
    last24h: projects.reduce((n, p) => n + p.runsLast24h, 0),
    spend: projects.reduce((n, p) => n + p.totalCostUsd, 0),
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Projects</h2>
        <Button className="ml-auto" onClick={onAdd} startIcon={<FolderPlus className="size-4" />}>
          Add project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Empty.Root>
          <Empty.Media>
            <LayoutGrid />
          </Empty.Media>
          <Empty.Title>No projects yet</Empty.Title>
          <Empty.Description>
            Add any git repository to track its factory runs, tasks and spend.
          </Empty.Description>
          <Empty.Actions>
            <Button onClick={onAdd} startIcon={<FolderPlus className="size-4" />}>
              Add project
            </Button>
            <Button variant="outlined" onClick={() => window.location.assign('/?demo=1')}>
              Try the demo project
            </Button>
          </Empty.Actions>
        </Empty.Root>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Projects" value={totals.projects} />
            <Stat label="Running" value={totals.running} accent={totals.running > 0} dot={totals.running > 0} />
            <Stat label="Runs" value={totals.runs} />
            <Stat label="Last 24h" value={totals.last24h} />
            <Stat label="Spend" value={`$${totals.spend.toFixed(2)}`} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const note = combinationNote(p.taskSource, p.runLocation);
              const fs = factory?.[p.path];
              const last = p.lastRun ? relTime(new Date(p.lastRun).getTime()) : null;
              const color = projectColor(p);
              return (
                <Card.Root
                  key={p.path}
                  style={{ ['--proj']: color } as CSSProperties}
                  className="relative overflow-hidden pl-1.5 transition-colors hover:border-[color:var(--proj)] has-[.proj-open:focus-visible]:ring-2 has-[.proj-open:focus-visible]:ring-ring"
                >
                  {/* Project identity color — matches the in-project top bar and the border on hover so
                      cards read as one consistent object. */}
                  <span
                    className="absolute inset-y-0 left-0 w-1.5"
                    style={{ backgroundColor: color }}
                    aria-hidden
                  />
                  <Card.Header className="flex flex-row items-start justify-between gap-2 pb-2">
                    <div className="min-w-0">
                      <Card.Title className="flex items-center gap-2 truncate">
                        {/* Stretched over the whole card (after:inset-0) so the card opens by click
                            and by keyboard without nesting buttons; the card's own buttons (Remove,
                            Enable factory) sit above it with `relative z-10`. */}
                        <button
                          type="button"
                          onClick={() => onOpen({ path: p.path, name: p.name })}
                          className="proj-open cursor-pointer truncate text-left outline-none after:absolute after:inset-0"
                        >
                          {p.name}
                        </button>
                        {p.runningCount > 0 && (
                          <span className="flex items-center gap-1 text-xs font-normal text-success-text">
                            <span className="size-2 animate-pulse rounded-full bg-success" />
                            {p.runningCount}
                          </span>
                        )}
                      </Card.Title>
                      <Card.Description className="truncate" title={p.path}>
                        {p.path}
                      </Card.Description>
                    </div>
                    {confirmRemove === p.path ? (
                      <div className="relative z-10 flex shrink-0 items-center gap-1 text-xs">
                        <Button
                          variant="text"
                          color="secondary"
                          className="h-6 px-1.5 text-xs"
                          autoFocus
                          onClick={() => setConfirmRemove(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="text"
                          color="destructive"
                          className="h-6 px-1.5 text-xs"
                          onClick={() => {
                            setConfirmRemove(null);
                            onRemove(p.path);
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(p.path)}
                        aria-label={`Remove ${p.name}`}
                        title="Remove from the hub (the repo itself is not touched)"
                        className="relative z-10 text-muted-foreground transition-colors hover:text-destructive-text"
                      >
                        <X className="size-4" />
                      </button>
                    )}
                  </Card.Header>
                  <Card.Content className="pt-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                      <span>{p.runCount} runs</span>
                      <span>{p.taskCount} tasks</span>
                      <span>${p.totalCostUsd.toFixed(2)}</span>
                      {p.failedCount > 0 && <span className="text-destructive-text">{p.failedCount} failed</span>}
                      {p.runsLast24h > 0 && <Chip color="secondary" variant="outlined">{p.runsLast24h} in 24h</Chip>}
                      {last && <span className="ml-auto">{last}</span>}
                    </div>
                    {/* Platform: where tasks come from and where work runs, so projects set up differently read side by side. */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Chip color="secondary" variant="outlined">{taskSourceLabel(p.taskSource)}</Chip>
                      <span className="text-xs text-muted-foreground" aria-hidden>→</span>
                      <Chip color="secondary" variant="outlined">{runLocationLabel(p.runLocation)}</Chip>
                    </div>
                    {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
                    {fs && (
                      <p
                        data-testid="factory-state"
                        className={`mt-1 text-xs ${fs.state === 'broken' ? 'text-destructive-text' : fs.state === 'ready' ? 'text-success-text' : 'text-muted-foreground'}`}
                      >
                        {factoryLabel(fs)}
                      </p>
                    )}
                    {onEnableFactory && (
                      <Button
                        className="relative z-10 mt-3 h-7 px-2 text-xs"
                        variant="outlined"
                        color="secondary"
                        startIcon={<Factory className="size-3.5" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEnableFactory({ path: p.path, name: p.name });
                        }}
                      >
                        {fs && fs.state !== 'none' ? 'Factory checklist' : 'Enable factory'}
                      </Button>
                    )}
                  </Card.Content>
                </Card.Root>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
