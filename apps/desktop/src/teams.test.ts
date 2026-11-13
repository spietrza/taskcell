import { beforeEach, expect, test } from 'vitest';
import { loadTeamId, resolveTeam, saveTeamId, teamProjects } from './teams';
import type { Project } from './taskcell-output';
import type { Team } from './wire';

const team = (id: string, repositories: string[] = []): Team => ({ id, name: id, members: [], repositories });
const project = (path: string): Project => ({ path, name: path, runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 });

beforeEach(() => localStorage.clear());

test('the remembered team is used when it still exists, else the first', () => {
  const teams = [team('a'), team('b')];
  expect(resolveTeam(teams, 'b')?.id).toBe('b');
  expect(resolveTeam(teams, 'gone')?.id).toBe('a');
  expect(resolveTeam(teams, null)?.id).toBe('a');
  expect(resolveTeam([], 'a')).toBeUndefined();
});

test('the selected team is remembered across reloads', () => {
  expect(loadTeamId()).toBeNull();
  saveTeamId('b');
  expect(loadTeamId()).toBe('b');
});

test('switching team changes which projects Home, Board and Runs list', () => {
  const all = [project('/a'), project('/b'), project('/c')];
  expect(teamProjects(all, team('one', ['/a'])).map((p) => p.path)).toEqual(['/a']);
  expect(teamProjects(all, team('two', ['/b', '/c'])).map((p) => p.path)).toEqual(['/b', '/c']);
  expect(teamProjects(all, undefined)).toHaveLength(3);
});
