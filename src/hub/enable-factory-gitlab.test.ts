import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGitlabFactory,
  factoryHostOf,
  gitlabSecretCommand,
  gitlabVariableExists,
  gitlabFound,
  NO_DOCTOR_JOB,
  pipelineResult,
  planGitlabFactory,
  verifyGitlabFactory,
} from './enable-factory-gitlab.js';
import type { FactoryExec, FactoryPlan } from './enable-factory.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enable-gitlab-test-'));
  roots.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  return dir;
}

interface Call { file: string; args: string[] }
interface Opts {
  remote?: string; // `git remote` output
  origin?: string;
  project?: unknown;
  user?: unknown;
  show?: Record<string, string>; // file on origin/main -> content
  dirty?: string;
  openMr?: string;
  /** Result of the `glab api .../variables/<name>` GET: absent -> 404. */
  variable?: 'present' | 'absent' | 'forbidden';
  fail?: (call: Call) => Error | undefined;
  pipelines?: unknown[][];
  mrState?: string;
  jobs?: unknown[];
}
const SECRET_VALUE = 'must-not-be-kept';
const fail = (stderr: string, code?: string): Error => Object.assign(new Error(`Command failed: glab ... ${stderr}`), { stderr, code });

function fake(o: Opts = {}): { exec: FactoryExec; calls: Call[] } {
  const calls: Call[] = [];
  let created = false;
  let pipePage = 0;
  const exec: FactoryExec = async (file, args) => {
    const call = { file, args };
    calls.push(call);
    const err = o.fail?.(call);
    if (err) throw err;
    const out = (stdout: string): { stdout: string; stderr: string } => ({ stdout, stderr: '' });
    const a = args.join(' ');
    if (file === 'git') {
      if (a === 'remote') return out(o.remote ?? 'origin');
      if (a === 'remote get-url origin') return out(o.origin ?? 'git@gitlab.com:acme/app.git');
      if (args[0] === 'show') {
        const f = args[1]!.replace('origin/main:', '');
        if (o.show?.[f] === undefined) throw new Error('missing');
        return out(o.show[f]!);
      }
      if (a.startsWith('status --porcelain --untracked-files=no')) return out(o.dirty ?? '');
      if (a.startsWith('status --porcelain -- ')) return out('A  changed');
      if (a.startsWith('rev-parse --abbrev-ref')) return out('feature');
      return out('');
    }
    if (a === 'api user') return out(JSON.stringify(o.user ?? { username: 'tanuki' }));
    if (a.startsWith('api projects/acme%2Fapp?') || a === 'api projects/acme%2Fapp') {
      return out(JSON.stringify(o.project ?? { default_branch: 'main', permissions: { project_access: { access_level: 40 } } }));
    }
    if (a.includes('/merge_requests?')) return out(JSON.stringify(o.openMr !== undefined || created ? [{ web_url: o.openMr ?? 'https://gitlab.com/acme/app/-/merge_requests/7' }] : []));
    if (args[0] === 'mr' && args[1] === 'create') { created = true; return out('created'); }
    if (a.includes('/variables/')) {
      if (o.variable === 'absent') throw fail('404 Not Found');
      if (o.variable === 'forbidden') throw fail('403 Forbidden');
      // A server answers HEAD with headers only; only a GET carries the value.
      return out(args.includes('HEAD') ? '' : JSON.stringify({ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: SECRET_VALUE }));
    }
    if (a.includes('/merge_requests/')) return out(JSON.stringify({ state: o.mrState ?? 'opened' }));
    if (a.includes('/pipelines?')) return out(JSON.stringify((o.pipelines ?? [[]])[Math.min(pipePage++, (o.pipelines ?? [[]]).length - 1)]));
    if (a.includes('/jobs?')) return out(JSON.stringify(o.jobs ?? []));
    if (a.includes('/pipelines/')) return out(JSON.stringify({ status: 'success' }));
    return out('');
  };
  return { exec, calls };
}

