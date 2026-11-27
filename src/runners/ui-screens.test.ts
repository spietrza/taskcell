import { describe, expect, it, vi } from 'vitest';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import { demoCaptureUrl, gitHostScreens, sandboxCapture, screensForFiles, screensSection, SCREENS_BRANCH, type CapturedImage, type ScreensDeps } from './ui-screens.js';

const png = (side: 'before' | 'after', screen: string, width: number): CapturedImage => ({ side, screen, width, path: '/tmp/x.png' });

const deps = (over: Partial<ScreensDeps> = {}): ScreensDeps => ({
  headDir: '/head',
  baseCheckout: async () => ({ dir: '/base', cleanup: async () => {} }),
  capture: async (_d, screens) => screens.flatMap((s) => [1000, 1600].map((w) => png('after', s.screen, w))),
  host: async (imgs) => Object.fromEntries(imgs.map((i) => [`${i.side}-${i.screen}-${i.width}.png`, `https://x/${i.side}-${i.screen}-${i.width}.png`])),
  ...over,
});

describe('screensForFiles', () => {
  it('maps feature folders to screens', () => {
    expect(screensForFiles(['apps/desktop/src/features/fleet/Runs.tsx', 'apps/desktop/src/features/board/a.tsx', 'src/x.ts'])).toEqual([{ screen: 'board' }, { screen: 'runs' }]);
  });
  it('falls back to Home for shared UI and none for non-UI', () => {
    expect(screensForFiles(['apps/desktop/src/ui/Button.tsx'])).toEqual([{ screen: 'home' }]);
    expect(screensForFiles(['src/core/a.ts', 'README.md'])).toEqual([]);
  });
});

describe('demoCaptureUrl', () => {
  it('only opens the local dev server in demo mode', () => {
    expect(demoCaptureUrl('http://127.0.0.1:1420/', 'runs')).toBe('http://127.0.0.1:1420/?demo=1&screen=runs');
    expect(demoCaptureUrl('http://localhost:1420/', 'home')).toBe('http://localhost:1420/?demo=1');
  });
  it('never points at a non-demo hub', () => {
    for (const u of ['https://hub.example.com/', 'http://10.0.0.5:7777/', 'http://localhost.evil.com/', 'http://127.0.0.1:7777/#token=abc', 'http://user:pw@localhost/']) {
      expect(() => demoCaptureUrl(u, 'home')).toThrow(/non-demo/);
    }
  });
});

describe('screensSection', () => {
  it('is undefined, and captures nothing, without UI changes', async () => {
    const capture = vi.fn();
    expect(await screensSection(['src/a.ts'], deps({ capture }))).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });
  it('renders before/after rows', async () => {
    const out = (await screensSection(['apps/desktop/src/features/fleet/a.tsx'], deps()))!;
    expect(out).toContain('## Screens');
    expect(out).toContain('runs 1000px');
    expect(out).toContain('![before runs 1600px](https://x/before-runs-1600.png)');
    expect(out).toContain('![after runs 1000px](https://x/after-runs-1000.png)');
  });
  it('reports a failed capture instead of throwing', async () => {
    const out = await screensSection(['apps/desktop/src/App.tsx'], deps({ capture: async () => { throw new Error('chromium missing'); } }));
    expect(out).toBe('## Screens\n\nScreenshots unavailable: chromium missing');
  });
});

describe('sandboxCapture', () => {
  it('runs the dev server and Playwright inside the sandbox, only on demo URLs', async () => {
    const execs: { command: string; input?: string }[] = [];
    const sandbox = {
      exec: async (command: string, o?: { input?: string }) => { execs.push({ command, ...(o?.input !== undefined ? { input: o.input } : {}) }); return { stdout: '', stderr: '', exitCode: 0 }; },
      copyFileOut: async () => {},
    } as unknown as IsolatedSandboxProvider;
    const imgs = await sandboxCapture(sandbox)('/workspace', [{ screen: 'runs' }, { screen: 'home' }]);
    expect(imgs).toHaveLength(4);
    expect(execs).toHaveLength(1);
    const urls = [...execs[0]!.command.matchAll(/http:\/\/[^"\\]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const url = new URL(u);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.searchParams.get('demo')).toBe('1');
    }
    // The script waits for the server before the first goto.
    expect(execs[0]!.input).toContain('the dev server never came up');
  });
  it('turns a failing sandbox command into an error carrying its last line', async () => {
    const sandbox = { exec: async () => ({ stdout: '', stderr: 'a\nno chromium', exitCode: 1 }), copyFileOut: async () => {} } as unknown as IsolatedSandboxProvider;
    await expect(sandboxCapture(sandbox)('/workspace', [{ screen: 'home' }])).rejects.toThrow('no chromium');
  });
});

describe('gitHostScreens', () => {
  it('pushes one branch with the push token and links by commit SHA', async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const run = async (_f: string, args: string[], _c: string, env?: Record<string, string>): Promise<string> => {
      calls.push({ args, ...(env !== undefined ? { env } : {}) });
      if (args[0] === 'fetch') throw new Error('no branch yet');
      if (args[0] === 'remote') return 'https://github.com/o/r.git\n';
      return 'abc123\n';
    };
    const urls = await gitHostScreens({ repoDir: '/r', runId: 'o/r#7', tokenProvider: async () => 'TOK', run })([{ side: 'after', screen: 'home', width: 1000, path: '/tmp/a.png' }]);
    expect(urls['after-home-1000.png']).toBe('https://github.com/o/r/blob/abc123/o-r-7/after-home-1000.png?raw=true');
    const push = calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toContain(`abc123:refs/heads/${SCREENS_BRANCH}`);
    expect(Object.values(push.env ?? {})).toContain(`AUTHORIZATION: basic ${Buffer.from('x-access-token:TOK').toString('base64')}`);
  });
});
