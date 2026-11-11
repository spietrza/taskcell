import { describe, it, expect } from 'vitest';
import {
  parseDependsOnBody,
  parseStartDate,
  mergeDependsOn,
  describeRef,
  checkDependencies,
  hasDependencyComment,
  dependencyLogReason,
  dependencyWaitComment,
  DEPENDENCY_MARKER,
} from './dependencies.js';
import type { TaskRef, DependencyNode, DependencyCheck } from './dependencies.js';

describe('parseDependsOnBody', () => {
  it('parses a bare #N reference', () => {
    expect(parseDependsOnBody('Depends on #12')).toEqual([{ number: '12' }]);
  });

  it('parses an owner/repo#N reference', () => {
    expect(parseDependsOnBody('Depends on acme/widgets#34')).toEqual([{ repo: 'acme/widgets', number: '34' }]);
  });

  it('parses multiple comma-separated refs on one line', () => {
    expect(parseDependsOnBody('Depends on #12, acme/widgets#34')).toEqual([
      { number: '12' },
      { repo: 'acme/widgets', number: '34' },
    ]);
  });

  it('parses refs across multiple "Depends on" lines', () => {
    const body = 'Some description.\n\nDepends on #1\n\nMore text.\nDepends on #2\n';
    expect(parseDependsOnBody(body)).toEqual([{ number: '1' }, { number: '2' }]);
  });

  it('is case-insensitive and tolerates a colon', () => {
    expect(parseDependsOnBody('DEPENDS ON: #5')).toEqual([{ number: '5' }]);
  });

  it('dedupes repeated refs', () => {
    expect(parseDependsOnBody('Depends on #1\nDepends on #1')).toEqual([{ number: '1' }]);
  });

  it('returns [] when there is no "Depends on" line', () => {
    expect(parseDependsOnBody('Just a normal description, nothing blocking this.')).toEqual([]);
  });

  it('does not match a line that merely contains "depends" without "on"', () => {
    expect(parseDependsOnBody('This depends heavily on #1 being done')).toEqual([]);
  });
});

describe('parseStartDate', () => {
  it('parses a Start: YYYY-MM-DD line', () => {
    expect(parseStartDate('Start: 2026-12-01\n\nRest of the body.')).toBe('2026-12-01');
  });

  it('is case-insensitive and tolerates no colon', () => {
    expect(parseStartDate('start 2026-01-15')).toBe('2026-01-15');
  });

  it('returns undefined when absent', () => {
    expect(parseStartDate('No start date here.')).toBeUndefined();
  });
});

describe('mergeDependsOn', () => {
  it('dedupes across both lists, first occurrence winning', () => {
    const a: TaskRef[] = [{ number: '1' }, { repo: 'o/r', number: '2' }];
    const b: TaskRef[] = [{ number: '1' }, { number: '3' }];
    expect(mergeDependsOn(a, b)).toEqual([{ number: '1' }, { repo: 'o/r', number: '2' }, { number: '3' }]);
  });
});

describe('describeRef', () => {
  it('qualifies an unqualified ref with the fallback repo', () => {
    expect(describeRef({ number: '7' }, 'me/app')).toBe('me/app#7');
  });

  it('keeps an explicit repo', () => {
    expect(describeRef({ repo: 'other/lib', number: '7' }, 'me/app')).toBe('other/lib#7');
  });
});