const plan: FactoryPlan = {
  provider: 'gitlab', repoSlug: 'acme/app', defaultBranch: 'main', login: 'tanuki', packageManager: 'pnpm',
  scripts: { typecheck: false, lint: false, test: true, build: false },
  callerFiles: ['.gitlab-ci.yml', '.gitlab/taskcell.yml'], labels: [],
};

describe('planGitlabFactory', () => {
  it('reads the project through glab', async () => {
    const dir = await repo();
    const { exec, calls } = fake();
    const p = await planGitlabFactory(dir, { exec });
    expect(p).toMatchObject({ provider: 'gitlab', repoSlug: 'acme/app', defaultBranch: 'main', login: 'tanuki', existingCallerFiles: [] });
    expect(p.callerFiles).toEqual(['.gitlab-ci.yml', '.gitlab/taskcell.yml']);
    expect(calls.every((c) => c.file !== 'glab' || c.args[0] === 'api')).toBe(true);
  });
  it('reports what the base already has', async () => {
    const { exec } = fake({ show: { '.gitlab/taskcell.yml': 'x', '.gitlab-ci.yml': 'include:\n  - local: .gitlab/taskcell.yml\n' } });
    expect((await planGitlabFactory(await repo(), { exec })).existingCallerFiles).toEqual(['.gitlab/taskcell.yml', '.gitlab-ci.yml']);
  });
  it('refuses a project with no remote', async () => {
    await expect(planGitlabFactory(await repo(), { exec: fake({ remote: '' }).exec })).rejects.toThrow(/no git remote/);
  });
  it('refuses a GitHub remote', async () => {
    await expect(planGitlabFactory(await repo(), { exec: fake({ origin: 'git@github.com:a/b.git' }).exec })).rejects.toThrow(/not on GitLab/);
  });
  it('says plainly when glab is missing, signed out, or lacks permission', async () => {
    const dir = await repo();
    const missing = fake({ fail: (c) => (c.file === 'glab' ? fail('', 'ENOENT') : undefined) });
    await expect(planGitlabFactory(dir, { exec: missing.exec })).rejects.toThrow('glab is not installed; install the GitLab CLI and run `glab auth login`, then try again.');
    const out = fake({ fail: (c) => (c.file === 'glab' ? fail('401 Unauthorized') : undefined) });
    await expect(planGitlabFactory(dir, { exec: out.exec })).rejects.toThrow('glab is not signed in to GitLab; run `glab auth login`, then try again.');
    const forbidden = fake({ fail: (c) => (c.file === 'glab' ? fail('403 Forbidden') : undefined) });
    const err = await planGitlabFactory(dir, { exec: forbidden.exec }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/does not have permission/);
    expect((err as Error).message).not.toMatch(/Command failed/);
  });
  it('does not read ids in the command line as HTTP codes', async () => {
    const offline = fake({ fail: (c) => (c.file === 'glab' ? fail('dial tcp: lookup gitlab.com: no such host') : undefined) });
    const e = await planGitlabFactory(await repo(), { exec: offline.exec }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/did not accept the request/);
  });
  it('does not refuse a user whose access level the API leaves null (invited group, admin)', async () => {
    const { exec } = fake({ project: { default_branch: 'main', permissions: { project_access: null, group_access: null } } });
    await expect(planGitlabFactory(await repo(), { exec })).resolves.toMatchObject({ defaultBranch: 'main' });
  });
  it('ignores a comment or unrelated key that mentions the include path', async () => {
    const { exec } = fake({ show: { '.gitlab-ci.yml': '# .gitlab/taskcell.yml is not included yet\nnote: .gitlab/taskcell.yml\n' } });
    expect((await planGitlabFactory(await repo(), { exec })).existingCallerFiles).toEqual([]);
  });
});

