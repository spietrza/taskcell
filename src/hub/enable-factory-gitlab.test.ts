import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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

interface Call { file: string; args: string[]; env?: NodeJS.ProcessEnv }
interface Opts {
  remote?: string; // `git remote` output
  origin?: string;
  project?: unknown;
  user?: unknown;
  show?: Record<string, string>; // file on origin/main -> content
  dirty?: string;
  openMr?: string;
  /** Rows of the open-MR listing before the hub creates its own. */
  mrRows?: unknown[];
  /** stdout of `glab ci run`. */
  ciOut?: string;
  pipelineStatus?: string;
  /** Result of the `glab api .../variables/<name>` GET: absent -> 404. */
  variable?: 'present' | 'absent' | 'forbidden';
  fail?: (call: Call) => Error | undefined;
  mrState?: string;
  jobs?: unknown[];
}
const SECRET_VALUE = 'must-not-be-kept';
const fail = (stderr: string, code?: string): Error => Object.assign(new Error(`Command failed: glab ... ${stderr}`), { stderr, code });

function fake(o: Opts = {}): { exec: FactoryExec; calls: Call[] } {
  const calls: Call[] = [];
  let created = false;
  const exec: FactoryExec = async (file, args, options) => {
    const call: Call = { file, args, ...(options?.env ? { env: options.env } : {}) };
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
      return out(JSON.stringify(o.project ?? { id: 42, default_branch: 'main', permissions: { project_access: { access_level: 40 } } }));
    }
    if (a.includes('/merge_requests?')) {
      const own = o.openMr !== undefined || created ? [{ source_project_id: 42, web_url: o.openMr ?? 'https://gitlab.com/acme/app/-/merge_requests/7' }] : [];
      return out(JSON.stringify([...(o.mrRows ?? []), ...own]));
    }
    if (args[0] === 'mr' && args[1] === 'create') { created = true; return out('created'); }
    if (a.includes('/variables/')) {
      if (o.variable === 'absent') throw fail('404 Not Found');
      if (o.variable === 'forbidden') throw fail('403 Forbidden');
      // A server answers HEAD with headers only; only a GET carries the value.
      return out(args.includes('HEAD') ? '' : JSON.stringify({ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: SECRET_VALUE }));
    }
    if (a.includes('/merge_requests/')) return out(JSON.stringify({ state: o.mrState ?? 'opened' }));
    if (args[0] === 'ci' && args[1] === 'run') return out(o.ciOut ?? 'Created pipeline (id: 9), status: created, ref: main, weburl: https://gitlab.com/acme/app/-/pipelines/9');
    if (a.includes('/jobs?')) {
      const page = Number(/[?&]page=(\d+)/.exec(a)?.[1] ?? '1');
      return out(JSON.stringify((o.jobs ?? []).slice((page - 1) * 100, page * 100)));
    }
    if (a.includes('/pipelines/')) return out(JSON.stringify({ status: o.pipelineStatus ?? 'success' }));
    return out('');
  };
  return { exec, calls };
}

const plan: FactoryPlan = {
  provider: 'gitlab', repoSlug: 'acme/app', defaultBranch: 'main', login: 'tanuki', packageManager: 'pnpm',
  scripts: { typecheck: false, lint: false, test: true, build: false },
  callerFiles: ['.gitlab-ci.yml', '.gitlab/taskcell.yml'], labels: [],
  gitlabHost: 'gitlab.com', gitlabProjectId: 42, gitlabCiPath: '.gitlab-ci.yml',
};

