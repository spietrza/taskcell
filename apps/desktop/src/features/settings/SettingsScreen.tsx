import { useEffect, useRef, type ReactNode } from 'react';
import { Button, cn } from '@/ui';
import { useNavGuardRegistry } from '../../navGuard';
import { SETTINGS_SECTIONS, type SettingsSection } from './sections';
import { Settings } from './Settings';
import { Members, type TeamScreen } from './Members';
import { LineEditor } from '../line/LineEditor';
import { AuditLog } from '../audit/AuditLog';
import { Lessons } from '../lessons/Lessons';
import { Skills } from '../skills/Skills';
import { LocalRunner } from './LocalRunner';
import { CredentialsPanel } from './CredentialsPanel';

/**
 * Settings, with the sections the prototype puts under it: General (the project's settings), Line (the
 * six stations, with the workflow editor under Custom flows) and Runners (Fleet where available, and Remote). Audit (hub only) lives here too.
 */
export function SettingsScreen({
  project,
  teamScreen,
  onOpenSetup,
  fleet,
  remote,
  section,
  onSection,
}: {
  project: string;
  /** The selected team's Members section (hub), shown under Team & hub. */
  teamScreen?: TeamScreen;
  /** Reopens the first-run guide. */
  onOpenSetup?: () => void;
  fleet: ReactNode;
  remote: ReactNode;
  /** The open section: owned by the app so the address and the top bar's menu can name it. */
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}) {
  const registry = useNavGuardRegistry();
  const tabs = useRef<HTMLDivElement>(null);
  // On a phone the open section's tab can sit past the edge (a link to Team & hub): bring it into view.
  useEffect(() => {
    tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section]);
  // Switching sections unmounts a dirty editor, so it confirms like any other navigation.
  const choose = (key: SettingsSection): void => {
    if (key === section || registry?.confirm() === false) return;
    onSection(key);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* A phone cannot fit every tab: the row scrolls sideways under an edge fade. */}
      <div ref={tabs} role="tablist" aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border scroll-cue-x">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={section === s.key}
            onClick={() => choose(s.key)}
            className={cn(
              '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-sm transition-colors',
              section === s.key ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'general' ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-4">
          <Settings project={project} />
        </div>
      ) : section === 'hub' ? (
        // Hub-wide settings, not the picked project's: no project picker here, and nothing waits for the project's Save.
        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto pr-4">
          {onOpenSetup && (
            <div className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <span>Setup guide: sign-ins, model credential and first repository.</span>
              <Button className="ml-auto" variant="outlined" onClick={onOpenSetup}>
                Reopen setup guide
              </Button>
            </div>
          )}
          {teamScreen && (
            <section aria-label="Team" className="space-y-4">
              <div>
                <h2 className="text-xl font-semibold">Team: {teamScreen.team.name}</h2>
                <p className="text-sm text-muted-foreground">Members and repositories of the team, shared by every project in it. Changes apply at once.</p>
              </div>
              <Members {...teamScreen} />
            </section>
          )}
          <CredentialsPanel />
        </div>
      ) : section === 'line' ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-4">
          <LineEditor project={project} />
        </div>
      ) : section === 'runners' ? (
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-4">
          {fleet && <section className="space-y-2">{fleet}</section>}
          <LocalRunner project={project} />
          <section className="flex min-h-96 flex-col space-y-2">
            <h3 className="text-lg font-semibold">Remote</h3>
            {remote}
          </section>
        </div>
      ) : section === 'lessons' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Lessons project={project} />
        </div>
      ) : section === 'skills' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Skills project={project} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <AuditLog />
        </div>
      )}
    </div>
  );
}