describe('applyGitlabFactory', () => {
  it('pushes its own branch and opens an MR via glab; never pushes the default branch', async () => {
    const dir = await repo();
    const { exec, calls } = fake();
    const result = await applyGitlabFactory(dir, plan, { exec });
    expect(result.prUrl).toBe('https://gitlab.com/acme/app/-/merge_requests/7');
    const push = calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toEqual(['push', '--force', '-u', 'origin', 'vanguard/enable-factory']);
    const mr = calls.find((c) => c.file === 'glab' && c.args[0] === 'mr')!;
    expect(mr.args).toEqual(expect.arrayContaining(['--source-branch', 'vanguard/enable-factory', '--target-branch', 'main', '--yes']));
    expect(calls.some((c) => c.args[0] === 'push' && c.args.includes('main'))).toBe(false);
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8')).toBe('include:\n  - local: .gitlab/taskcell.yml\n');
    expect(await readFile(join(dir, '.gitlab/taskcell.yml'), 'utf8')).toContain('taskcell-doctor');
    expect(calls.at(-1)?.args[0]).not.toBe('push');
  });
  it('reuses an open MR', async () => {
    const { exec, calls } = fake({ openMr: 'https://gitlab.com/acme/app/-/merge_requests/3' });
    expect((await applyGitlabFactory(await repo(), plan, { exec })).prUrl).toMatch(/merge_requests\/3$/);
    expect(calls.some((c) => c.args[0] === 'mr')).toBe(false);
  });
  it('prepends the include, keeping the rest of .gitlab-ci.yml byte for byte', async () => {
    const dir = await repo();
    const ci = '\n\nstages: [a]\n';
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': ci } }).exec });
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8')).toBe('include:\n  - local: .gitlab/taskcell.yml\n\n' + ci);
  });
  it('adds an entry to an existing include list at the list indent', async () => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': 'include:\n  - local: a.yml\nstages: [a]\n' } }).exec });
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8')).toBe('include:\n  - local: .gitlab/taskcell.yml\n  - local: a.yml\nstages: [a]\n');
  });
  it('leaves an include it cannot edit alone and says so in the MR description', async () => {
    const dir = await repo();
    const { exec, calls } = fake({ show: { '.gitlab-ci.yml': 'include: x.yml\n' } });
    await applyGitlabFactory(dir, plan, { exec });
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8').catch(() => '')).toBe('');
    const mr = calls.find((c) => c.args[0] === 'mr')!;
    expect(mr.args[mr.args.indexOf('--description') + 1]).toMatch(/to it by hand before merging/);
  });
  it('finds an open MR on an http self-hosted host', async () => {
    const { exec } = fake({ openMr: 'http://git.internal/acme/app/-/merge_requests/3' });
    expect((await applyGitlabFactory(await repo(), plan, { exec })).prUrl).toBe('http://git.internal/acme/app/-/merge_requests/3');
  });
  it('refuses a dirty tree and a push that is denied', async () => {
    await expect(applyGitlabFactory(await repo(), plan, { exec: fake({ dirty: ' M a.ts' }).exec })).rejects.toThrow(/uncommitted changes/);
    const denied = fake({ fail: (c) => (c.args[0] === 'push' ? fail('remote: You are not allowed to push code') : undefined) });
    await expect(applyGitlabFactory(await repo(), plan, { exec: denied.exec })).rejects.toThrow(/does not have permission/);
  });
  it('refuses to write through a symlink the default branch commits at a factory path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'enable-gitlab-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'victim'), 'keep');
    const linkedDir = await repo();
    await symlink(outside, join(linkedDir, '.gitlab'));
    const linkedFile = await repo();
    await symlink(join(outside, 'victim'), join(linkedFile, '.gitlab-ci.yml'));
    const linkedInclude = await repo();
    await mkdir(join(linkedInclude, '.gitlab'));
    await symlink(join(outside, 'victim'), join(linkedInclude, '.gitlab/taskcell.yml'));
    for (const dir of [linkedDir, linkedFile, linkedInclude]) {
      const { exec, calls } = fake();
      await expect(applyGitlabFactory(dir, plan, { exec })).rejects.toThrow(/symlink/);
      expect(calls.some((c) => c.args[0] === 'push' || c.args[0] === 'commit')).toBe(false);
      expect(calls.at(-1)?.args).toEqual(['checkout', '-f', 'feature']);
    }
    expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('keep');
    expect(await readdir(outside)).toEqual(['victim']);
  });
  it('refuses to use the default branch as its branch', async () => {
    await expect(applyGitlabFactory(await repo(), { ...plan, defaultBranch: 'vanguard/enable-factory' }, { exec: fake().exec })).rejects.toThrow(/default branch/);
  });
  it('tolerates labels that already exist but not other label failures', async () => {
    const exists = fake({ fail: (c) => (c.args[0] === 'label' ? fail('Label already exists') : undefined) });
    await expect(applyGitlabFactory(await repo(), plan, { exec: exists.exec })).resolves.toBeDefined();
    const denied = fake({ fail: (c) => (c.args[0] === 'label' ? fail('403 Forbidden') : undefined) });
    await expect(applyGitlabFactory(await repo(), plan, { exec: denied.exec })).rejects.toThrow(/does not have permission/);
  });
});

