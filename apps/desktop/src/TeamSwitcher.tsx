import type { ReactElement } from 'react';
import { Check, ChevronsUpDown, Plus, Users } from 'lucide-react';
import { Menu } from '@/ui';
import type { Team } from './wire';

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
/** What the menu says under a team: its people when it has members (server mode), else its projects (a local hub). */
const sizeOf = (t: Team): string => (t.members.length > 0 ? count(t.members.length, 'person').replace('persons', 'people') : count(t.repositories.length, 'project'));

/** The team in the top bar, as the prototype has it: `name · team`, a menu with the teams and the way to add a project. */
export function TeamSwitcher({
  teams,
  active,
  onSelect,
  onAddProject,
}: {
  teams: Team[];
  active: Team | undefined;
  onSelect: (id: string) => void;
  onAddProject?: (() => void) | undefined;
}): ReactElement | null {
  if (!active) return null;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Team: ${active.name}`}
        className="flex h-8 max-w-48 cursor-pointer items-center gap-2 rounded border border-border px-2 text-sm hover:bg-muted max-md:max-w-32"
      >
        <Users aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono font-semibold">{active.name}</span>
        <span aria-hidden className="shrink-0 font-mono text-muted-foreground max-md:hidden">· team</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Content side="bottom" align="start" className="min-w-64">
        {teams.map((t) => (
          <Menu.Item key={t.id} onClick={() => t.id !== active.id && onSelect(t.id)} className="gap-2">
            <Check aria-hidden className={t.id === active.id ? 'size-4 text-primary' : 'invisible size-4'} />
            <span className="font-semibold">{t.name}</span>
            <span className="font-mono text-xs text-muted-foreground">team · {sizeOf(t)}</span>
          </Menu.Item>
        ))}
        {onAddProject && (
          <>
            <Menu.Separator />
            <Menu.Item onClick={onAddProject} className="gap-2">
              <Plus aria-hidden className="size-4" />
              Set up a new project
            </Menu.Item>
          </>
        )}
      </Menu.Content>
    </Menu.Root>
  );
}