describe('checkDependencies', () => {
  const SELF: TaskRef = { repo: 'me/app', number: '1' };

  function resolverFromGraph(graph: Record<string, DependencyNode>): (ref: TaskRef) => Promise<DependencyNode> {
    return async (ref) => {
      const key = describeRef(ref, 'me/app').toLowerCase();
      const node = graph[key];
      if (node === undefined) throw new Error(`no fixture node for ${key}`);
      return node;
    };
  }

  it('is ready when there are no dependencies', async () => {
    const check = await checkDependencies({}, SELF, 'me/app', resolverFromGraph({}));
    expect(check).toEqual({ status: 'ready' });
  });

  it('is ready when every direct dependency is met', async () => {
    const graph = { 'me/app#2': { met: true, dependsOn: [] } };
    const check = await checkDependencies({ dependsOn: [{ number: '2' }] }, SELF, 'me/app', resolverFromGraph(graph));
    expect(check).toEqual({ status: 'ready' });
  });

  it('waits on an unmet direct dependency, naming it', async () => {
    const graph = { 'me/app#2': { met: false, dependsOn: [] } };
    const check = await checkDependencies({ dependsOn: [{ number: '2' }] }, SELF, 'me/app', resolverFromGraph(graph));
    expect(check).toEqual({ status: 'waiting', kind: 'unmet', blockers: [{ number: '2' }] });
  });

  it('waits on a future start date regardless of (absent) dependencies', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const check = await checkDependencies({ startDate: '2026-06-01' }, SELF, 'me/app', resolverFromGraph({}), now);
    expect(check).toEqual({ status: 'waiting', kind: 'start-date', startDate: '2026-06-01' });
  });

  it('is ready once the start date has passed, with unmet dependencies still gating', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const graph = { 'me/app#2': { met: true, dependsOn: [] } };
    const check = await checkDependencies(
      { startDate: '2026-06-01', dependsOn: [{ number: '2' }] },
      SELF,
      'me/app',
      resolverFromGraph(graph),
      now,
    );
    expect(check).toEqual({ status: 'ready' });
  });

  it('reports needs_info with the reason when a dependency does not exist', async () => {
    const graph = { 'me/app#2': { met: false, missing: true, dependsOn: [] } };
    const check = await checkDependencies({ dependsOn: [{ number: '2' }] }, SELF, 'me/app', resolverFromGraph(graph));
    expect(check.status).toBe('needs_info');
    expect((check as { reason: string }).reason).toContain('me/app#2');
    expect((check as { reason: string }).reason).toContain('does not exist');
  });

  it('reports needs_info when a dependency resolves back to self (direct cycle)', async () => {
    const graph = { 'me/app#2': { met: false, dependsOn: [SELF] } };
    const check = await checkDependencies({ dependsOn: [{ number: '2' }] }, SELF, 'me/app', resolverFromGraph(graph));
    expect(check.status).toBe('needs_info');
    expect((check as { reason: string }).reason).toContain('cycle');
  });

  it('reports needs_info for a transitive cycle (A -> B -> C -> A)', async () => {
    const graph = {
      'me/app#2': { met: false, dependsOn: [{ number: '3' }] },
      'me/app#3': { met: false, dependsOn: [SELF] },
    };
    const check = await checkDependencies({ dependsOn: [{ number: '2' }] }, SELF, 'me/app', resolverFromGraph(graph));
    expect(check.status).toBe('needs_info');
  });

  it('resolves a diamond-shaped graph without re-resolving a shared node twice', async () => {
    let resolveCalls = 0;
    const graph = {
      'me/app#2': { met: true, dependsOn: [{ number: '4' }] },
      'me/app#3': { met: true, dependsOn: [{ number: '4' }] },
      'me/app#4': { met: true, dependsOn: [] },
    };
    const resolve = resolverFromGraph(graph);
    const counting = async (ref: TaskRef): Promise<DependencyNode> => {
      resolveCalls += 1;
      return resolve(ref);
    };
    const check = await checkDependencies(
      { dependsOn: [{ number: '2' }, { number: '3' }] },
      SELF,
      'me/app',
      counting,
    );
    expect(check).toEqual({ status: 'ready' });
    // #2, #3 and #4 each resolved exactly once, even though #4 is reachable through both #2 and #3.
    expect(resolveCalls).toBe(3);
  });

  it('does not treat a cross-repo dependency as same-repo', async () => {
    const graph = { 'other/lib#2': { met: false, dependsOn: [] } };
    const check = await checkDependencies({ dependsOn: [{ repo: 'other/lib', number: '2' }] }, SELF, 'me/app', resolverFromGraph(graph));
    expect(check).toEqual({ status: 'waiting', kind: 'unmet', blockers: [{ repo: 'other/lib', number: '2' }] });
  });
});

describe('hasDependencyComment', () => {
  it('is true only when a comment carries the marker', () => {
    expect(hasDependencyComment({ comments: [{ author: 'vanguard', body: `waiting ${DEPENDENCY_MARKER}` }] })).toBe(true);
    expect(hasDependencyComment({ comments: [{ author: 'alice', body: 'unrelated comment' }] })).toBe(false);
    expect(hasDependencyComment({ comments: [] })).toBe(false);
  });
});

describe('dependencyLogReason / dependencyWaitComment', () => {
  it('describe an unmet-dependency wait', () => {
    const check: DependencyCheck = { status: 'waiting', kind: 'unmet', blockers: [{ number: '5' }] };
    expect(dependencyLogReason(check, 'me/app')).toContain('me/app#5');
    const comment = dependencyWaitComment(check, 'me/app');
    expect(comment).toContain('me/app#5');
    expect(comment).toContain(DEPENDENCY_MARKER);
  });

  it('describe a start-date wait', () => {
    const check: DependencyCheck = { status: 'waiting', kind: 'start-date', startDate: '2026-06-01' };
    expect(dependencyLogReason(check, 'me/app')).toContain('2026-06-01');
    expect(dependencyWaitComment(check, 'me/app')).toContain('2026-06-01');
  });

  it('describe a needs_info reason', () => {
    const check: DependencyCheck = { status: 'needs_info', reason: 'a dependency cycle involving me/app#2' };
    expect(dependencyLogReason(check, 'me/app')).toContain('a dependency cycle involving me/app#2');
    expect(dependencyWaitComment(check, 'me/app')).toContain('a dependency cycle involving me/app#2');
  });
});
