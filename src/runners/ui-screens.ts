import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { pushAuthEnv, resolveToken } from '../pipeline/remote-branch.js';
import { hostGitArgs, hostGitEnv } from '../worktree/host-git.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

/**
 * Before/after screenshots of the screens a factory PR changes, for the PR body's "Screens" section.
 * Rendered on demo data only (the dev server with `?demo=1`, never a hub), so no token, repo name or
 * user data lands in an image. Best effort: a failed capture never fails the run; the section says
 * screenshots are unavailable and why.
 */

/** Paths whose change is a UI change. */
const UI_PATH_RE = /^(apps\/desktop\/src\/|landing\/hub\/|apps\/mobile\/)/;
/** Feature folder under `apps/desktop/src/features/` -> the screen that renders it. */
const FEATURE_SCREEN: Record<string, string> = {
  home: 'home', 'needs-you': 'home', onboarding: 'home', dashboard: 'home',
  board: 'board', task: 'board', line: 'board', inspector: 'board', skills: 'board',
  fleet: 'runs', audit: 'runs',
  settings: 'settings', lessons: 'settings', workflow: 'settings',
};
/** Desktop minimum, and a wide width. */
export const SCREEN_VIEWPORTS: readonly { width: number; height: number }[] = [{ width: 1000, height: 600 }, { width: 1600, height: 900 }];

export interface ScreenTarget {
  screen: string;
}

/** The screens to capture: those whose feature folder changed; Home when only shared UI (or another app) changed. */
export function screensForFiles(files: readonly string[]): ScreenTarget[] {
  const ui = files.filter((f) => UI_PATH_RE.test(f));
  if (ui.length === 0) return [];
  const screens = new Set<string>();
  for (const f of ui) {
    const m = /^apps\/desktop\/src\/features\/([^/]+)\//.exec(f);
    const screen = m !== null ? FEATURE_SCREEN[m[1]!] : undefined;
    if (screen !== undefined) screens.add(screen);
  }
  if (screens.size === 0) screens.add('home');
  return [...screens].sort().map((screen) => ({ screen }));
}

/**
 * The only address a capture may open: the local dev server, in demo mode. Throws for anything else
 * (a real hub's address, another host, a demo-less URL), so the capture can never point at a hub.
 */
export function demoCaptureUrl(base: string, screen: string): string {
  const url = new URL(base);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'http:' || !local || url.username !== '' || url.hash !== '') {
    throw new Error(`refusing to capture a non-demo address: ${url.origin}`);
  }
  url.searchParams.set('demo', '1');
  if (screen === 'home') url.searchParams.delete('screen');
  else url.searchParams.set('screen', screen);
  return url.toString();
}

export interface CapturedImage {
  /** `before` or `after`. */
  side: 'before' | 'after';
  screen: string;
  width: number;
  /** The PNG on the host. */
  path: string;
}

export interface ScreensDeps {
  /** Render `screens` of the checkout at `dir` on demo data. */
  capture: (dir: string, screens: ScreenTarget[]) => Promise<CapturedImage[]>;
  /** Check out the base ref into a scratch directory; `cleanup` removes it. */
  baseCheckout: () => Promise<{ dir: string; cleanup: () => Promise<void> }>;
  /** Put the images where the PR body can link them; returns a URL per `side-screen-width` name. */
  host: (images: CapturedImage[]) => Promise<Record<string, string>>;
  headDir: string;
}

export const imageName = (i: Pick<CapturedImage, 'side' | 'screen' | 'width'>): string => `${i.side}-${i.screen}-${i.width}.png`;

/** The "Screens" section for `files`; undefined when the change touches no UI. Never throws. */
export async function screensSection(files: readonly string[], deps: ScreensDeps): Promise<string | undefined> {
  const screens = screensForFiles(files);
  if (screens.length === 0) return undefined;
  try {
    const base = await deps.baseCheckout();
    let before: CapturedImage[];
    try {
      before = await deps.capture(base.dir, screens);
    } finally {
      await base.cleanup().catch(() => undefined);
    }
    const after = await deps.capture(deps.headDir, screens);
    const urls = await deps.host([...before.map((i) => ({ ...i, side: 'before' as const })), ...after.map((i) => ({ ...i, side: 'after' as const }))]);
    const rows = screens.flatMap(({ screen }) =>
      SCREEN_VIEWPORTS.map(({ width }) => {
        const img = (side: 'before' | 'after'): string => {
          const url = urls[imageName({ side, screen, width })];
          return url !== undefined ? `![${side} ${screen} ${width}px](${url})` : '_not captured_';
        };
        return `| ${screen} ${width}px | ${img('before')} | ${img('after')} |`;
      }));
    return ['## Screens', '', 'Demo data only. Before = base branch, after = this PR.', '', '| Screen | Before | After |', '| --- | --- | --- |', ...rows].join('\n');
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
    return `## Screens\n\nScreenshots unavailable: ${why}`;
  }
}

