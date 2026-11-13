import { useState, type ReactNode } from 'react';
import { Button, cn } from '@/ui';
import { useNavGuardRegistry } from '../../navGuard';
import { canUseNeedsYou } from '../needs-you/NeedsYou';
import { Settings } from './Settings';
import type { TeamScreen } from './Members';
import { WorkflowEditor } from '../workflow/WorkflowEditor';
import { AuditLog } from '../audit/AuditLog';
import { Lessons } from '../lessons/Lessons';

type Section = 'general' | 'line' | 'runners' | 'lessons' | 'audit';

/**
 * Settings, with the sections the prototype puts under it: General (the project's settings), Line (the
 * workflow editor) and Runners (Fleet where available, and Remote). Audit (hub only) lives here too.
 */
export function SettingsScreen({
  project,
  teamScreen,
  onOpenSetup,
  fleet,
  remote,
}: {
  project: string;
  /** The selected team's Members section (hub), shown under General. */
  teamScreen?: TeamScreen;
  /** Reopens the first-run guide. */
  onOpenSetup?: () => void;
  fleet: ReactNode;
  remote: ReactNode;
}) {
  const [section, setSection] = useState<Section>('general');
  const registry = useNavGuardRegistry();
  const sections: { key: Section; label: string }[] = [
    { key: 'general', label: 'General' },
    { key: 'line', label: 'Line' },
    { key: 'runners', label: 'Runners' },
    ...(canUseNeedsYou() ? [{ key: 'lessons' as const, label: 'Lessons' }, { key: 'audit' as const, label: 'Audit' }] : []),
  ];
  // Switching sections unmounts a dirty editor, so it confirms like any other navigation.
  const choose = (key: Section): void => {
    if (key === section || registry?.confirm() === false) return;
    setSection(key);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div role="tablist" aria-label="Settings sections" className="flex shrink-0 gap-1 border-b border-border">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={section === s.key}
            onClick={() => choose(s.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors',
              section === s.key ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'general' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {onOpenSetup && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <span>Setup guide: sign-ins, model credential and first repository.</span>
              <Button className="ml-auto" variant="outlined" onClick={onOpenSetup}>
                Reopen setup guide
              </Button>
            </div>
          )}
          <Settings project={project} {...(teamScreen ? { teamScreen } : {})} />
        </div>
      ) : section === 'line' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkflowEditor project={project} />
        </div>
      ) : section === 'runners' ? (
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          {fleet && (
            <section className="space-y-2">
              <h3 className="text-lg font-semibold">Fleet</h3>
              {fleet}
            </section>
          )}
          <section className="flex min-h-96 flex-col space-y-2">
            <h3 className="text-lg font-semibold">Remote</h3>
            {remote}
          </section>
        </div>
      ) : section === 'lessons' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Lessons project={project} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <AuditLog />
        </div>
      )}
    </div>
  );
}
