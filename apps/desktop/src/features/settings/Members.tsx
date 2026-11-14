import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Button, Input } from '@/ui';
import { teamAddMember, teamAddRepository, teamRemoveMember, teamRemoveRepository, teamRole, teamSetRole } from '../../ipc';
import type { Project } from '../../taskcell-output';
import type { Team, TeamRole } from '../../wire';

/** What the Settings screen needs to edit the selected team. */
export interface TeamScreen {
  team: Team;
  /** Every hub project: the repositories an admin may add. */
  allProjects: Project[];
  onTeam: (t: Team) => void;
  /** Asked before removing a repository that is the open project (a dirty screen would be dropped). */
  confirmRemoveRepo: (path: string) => boolean;
}

/** Members and repositories of the selected team. Only an admin sees controls; a member reads the list. */
export function Members({ team, allProjects, onTeam, confirmRemoveRepo }: TeamScreen): ReactElement {
  const [role, setRole] = useState<TeamRole | null>(null);
  const [login, setLogin] = useState('');
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string>();
  // The member whose removal is awaiting its second click (the project card's inline confirm).
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    teamRole(team.id).then((r) => alive && setRole(r), () => alive && setRole(null));
    return () => {
      alive = false;
    };
    // Refetch on every edit: the caller may just have demoted themselves.
  }, [team]);

  const edit = (action: Promise<Team>, after?: () => void): void => {
    setError(undefined);
    action.then(
      (t) => {
        onTeam(t);
        after?.();
      },
      (e: unknown) => setError(String(e)),
    );
  };

  const admin = role === 'admin';
  // The default team lists every project by definition; only other teams take repository edits.
  const editRepos = admin && team.id !== 'default';
  const nameOf = (path: string): string => allProjects.find((p) => p.path === path)?.name ?? path.split('/').filter(Boolean).pop() ?? path;
  const addable = allProjects.filter((p) => !team.repositories.includes(p.path));

  return (
    <section aria-label="Members" className="space-y-4">
      <h3 className="text-lg font-semibold">Members of {team.name}</h3>
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </div>
      )}
      <ul className="divide-y divide-border rounded border border-border">
        {team.members.map((m) => (
          <li key={m.login} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{m.login}</span>
            {admin ? (
              <>
                <select
                  aria-label={`Role of ${m.login}`}
                  value={m.role}
                  onChange={(e) => edit(teamSetRole(team.id, m.login, e.target.value as TeamRole))}
                  className="h-9 rounded border border-border bg-background px-2 text-sm"
                >
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                </select>
                {confirmRemove === m.login ? (
                  <div className="flex items-center gap-1 text-xs">
                    <span className="text-muted-foreground">Remove {m.login} from {team.name}?</span>
                    <Button variant="text" color="secondary" autoFocus onClick={() => setConfirmRemove(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="text"
                      color="destructive"
                      aria-label={`Confirm removing ${m.login}`}
                      onClick={() => {
                        setConfirmRemove(null);
                        edit(teamRemoveMember(team.id, m.login));
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Button aria-label={`Remove ${m.login}`} onClick={() => setConfirmRemove(m.login)}>
                    Remove
                  </Button>
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{m.role}</span>
            )}
          </li>
        ))}
      </ul>
      {admin && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (login.trim() !== '') edit(teamAddMember(team.id, login, 'member'), () => setLogin(''));
          }}
        >
          <Input aria-label="Login" placeholder="Login" value={login} onChange={(e) => setLogin(e.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" disabled={login.trim() === ''}>Add member</Button>
          <p className="w-full text-xs text-muted-foreground">A login is the verified e-mail address the person signs in to this hub with (or their sign-in id), not their display name.</p>
        </form>
      )}

      <h3 className="text-lg font-semibold">Repositories</h3>
      <ul className="divide-y divide-border rounded border border-border">
        {team.repositories.map((p) => (
          <li key={p} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm" title={p}>
              {nameOf(p)}
            </span>
            {editRepos && (
              <Button
                aria-label={`Remove repository ${nameOf(p)}`}
                onClick={() => confirmRemoveRepo(p) && edit(teamRemoveRepository(team.id, p))}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
        {team.repositories.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No repositories</li>}
      </ul>
      {editRepos && addable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Repository to add"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm"
          >
            <option value="">Choose a repository…</option>
            {addable.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
          <Button disabled={repo === ''} onClick={() => edit(teamAddRepository(team.id, repo), () => setRepo(''))}>
            Add repository
          </Button>
        </div>
      )}
    </section>
  );
}