// --- default wiring -----------------------------------------------------------------------------
// The agent's tree (vite config, plugins, app code, scripts) is untrusted: it is never run on the host.
// The dev server and Playwright run inside the run's sandbox (no token, no host env); only the PNGs
// come back out. The base is checked out on the host as plain files (git does not execute them) and
// copied in.

export const SANDBOX_WORKDIR = '/workspace';
const SANDBOX_BASE = '/tmp/taskcell-base';
const SANDBOX_SHOTS = '/tmp/taskcell-shots';
const DEV_PORT = 1420;

/** Run in the sandbox (node ESM on stdin): wait for the dev server, then screenshot each URL at each size. */
const CAPTURE_SCRIPT = `
import { chromium } from '@playwright/test';
const [out, urlsJson, sizesJson] = process.argv.slice(2);
const urls = JSON.parse(urlsJson);
const sizes = JSON.parse(sizesJson);
const deadline = Date.now() + 90000;
for (;;) {
  try { if ((await fetch(urls[0])).ok) break; } catch {}
  if (Date.now() > deadline) throw new Error('the dev server never came up');
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch();
try {
  for (const u of urls) {
    const screen = new URL(u).searchParams.get('screen') ?? 'home';
    for (const size of sizes) {
      const [width, height] = size.split('x').map(Number);
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(u, { waitUntil: 'networkidle' });
      await page.screenshot({ path: out + '/' + screen + '-' + width + '.png' });
      await page.close();
    }
  }
} finally { await browser.close(); }
`;

const q = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

/** Capture `screens` of the checkout at sandbox path `dir`, inside the sandbox; PNGs are copied out to a host temp dir. */
export function sandboxCapture(sandbox: IsolatedSandboxProvider): ScreensDeps['capture'] {
  return async (dir, screens) => {
    const base = `http://127.0.0.1:${DEV_PORT}/`;
    const urls = screens.map((s) => demoCaptureUrl(base, s.screen));
    const sizes = SCREEN_VIEWPORTS.map((v) => `${v.width}x${v.height}`);
    const desktop = `${dir}/apps/desktop`;
    const script = [
      `rm -rf ${SANDBOX_SHOTS} && mkdir -p ${SANDBOX_SHOTS}`,
      `cd ${q(desktop)}`,
      `(pnpm exec vite --host 127.0.0.1 --port ${DEV_PORT} --strictPort >/tmp/vite.log 2>&1 & echo $! >/tmp/vite.pid)`,
      `node --input-type=module - ${SANDBOX_SHOTS} ${q(JSON.stringify(urls))} ${q(JSON.stringify(sizes))}`,
      'rc=$?',
      'kill "$(cat /tmp/vite.pid)" 2>/dev/null',
      '[ $rc -eq 0 ] || tail -n 5 /tmp/vite.log >&2',
      'exit $rc',
    ].join('\n');
    const res = await sandbox.exec(script, { input: CAPTURE_SCRIPT, timeoutMs: 240_000 });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim().split('\n').slice(-1)[0] || `capture exited ${res.exitCode}`);
    const out = await mkdtemp(join(tmpdir(), 'taskcell-shots-'));
    await sandbox.copyFileOut(SANDBOX_SHOTS, out);
    return screens.flatMap((sc) => SCREEN_VIEWPORTS.map(({ width }) => ({ side: 'after' as const, screen: sc.screen, width, path: join(out, `${sc.screen}-${width}.png`) })));
  };
}

