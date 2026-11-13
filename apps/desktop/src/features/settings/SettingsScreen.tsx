import { useState, type ReactNode } from 'react';
import { cn } from '@/ui';
import { useNavGuardRegistry } from '../../navGuard';
import { canUseNeedsYou } from '../needs-you/NeedsYou';
import { Settings } from './Settings';
import { WorkflowEditor } from '../workflow/WorkflowEditor';
import { AuditLog } from '../audit/AuditLog';

type Section = 'general' | 'line' | 'runners' | 'audit';

/**
 * Settings, with the sections the prototype puts under it: General (the project's settings), Line (the
 * workflow editor) and Runners (Fleet where available, and Remote). Audit (hub only) lives here too.
 */
export function SettingsScreen({ project, fleet, remote }: { project: string; fleet: ReactNode; remote: ReactNode }) {
  const [section, setSection] = useState<Section>('general');
  const registry = useNavGuardRegistry();
  const sections: { key: Section; label: string }[] = [
    { key: 'general', label: 'General' },
    { key: 'line', label: 'Line' },
    { key: 'runners', label: 'Runners' },
    ...(canUseNeedsYou() ? [{ key: 'audit' as const, label: 'Audit' }] : []),
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
          <Settings project={project} />
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
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <AuditLog />
        </div>
      )}
    </div>
  );
}