describe('variable, merge and pipeline checks', () => {
  it('shows the command, with no value', () => {
    expect(gitlabSecretCommand(plan)).toEqual({ secretName: 'CLAUDE_CODE_OAUTH_TOKEN', command: "read -rsp 'Token: ' T && printf %s \"$T\" | glab variable set CLAUDE_CODE_OAUTH_TOKEN --masked --repo acme/app" });
  });
  it('detects the variable by one HEAD request for its name; no value reaches the hub process', async () => {
    const present = fake();
    const outputs: string[] = [];
    const recording: FactoryExec = async (file, args, opts) => {
      const r = await present.exec(file, args, opts);
      outputs.push(r.stdout, r.stderr);
      return r;
    };
    expect(await gitlabVariableExists('/x', plan, recording)).toBe(true);
    expect(present.calls[0]!.args).toEqual(['api', '--method', 'HEAD', 'projects/acme%2Fapp/variables/CLAUDE_CODE_OAUTH_TOKEN']);
    await gitlabFound('/x', { plan, secretSet: false, merged: false }, recording);
    expect(present.calls.filter((c) => c.args.some((a) => a.includes('/variables'))).every((c) => c.args.includes('HEAD'))).toBe(true);
    expect(outputs.join('')).not.toContain(SECRET_VALUE);
    expect(await gitlabVariableExists('/x', plan, fake({ variable: 'absent' }).exec)).toBe(false);
    await expect(gitlabVariableExists('/x', plan, fake({ variable: 'forbidden' }).exec)).rejects.toThrow(/permission/);
  });
  it('maps pipeline statuses onto the checklist statuses', () => {
    expect(pipelineResult('success')).toEqual({ status: 'completed', conclusion: 'success' });
    expect(pipelineResult('failed')).toEqual({ status: 'completed', conclusion: 'failure' });
    expect(pipelineResult('canceled')).toEqual({ status: 'completed', conclusion: 'cancelled' });
    expect(pipelineResult('running')).toEqual({ status: 'in_progress', conclusion: '' });
    expect(pipelineResult('pending')).toEqual({ status: 'queued', conclusion: '' });
  });
  it('follows the doctor job, not the whole pipeline', async () => {
    const rec = { plan, secretSet: true, merged: true, doctor: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'in_progress', conclusion: '' } };
    const found = await gitlabFound('/x', rec, fake({ jobs: [{ name: 'deploy', status: 'failed' }, { name: 'taskcell-doctor', status: 'success' }] }).exec);
    expect(found.doctor).toMatchObject({ status: 'completed', conclusion: 'success' });
  });
  it('never passes the doctor step without a taskcell-doctor job', async () => {
    const rec = { plan, secretSet: true, merged: true, doctor: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'in_progress', conclusion: '' } };
    // The pipeline succeeded, but only the project's own jobs ran in it.
    expect((await gitlabFound('/x', rec, fake({ jobs: [{ name: 'deploy', status: 'success' }] }).exec)).doctor).toMatchObject({ status: 'completed', conclusion: NO_DOCTOR_JOB });
    // The job list could not be read: not known yet, so not passed.
    const unreadable = fake({ jobs: [], fail: (c) => (c.args.some((a) => a.includes('/jobs?')) ? fail('500') : undefined) });
    expect((await gitlabFound('/x', rec, unreadable.exec)).doctor).toMatchObject({ status: 'in_progress', conclusion: '' });
  });
  it('picks up a doctor pipeline the verify poll missed', async () => {
    const rec = { plan, secretSet: true, merged: true, doctorDispatchedAt: new Date().toISOString() };
    const pipelines = [[{ id: 5, web_url: 'https://gitlab.com/acme/app/-/pipelines/5', status: 'running', created_at: new Date().toISOString() }]];
    expect((await gitlabFound('/x', rec, fake({ pipelines }).exec)).doctor).toMatchObject({ url: 'https://gitlab.com/acme/app/-/pipelines/5', status: 'in_progress' });
  });
  it('detects a merged and a closed MR, and the doctor pipeline result', async () => {
    const rec = { plan, secretSet: false, merged: false, prUrl: 'https://gitlab.com/acme/app/-/merge_requests/7', doctor: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'queued', conclusion: '' } };
    expect(await gitlabFound('/x', rec, fake({ mrState: 'merged', jobs: [{ name: 'taskcell-doctor', status: 'success' }] }).exec)).toMatchObject({ merged: true, prClosed: false, doctor: { status: 'completed', conclusion: 'success' } });
    expect(await gitlabFound('/x', rec, fake({ mrState: 'closed' }).exec)).toMatchObject({ prClosed: true });
  });
  it('starts the doctor pipeline and reports the new one', async () => {
    const created = { id: 9, web_url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'running', created_at: '' };
    const { exec, calls } = fake({ pipelines: [[{ ...created, id: 8, web_url: 'https://gitlab.com/acme/app/-/pipelines/8' }], [created, { ...created, id: 8 }]] });
    const r = await verifyGitlabFactory('/x', plan, { exec, sleep: async () => undefined });
    expect(r).toEqual({ dispatched: true, run: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'in_progress', conclusion: '' } });
    expect(calls.find((c) => c.args[0] === 'ci')!.args).toEqual(['ci', 'run', '--branch', 'main', '--variables', 'TASKCELL_DOCTOR:true']);
  });
});

