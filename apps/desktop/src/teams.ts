/** Team selection for the hub's switcher; pure so it can be tested without rendering. */
import type { Project } from './taskcell-output';
import type { Team } from './wire';

const KEY = 'vanguard.team';

export function loadTeamId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveTeamId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
}

/** The remembered team when it still exists, else the first. */
export function resolveTeam(teams: Team[], savedId: string | null): Team | undefined {
  return teams.find((t) => t.id === savedId) ?? teams[0];
}

/** The projects of the selected team (no team loaded = every project). */
export function teamProjects(projects: Project[], team: Team | undefined): Project[] {
  return team === undefined ? projects : projects.filter((p) => team.repositories.includes(p.path));
}
