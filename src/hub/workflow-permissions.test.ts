import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

type Perms = Record<string, string> | string | undefined;
interface Job { permissions?: Perms; uses?: string }
interface Workflow { permissions?: Perms; jobs: Record<string, Job> }

const ROOT = join(import.meta.dirname, '..', '..');
const DIRS = ['.github/workflows', 'templates/github'];
const files = DIRS.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.yml')).map((f) => join(d, f)));
const load = (path: string): Workflow => parse(readFileSync(join(ROOT, path), 'utf8')) as Workflow;
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const asMap = (p: Perms): Record<string, string> => (typeof p === 'object' && p !== null ? p : {});
/** A scope's level; `read-all`/`write-all` grant it to every scope. */
const levelOf = (p: Perms, scope: string): number => (typeof p === 'string' ? RANK[p.replace('-all', '')] ?? 0 : RANK[asMap(p)[scope] ?? 'none']!);
/** The reusable body a job calls, local (`./`) or the published `spietrza/taskcell/...@v1` one. */
const bodyOf = (uses: string): string | undefined => /^(?:\.\/|spietrza\/taskcell\/)(\.github\/workflows\/[\w.-]+\.yml)/.exec(uses)?.[1];

describe('workflow token permissions (OpenSSF Scorecard Token-Permissions, #1122)', () => {
  it.each(files)('%s grants nothing above read at the top level', (file) => {
    const top = load(file).permissions;
    expect(top, 'set a top-level permissions block ({} or read-only)').toBeDefined();
    expect(top, 'no write-all at the top level').not.toBe('write-all');
    expect(Object.entries(asMap(top)).filter(([, v]) => v === 'write')).toEqual([]);
  });

  it.each(files)('%s gives every called body at least what its jobs declare', (file) => {
    for (const [name, job] of Object.entries(load(file).jobs)) {
      const body = job.uses === undefined ? undefined : bodyOf(job.uses);
      // A caller template may name a published body this repo has not added yet (approver.yml: CI config a human adds).
      if (body === undefined || (body.endsWith('/approver.yml') && !existsSync(join(ROOT, body)))) continue;
      for (const [bodyJob, { permissions }] of Object.entries(load(body).jobs)) {
        expect(permissions !== null && typeof permissions === 'object', `${body} job ${bodyJob} must declare its permissions per scope`).toBe(true);
        for (const [scope, level] of Object.entries(asMap(permissions))) {
          expect(levelOf(job.permissions, scope), `${file} job ${name} must grant ${scope}: ${level} (${body})`).toBeGreaterThanOrEqual(RANK[level]!);
        }
      }
    }
  });
});