describe('templates/gitlab/taskcell.yml', () => {
  it('runs commands the CLI accepts, only in pipelines started with a variable', async () => {
    const { parseCli } = await import('../cli/args.js');
    const yml = await readFile(new URL('../../templates/gitlab/taskcell.yml', import.meta.url), 'utf8');
    const lines = yml.split('\n').filter((l) => l.includes('/dist/cli/index.js '));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      const argv = l.split('/dist/cli/index.js ')[1]!.match(/"[^"]*"|\S+/g)!.map((t) => t.replace(/^"|"$/g, '').replace('$CI_PROJECT_PATH', 'acme/app'));
      expect(parseCli(argv, '/x').kind, l).not.toMatch(/error|help/);
    }
    expect(yml).not.toMatch(/\$CI_PIPELINE_SOURCE|merge_request_event|TASKCELL_REF: main/);
  });
});

describe('factoryHostOf', () => {
  it.each([
    ['', 'git@gitlab.com:a/b.git', 'none'],
    ['origin', 'git@gitlab.com:a/b.git', 'gitlab'],
    ['origin', 'https://github.com/a/b.git', 'github'],
    ['origin', 'https://git.example.org/a/b.git', 'other'],
  ])('remote %j origin %s -> %s', async (remote, origin, host) => {
    expect(await factoryHostOf('/x', { exec: fake({ remote, origin }).exec })).toBe(host);
  });
});