/** The base ref as plain files (host git worktree), copied into the sandbox with the head's dependencies linked in. */
export function sandboxBaseCheckout(sandbox: IsolatedSandboxProvider, repoDir: string, ref: string, workdir: string): ScreensDeps['baseCheckout'] {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskcell-base-'));
    await execa('git', ['worktree', 'add', '--detach', dir, ref], { cwd: repoDir });
    const cleanup = async (): Promise<void> => {
      await sandbox.exec(`rm -rf ${SANDBOX_BASE}`).catch(() => undefined);
      await execa('git', ['worktree', 'remove', '--force', dir], { cwd: repoDir }).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    };
    try {
      await sandbox.exec(`rm -rf ${SANDBOX_BASE}`);
      await sandbox.copyIn(dir, SANDBOX_BASE);
      await sandbox.exec(`ln -s ${q(workdir)}/node_modules ${SANDBOX_BASE}/node_modules; ln -s ${q(workdir)}/apps/desktop/node_modules ${SANDBOX_BASE}/apps/desktop/node_modules`);
    } catch (err) {
      await cleanup();
      throw err;
    }
    return { dir: SANDBOX_BASE, cleanup };
  };
}

export const SCREENS_BRANCH = 'taskcell-screens';

export interface HostScreensOptions {
  repoDir: string;
  /** The run's id: the directory the images live in on the branch. */
  runId: string;
  tokenProvider?: () => Promise<string | undefined>;
  /** Injected git runner (tests); `input` is stdin. */
  run?: ScreensRun;
  remote?: string;
}

export type ScreensRun = (file: string, args: string[], cwd: string, env?: Record<string, string>, input?: string) => Promise<string>;

const defaultRun: ScreensRun = async (file, args, cwd, env, input) =>
  (await execa(file, hostGitArgs(args), { cwd, env: { ...hostGitEnv(), ...env }, ...(input !== undefined ? { input } : {}) })).stdout;

/**
 * Add `<runId>/*.png` on top of the one `taskcell-screens` orphan branch (git plumbing, no checkout;
 * other runs' directories are kept), push it with the run's push token like every other push, and
 * link each image by commit SHA.
 */
export function gitHostScreens(o: HostScreensOptions): ScreensDeps['host'] {
  const run = o.run ?? defaultRun;
  const remote = o.remote ?? 'origin';
  const dirName = o.runId.replace(/[^\w.-]/g, '-');
  return async (images) => {
    const cwd = o.repoDir;
    const token = await resolveToken(o.tokenProvider, undefined, () => undefined);
    const env = (): Record<string, string> | undefined => (token !== undefined && token !== '' ? pushAuthEnv(token) : undefined);
    const blobs: string[] = [];
    for (const img of images) {
      blobs.push(`100644 blob ${(await run('git', ['hash-object', '-w', img.path], cwd)).trim()}\t${imageName(img)}`);
    }
    const sub = (await run('git', ['mktree'], cwd, undefined, `${blobs.join('\n')}\n`)).trim();
    for (let attempt = 0; ; attempt += 1) {
      const fetched = await run('git', ['fetch', '--quiet', remote, `refs/heads/${SCREENS_BRANCH}`], cwd, env()).then(() => true, () => false);
      const tip = fetched ? (await run('git', ['rev-parse', 'FETCH_HEAD'], cwd)).trim() : undefined;
      const others = tip === undefined ? [] : (await run('git', ['ls-tree', tip], cwd)).split('\n').filter((l) => l.trim() !== '' && !l.endsWith(`\t${dirName}`));
      const tree = (await run('git', ['mktree'], cwd, undefined, `${[...others, `040000 tree ${sub}\t${dirName}`].join('\n')}\n`)).trim();
      const commit = (await run('git', ['-c', 'user.name=Taskcell', '-c', 'user.email=vanguard@local', 'commit-tree', tree, ...(tip !== undefined ? ['-p', tip] : []), '-m', `screens ${dirName}`], cwd)).trim();
      try {
        await run('git', ['push', '--quiet', remote, `${commit}:refs/heads/${SCREENS_BRANCH}`], cwd, env());
      } catch (err) {
        if (attempt >= 1) throw new Error(`could not push ${SCREENS_BRANCH}: ${(err instanceof Error ? err.message : String(err)).split(token ?? '\0').join('***').split('\n')[0]}`);
        continue;
      }
      const remoteUrl = (await run('git', ['remote', 'get-url', remote], cwd)).trim();
      const slug = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl)?.[1];
      if (slug === undefined) throw new Error('the remote is not a GitHub repository');
      return Object.fromEntries(images.map((i) => [imageName(i), `https://github.com/${slug}/blob/${commit}/${dirName}/${imageName(i)}?raw=true`]));
    }
  };
}
