import { useState, type CSSProperties } from 'react';
import { Button, Card, Chip, Empty } from '@/ui';
import { FolderPlus, LayoutGrid, X } from 'lucide-react';
import { projectColor } from '../../color';
import { combinationNote, runLocationLabel, runsOn, taskSourceLabel } from '../../platform';
import { relTime } from '../../time';
import type { Project } from '../../taskcell-output';
import { gateProps } from '../../hooks';
import type { CallerCapability, FactoryState, LocalWorkerState } from '../../wire';
import { autoRunLabel } from './factoryLabel';

export function Dashboard({
  projects,
  onOpen,
  onAdd,
  addGate,
  onRemove,
  onOpenAutoRun,
  onOpenSetup,
  factory,
  localWorker,
}: {
  projects: Project[];
  onOpen: (p: { path: string; name: string }) => void;
  onAdd: () => void;
  /** The hub's answer on adding a project: refused, the buttons are disabled with its reason. */
  addGate?: CallerCapability | undefined;
  onRemove: (path: string) => void;
  /** Opens the project's auto-run setup (Settings → Line, station Card); omitted, the state is plain text. */
  onOpenAutoRun?: (p: { path: string; name: string }) => void;
  /** Opens the first-run guide; offered in the empty state. */
  onOpenSetup?: () => void;
  /** Each project's CI factory checklist state by path; with `localWorker`, it makes the card's Auto-run line. */
  factory?: Record<string, FactoryState>;
  /** Each project's Local hub worker state by path. A project in neither map shows no Auto-run line (not read yet). */
  localWorker?: Record<string, LocalWorkerState>;
}) {
  // Path of the card whose × was clicked: removal waits for a second, explicit click.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Projects</h2>
        <Button className="ml-auto" {...gateProps(addGate)} onClick={onAdd} startIcon={<FolderPlus className="size-4" />}>
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
            Add a git repository (an existing folder, or clone one) to track its factory runs, cards and spend. The setup guide also checks your sign-ins.
          </Empty.Description>
          <Empty.Actions>
            <Button {...gateProps(addGate)} onClick={onAdd} startIcon={<FolderPlus className="size-4" />}>
              Add project
            </Button>
            {onOpenSetup && (
              <Button variant="outlined" onClick={onOpenSetup}>
                Open setup guide
              </Button>
            )}
            <Button variant="outlined" onClick={() => window.location.assign('/?demo=1')}>
              Try the demo project
            </Button>
          </Empty.Actions>
        </Empty.Root>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const fs = factory?.[p.path];
              const location = runsOn(p, fs);
              const note = combinationNote(p.taskSource, location);
              const lw = localWorker?.[p.path];
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
                            the Auto-run link) sit above it with `relative z-10`. */}
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
                      {/* taskCount counts the cards that have runs, not the board's open cards. */}
                      <span>{p.runCount} {p.runCount === 1 ? 'run' : 'runs'} on {p.taskCount} {p.taskCount === 1 ? 'card' : 'cards'}</span>
                      <span>${p.totalCostUsd.toFixed(2)} spent</span>
                      {p.ciRunCount !== undefined && <span>{p.ciRunCount} in CI</span>}
                      {p.failedCount > 0 && <span className="text-destructive-text">{p.failedCount} failed</span>}
                      {/* A count over all runs, answered ones too: neutral, the orange "waits for you" is Home's inbox. */}
                      {p.askedCount !== undefined && p.askedCount > 0 && <span>{p.askedCount} stopped to ask</span>}
                      {p.runsLast24h > 0 && <Chip color="secondary" variant="outlined">{p.runsLast24h} {p.runsLast24h === 1 ? 'run' : 'runs'} in 24h</Chip>}
                      {last && <span className="ml-auto">{last}</span>}
                    </div>
                    {/* Platform: where tasks come from and where work runs, so projects set up differently read side by side. */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {/* Unset is not GitHub Issues: the board asks for an explicit source, and Settings shows it as "—". */}
                      <span className="text-xs text-muted-foreground">Cards from</span>
                      <Chip color="secondary" variant="outlined">{p.taskSource ? taskSourceLabel(p.taskSource) : 'No card source'}</Chip>
                      <span className="text-xs text-muted-foreground">run on</span>
                      <Chip color="secondary" variant="outlined">{runLocationLabel(location)}</Chip>
                    </div>
                    {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
                    {(fs || lw) && (() => {
                      const run = autoRunLabel(p.taskSource, fs, lw);
                      const tone = run.tone === 'bad' ? 'text-destructive-text' : run.tone === 'on' ? 'text-success-text' : 'text-muted-foreground';
                      return onOpenAutoRun ? (
                        <button
                          type="button"
                          data-testid="auto-run"
                          title="Set up auto-run in Settings → Line"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenAutoRun({ path: p.path, name: p.name });
                          }}
                          className={`relative z-10 mt-2 block max-w-full truncate text-left text-xs hover:underline ${tone}`}
                        >
                          {run.text}
                        </button>
                      ) : (
                        <p data-testid="auto-run" className={`mt-2 truncate text-xs ${tone}`}>{run.text}</p>
                      );
                    })()}
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