describe('planGitlabFactory', () => {
  it('reads the project through glab', async () => {
    const dir = await repo();
    const { exec, calls } = fake();
    const p = await planGitlabFactory(dir, { exec });
    expect(p).toMatchObject({ provider: 'gitlab', repoSlug: 'acme/app', defaultBranch: 'main', login: 'tanuki', existingCallerFiles: [], gitlabHost: 'gitlab.com', gitlabProjectId: 42, gitlabCiPath: '.gitlab-ci.yml' });
    expect(p.gitlabManualInclude).toBeUndefined();
    expect(p.gitlabUnruledJobs).toBeUndefined();
    // Every glab call names the host of `origin`, whatever GITLAB_HOST the hub was started with.
    expect(calls.filter((c) => c.file === 'glab').every((c) => c.env?.GITLAB_HOST === 'gitlab.com')).toBe(true);
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
    const { exec } = fake({ project: { id: 42, default_branch: 'main', permissions: { project_access: null, group_access: null } } });
    await expect(planGitlabFactory(await repo(), { exec })).resolves.toMatchObject({ defaultBranch: 'main' });
  });
  it.each([
    ['a comment or unrelated key', '# .gitlab/taskcell.yml is not included yet\nnote: .gitlab/taskcell.yml\n'],
    ['a job field with the same list entry', 'build:\n  script: make\n  rules:\n    - changes:\n        - .gitlab/taskcell.yml\n  artifacts:\n    paths:\n      - .gitlab/taskcell.yml\n'],
    ['an include in the spec header document', 'include:\n  - local: .gitlab/taskcell.yml\n---\nstages: [a]\n'],
  ])('does not take %s for the include', async (_name, ci) => {
    const { exec } = fake({ show: { '.gitlab-ci.yml': ci } });
    expect((await planGitlabFactory(await repo(), { exec })).existingCallerFiles).toEqual([]);
  });
  it.each([
    ['an entry with a trailing comment', 'include:\n  - local: .gitlab/taskcell.yml # factory\n'],
    ['a quoted entry with a leading slash', 'include:\n  - local: "/.gitlab/taskcell.yml"\n'],
    ['a bare string entry', 'include:\n  - .gitlab/taskcell.yml\n'],
    ['a single value', 'include: .gitlab/taskcell.yml\n'],
    ['a single mapping', 'include:\n  local: .gitlab/taskcell.yml\n'],
    ['an inline list', "include: [{ local: '.gitlab/taskcell.yml' }]\n"],
  ])('sees the include written as %s', async (_name, ci) => {
    const { exec } = fake({ show: { '.gitlab-ci.yml': ci } });
    expect((await planGitlabFactory(await repo(), { exec })).existingCallerFiles).toEqual(['.gitlab-ci.yml']);
  });
  it('names the CI file it will not edit: a custom ci_config_path, Auto DevOps without a file, YAML it cannot parse', async () => {
    const project = { id: 42, default_branch: 'main' };
    const custom = await planGitlabFactory(await repo(), { exec: fake({ project: { ...project, ci_config_path: 'ci/pipeline.yml' }, show: { 'ci/pipeline.yml': 'stages: [a]\n' } }).exec });
    expect(custom).toMatchObject({ gitlabCiPath: 'ci/pipeline.yml', gitlabManualInclude: true, callerFiles: ['ci/pipeline.yml', '.gitlab/taskcell.yml'] });
    const wiredCustom = await planGitlabFactory(await repo(), { exec: fake({ project: { ...project, ci_config_path: 'ci/pipeline.yml' }, show: { 'ci/pipeline.yml': 'include: .gitlab/taskcell.yml\n' } }).exec });
    expect(wiredCustom.gitlabManualInclude).toBeUndefined();
    expect(wiredCustom.existingCallerFiles).toEqual(['ci/pipeline.yml']);
    const autoDevops = await planGitlabFactory(await repo(), { exec: fake({ project: { ...project, auto_devops_enabled: true } }).exec });
    expect(autoDevops.gitlabManualInclude).toBe(true);
    const broken = await planGitlabFactory(await repo(), { exec: fake({ show: { '.gitlab-ci.yml': 'include:\nstages: [a\n' } }).exec });
    expect(broken.gitlabManualInclude).toBe(true);
    for (const path of ['/etc/passwd', '../x.yml', '.gitlab/taskcell.yml']) {
      await expect(planGitlabFactory(await repo(), { exec: fake({ project: { ...project, ci_config_path: path } }).exec })).rejects.toThrow(/unsupported custom CI configuration path/);
    }
  });
  it('lists the project\'s own jobs without rules, which a doctor pipeline would run too', async () => {
    const ci = 'stages: [a]\nvariables:\n  A: b\n.hidden:\n  script: x\ndeploy:\n  script: ship\ntest:\n  script: t\n  rules:\n    - if: $CI_COMMIT_TAG\n';
    expect((await planGitlabFactory(await repo(), { exec: fake({ show: { '.gitlab-ci.yml': ci } }).exec })).gitlabUnruledJobs).toEqual(['deploy']);
  });
  it('reads an HTTP status only where glab prints one, not from ids in a URL', async () => {
    const sentence = async (stderr: string): Promise<string> =>
      ((await planGitlabFactory(await repo(), { exec: fake({ fail: (c) => (c.file === 'glab' ? fail(stderr) : undefined) }).exec }).catch((e: Error) => e)) as Error).message;
    expect(await sentence('GET https://gitlab.com/api/v4/projects/403/merge_requests/404: 500 {message: boom}')).toMatch(/did not accept the request/);
    expect(await sentence('glab: HTTP 403')).toMatch(/does not have permission/);
    expect(await sentence('GET https://gitlab.com/api/v4/projects/401: 404 {message: 404 Project Not Found}')).toMatch(/could not find the project/);
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
    // Labels and the MR name the plan's project and host, so another remote in the checkout cannot receive them.
    const projectCalls = calls.filter((c) => c.file === 'glab' && c.args[0] !== 'api');
    expect(projectCalls.length).toBeGreaterThan(1);
    for (const c of projectCalls) {
      expect(c.args.slice(-2), c.args.join(' ')).toEqual(['--repo', 'acme/app']);
      expect(c.env?.GITLAB_HOST).toBe('gitlab.com');
    }
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
  it('puts the include before the first key, keeping the rest of .gitlab-ci.yml byte for byte', async () => {
    const dir = await repo();
    const ci = '\n\nstages: [a]\n';
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': ci } }).exec });
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8')).toBe('\n\ninclude:\n  - local: .gitlab/taskcell.yml\n\nstages: [a]\n');
  });
  it('adds an entry to an existing include list at the list indent', async () => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': 'include:\n  - local: a.yml\nstages: [a]\n' } }).exec });
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8')).toBe('include:\n  - local: .gitlab/taskcell.yml\n  - local: a.yml\nstages: [a]\n');
  });
  it.each([
    ['a single value', 'include: x.yml # ours\nstages: [a]\n', 'include:\n  - x.yml\n  - local: .gitlab/taskcell.yml # ours\nstages: [a]\n'],
    ['a single mapping', 'include:\n  local: x.yml\n', 'include:\n  - local: x.yml\n  - local: .gitlab/taskcell.yml\n'],
    ['an inline list', 'include: [x.yml]\n', 'include: [ x.yml, { local: .gitlab/taskcell.yml } ]\n'],
    ['a list after a comment line', 'include:\n  # ours\n  - local: a.yml\n', 'include:\n  # ours\n  - local: .gitlab/taskcell.yml\n  - local: a.yml\n'],
    ['a pipeline behind a spec header', 'spec:\n  inputs:\n    env:\n---\nstages: [a]\n', 'spec:\n  inputs:\n    env:\n---\ninclude:\n  - local: .gitlab/taskcell.yml\n\nstages: [a]\n'],
  ])('adds the include to %s', async (_name, ci, want) => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': ci } }).exec });
    expect(await readFile(join(dir, '.gitlab-ci.yml'), 'utf8')).toBe(want);
  });
  it('does not add a second entry to an include that has a trailing comment', async () => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': 'include:\n  - local: .gitlab/taskcell.yml # factory\n' } }).exec });
    expect(existsSync(join(dir, '.gitlab-ci.yml'))).toBe(false);
  });
  it('leaves a CI file it cannot edit alone and gives the exact line in the MR description', async () => {
    const dir = await repo();
    const { exec, calls } = fake({ show: { 'ci/pipeline.yml': 'stages: [a]\n' } });
    await applyGitlabFactory(dir, { ...plan, gitlabCiPath: 'ci/pipeline.yml', gitlabManualInclude: true }, { exec });
    expect(existsSync(join(dir, '.gitlab-ci.yml'))).toBe(false);
    expect(existsSync(join(dir, 'ci/pipeline.yml'))).toBe(false);
    const mr = calls.find((c) => c.args[0] === 'mr')!;
    expect(mr.args[mr.args.indexOf('--description') + 1]).toContain('cannot edit `ci/pipeline.yml` automatically: add `- local: .gitlab/taskcell.yml` under its top-level `include:` by hand before merging');
  });
  it('says which line to add when the jobs file is merged but the CI file cannot be edited', async () => {
    const { exec } = fake({ show: { '.gitlab/taskcell.yml': 'x', '.gitlab-ci.yml': 'include:\nstages: [a\n' } });
    const err = await applyGitlabFactory(await repo(), { ...plan, gitlabManualInclude: true }, { exec }).catch((e: Error) => e);
    expect((err as Error).message).toContain('add `- local: .gitlab/taskcell.yml` under its top-level `include:`');
    expect((err as Error).message).not.toMatch(/nothing to open/);
  });
  it('does not take a fork\'s MR from a branch of the same name for its own', async () => {
    const forkMr = { source_project_id: 99, web_url: 'https://gitlab.com/acme/app/-/merge_requests/66' };
    const { exec, calls } = fake({ mrRows: [forkMr] });
    expect((await applyGitlabFactory(await repo(), plan, { exec })).prUrl).toBe('https://gitlab.com/acme/app/-/merge_requests/7');
    expect(calls.some((c) => c.args[0] === 'mr' && c.args[1] === 'create')).toBe(true);
  });
  it('keeps raw git output out of the error', async () => {
    const broken = fake({ fail: (c) => (c.file === 'git' && c.args[0] === 'add' ? fail('fatal: Unable to create /Users/me/app/.git/index.lock') : undefined) });
    const err = await applyGitlabFactory(await repo(), plan, { exec: broken.exec }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/fatal|index\.lock|Command failed/);
    expect((err as Error).message).toMatch(/git could not prepare the branch/);
  });
  it('does not read argv for the label "already exists" check', async () => {
    const mistaken = { ...plan, repoSlug: 'team/mistaken' };
    const denied = fake({ fail: (c) => (c.file === 'glab' && c.args[0] === 'label' ? Object.assign(new Error('glab label create --repo team/mistaken'), { stderr: 'HTTP 403 Forbidden' }) : undefined) });
    await expect(applyGitlabFactory(await repo(), mistaken, { exec: denied.exec })).rejects.toThrow(/does not have permission/);
  });
  it('writes a stage the project has when its stages lack test', async () => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': 'stages: [build, deploy]\n' } }).exec });
    expect(await readFile(join(dir, '.gitlab/taskcell.yml'), 'utf8')).toMatch(/\.taskcell-base:\n(?:.*\n)*?  stage: build\n(?:.*\n)*?  inherit:\n    default: false\n    variables: false/);
  });
  it('turns an empty include: into a one-entry list', async () => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': 'include:\nstages: [a]\n' } }).exec });
    const out = await readFile(join(dir, '.gitlab-ci.yml'), 'utf8');
    expect(out).toMatch(/- local: \.gitlab\/taskcell\.yml/);
    expect(out).not.toMatch(/-\s*\n/);
  });
  it('falls back to the manual include for an indented root map', async () => {
    const p = await planGitlabFactory(await repo(), { exec: fake({ show: { '.gitlab-ci.yml': '  stages: [a]\n  job:\n    script: x\n' } }).exec });
    expect(p.gitlabManualInclude).toBe(true);
  });
  it('still lists only:/except: jobs: they run in the doctor pipeline', async () => {
    const ci = 'a:\n  only: [main]\n  script: x\nb:\n  script: y\nc:\n  rules:\n    - if: $X\n  script: z\n';
    expect((await planGitlabFactory(await repo(), { exec: fake({ show: { '.gitlab-ci.yml': ci } }).exec })).gitlabUnruledJobs).toEqual(['a', 'b']);
  });
  it('fetches the default branch with a timeout before reading the plan', async () => {
    const { exec, calls } = fake();
    await planGitlabFactory(await repo(), { exec });
    expect(calls.some((c) => c.file === 'git' && c.args.join(' ') === 'fetch origin main')).toBe(true);
  });
  it('keeps the first declared stage when test is missing, and test when present', async () => {
    const dir = await repo();
    await applyGitlabFactory(dir, plan, { exec: fake({ show: { '.gitlab-ci.yml': 'stages: [build, test]\n' } }).exec });
    expect(await readFile(join(dir, '.gitlab/taskcell.yml'), 'utf8')).toMatch(/\n {2}stage: test\n/);
  });
  it('reports a missing git binary as git, not glab', async () => {
    const broken = fake({ fail: (c) => (c.file === 'git' && c.args[0] === 'add' ? Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) : undefined) });
    await expect(applyGitlabFactory(await repo(), plan, { exec: broken.exec })).rejects.toThrow(/git is not installed/);
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
  it('shows a command for bash and zsh that sets or updates a masked, protected variable on the plan\'s project; no value', async () => {
    const one = (verb: string): string => `printf %s "$T" | GITLAB_HOST=gitlab.com glab variable ${verb} CLAUDE_CODE_OAUTH_TOKEN --masked --protected --repo acme/app`;
    const { secretName, command } = gitlabSecretCommand(plan);
    expect(secretName).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(command).toBe(`printf 'Token: '; IFS= read -rs T; echo; ${one('set')} 2>/dev/null || ${one('update')}; unset T`);
    expect(command).not.toMatch(/read -[a-z]*p/); // `read -p` is a coprocess read in zsh
    expect(gitlabSecretCommand({ ...plan, gitlabHost: 'git.example.org' }).command).toContain('GITLAB_HOST=git.example.org glab variable update');
    for (const shell of ['/bin/zsh', '/bin/bash'].filter((sh) => existsSync(sh))) {
      await expect(promisify(execFile)(shell, ['-n', '-c', command]), shell).resolves.toBeDefined();
    }
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
  it('finds the doctor job beyond the first page of jobs', async () => {
    const rec = { plan, secretSet: true, merged: true, doctor: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'in_progress', conclusion: '' } };
    const jobs = [...Array.from({ length: 230 }, (_, i) => ({ name: `job-${i}`, status: 'success' })), { name: 'taskcell-doctor', status: 'failed' }];
    const { exec, calls } = fake({ jobs });
    expect((await gitlabFound('/x', rec, exec)).doctor).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(calls.filter((c) => c.args.some((a) => a.includes('/jobs?'))).map((c) => /&page=(\d+)/.exec(c.args[1]!)?.[1])).toEqual(['1', '2', '3']);
  });
  it('does not adopt some other pipeline when the dispatched one was never recorded', async () => {
    const { exec, calls } = fake();
    expect(await gitlabFound('/x', { plan, secretSet: true, merged: true, doctorDispatchedAt: new Date().toISOString() }, exec)).toEqual({});
    expect(calls).toEqual([]);
  });
  it('detects a merged and a closed MR, and the doctor pipeline result', async () => {
    const rec = { plan, secretSet: false, merged: false, prUrl: 'https://gitlab.com/acme/app/-/merge_requests/7', doctor: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'queued', conclusion: '' } };
    expect(await gitlabFound('/x', rec, fake({ mrState: 'merged', jobs: [{ name: 'taskcell-doctor', status: 'success' }] }).exec)).toMatchObject({ merged: true, prClosed: false, doctor: { status: 'completed', conclusion: 'success' } });
    expect(await gitlabFound('/x', rec, fake({ mrState: 'closed' }).exec)).toMatchObject({ prClosed: true });
  });
  it('starts the doctor pipeline on the plan\'s project and follows the pipeline that start returned', async () => {
    const { exec, calls } = fake({ pipelineStatus: 'running' });
    const r = await verifyGitlabFactory('/x', plan, { exec, sleep: async () => undefined });
    expect(r).toEqual({ dispatched: true, run: { url: 'https://gitlab.com/acme/app/-/pipelines/9', status: 'in_progress', conclusion: '' } });
    const run = calls.find((c) => c.args[0] === 'ci')!;
    expect(run.args).toEqual(['ci', 'run', '--branch', 'main', '--variables', 'TASKCELL_DOCTOR:true', '--repo', 'acme/app']);
    expect(run.env?.GITLAB_HOST).toBe('gitlab.com');
    const after = calls.slice(calls.indexOf(run) + 1).map((c) => c.args[1]!);
    expect(after.length).toBeGreaterThan(0);
    // Only pipeline 9 is read: no listing of "the newest pipeline".
    expect(after.every((a) => a.startsWith('projects/acme%2Fapp/pipelines/9'))).toBe(true);
  });
  it('reads the id from glab\'s older output and builds the link when none is printed; refuses without an id', async () => {
    const old = fake({ ciOut: 'Created pipeline (id: 12 ), status: created , ref: main , weburl:  http://git.internal/acme/app/-/pipelines/12 )' });
    expect((await verifyGitlabFactory('/x', plan, { exec: old.exec, sleep: async () => undefined })).run?.url).toBe('http://git.internal/acme/app/-/pipelines/12');
    const bare = fake({ ciOut: 'Created pipeline (id: 12)' });
    expect((await verifyGitlabFactory('/x', { ...plan, gitlabHost: 'git.example.org' }, { exec: bare.exec, sleep: async () => undefined })).run?.url).toBe('https://git.example.org/acme/app/-/pipelines/12');
    await expect(verifyGitlabFactory('/x', plan, { exec: fake({ ciOut: 'ok' }).exec, sleep: async () => undefined })).rejects.toThrow(/did not report its id/);
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
    const doc = parse(yml) as Record<string, { variables?: Record<string, string>; before_script?: string[]; rules?: Array<{ if: string }> }>;
    // Nothing global: a top-level key other than a job would reach the including project's own jobs.
    expect(Object.keys(doc)).toEqual(['.taskcell-base', 'taskcell-doctor', 'taskcell-implement', 'taskcell-review']);
    const base = doc['.taskcell-base']!;
    expect(base.variables).toMatchObject({ GITLAB_HOST: '$CI_SERVER_HOST', TASKCELL_REF: 'v1' });
    const setup = base.before_script!.join('\n');
    expect(setup).toContain('pnpm@${PNPM_VERSION}');
    expect(setup).toContain('sha256sum -c -');
    expect(setup).toMatch(/amd64\) glab_sha=[0-9a-f]{64} ;;\n\s+arm64\) glab_sha=[0-9a-f]{64} ;;/);
    // The credentials leave the environment before anything is downloaded or built.
    expect(base.before_script![0]).toContain('unset CLAUDE_CODE_OAUTH_TOKEN GITLAB_TOKEN');
    for (const job of ['taskcell-doctor', 'taskcell-implement', 'taskcell-review']) {
      expect(doc[job]!.rules!.every((r) => r.if.includes('$GITLAB_USER_LOGIN == "YOUR_GITLAB_LOGIN"') && /\$TASKCELL_(DOCTOR|SWEEP) == "true"/.test(r.if)), job).toBe(true);
    }
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
