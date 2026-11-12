import { describe, it, expect, vi } from 'vitest';
import { checkCliVersions, formatCliVersions, type Fetcher } from './cli-versions.js';
import type { DockerRunner } from './docker.js';
import type { CliVersionReport } from '../wire.js';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const days = (n: number): string => new Date(NOW - n * 864e5).toISOString();

const runWith = (cursor = ''): DockerRunner => async (_c, args) => {
  if (args[0] === 'image') return { stdout: '' };
  return { stdout: `claude 2.1.260 (Claude Code)\ncodex codex-cli 0.167.2\nagent ${cursor}\n` };
};

/** A packument whose `versions` lists every `time` key except `unpublished`. */
const packument = (times: Record<string, string>, unpublished: string[] = []): unknown => ({
  time: { created: days(900), ...times },
  versions: Object.fromEntries(Object.keys(times).filter((v) => !unpublished.includes(v)).map((v) => [v, {}])),
});

/** A fresh fetcher per test: lookups are cached per fetcher identity. */
function fetcher(claudeTimes: Record<string, string>, cursorText = 'https://downloads.cursor.com/lab/2026.11.01-abcdef1/linux', unpublished: string[] = []): Fetcher {
  return vi.fn(async (url: string) => {
    if (url.includes('claude-code')) return { ok: true, json: async () => packument(claudeTimes, unpublished), text: async () => '' };
    if (url.includes('codex')) return { ok: true, json: async () => packument({ '0.167.2': days(10) }), text: async () => '' };
    return { ok: true, json: async () => ({}), text: async () => cursorText };
  });
}
const check = (f: Fetcher, run = runWith(), now = NOW): Promise<CliVersionReport> =>
  checkCliVersions({ cwd: '/', image: 'img', run, fetch: f, now, env: {} });

describe('checkCliVersions', () => {
  it('reports outdated claude with the soaked release as target, and current codex', async () => {
    const r = await check(fetcher({ '2.1.260': days(60), '2.1.322': days(5) }));
    const by = Object.fromEntries(r.clis.map((c) => [c.name, c]));
    expect(by.claude).toMatchObject({ installed: '2.1.260', latest: '2.1.322', target: '2.1.322', outdated: true, updatable: true });
    expect(by.codex).toMatchObject({ outdated: false, updatable: false });
    expect(by.cursor).toBeUndefined();
  });

  it('offers the newest soaked release when the newest is inside the soak', async () => {
    const r = await check(fetcher({ '2.1.260': days(60), '2.1.321': days(10), '2.1.322': days(1) }));
    expect(r.clis[0]).toMatchObject({ latest: '2.1.322', target: '2.1.321', outdated: true, updatable: true });
  });

  it('shows but does not offer a release when nothing newer has soaked', async () => {
    const r = await check(fetcher({ '2.1.260': days(60), '2.1.322': days(1) }));
    expect(r.clis[0]).toMatchObject({ outdated: true, updatable: false });
    expect(r.clis[0]?.target).toBeUndefined();
    expect(r.clis[0]?.reason).toMatch(/3 days/);
  });

  it('never offers a cursor update (no checksums), and ignores a newer image', async () => {
    const old = await check(fetcher({}), runWith('2026.10.16-e3cb207'));
    expect(old.clis[2]).toMatchObject({ name: 'cursor', latest: '2026.11.01-abcdef1', outdated: true, updatable: false });
    expect(old.clis[2]?.reason).toMatch(/sha256/);
    const newer = await check(fetcher({}), runWith('2026.12.01-aaaaaaa'));
    expect(newer.clis[2]).toMatchObject({ outdated: false });
    const sameDay = await check(fetcher({}), runWith('2026.11.01-1234567'));
    expect(sameDay.clis[2]).toMatchObject({ outdated: true });
    const same = await check(fetcher({}), runWith('2026.11.01-abcdef1'));
    expect(same.clis[2]).toMatchObject({ outdated: false });
  });

  it('ignores versions that were unpublished from npm', async () => {
    const r = await check(fetcher({ '2.1.260': days(60), '2.1.300': days(10), '2.1.322': days(5) }, undefined, ['2.1.322']));
    expect(r.clis[0]).toMatchObject({ latest: '2.1.300', target: '2.1.300' });
  });

  it('does not cache a non-OK response, and refetches once the TTL expires', async () => {
    let ok = false;
    const f: Fetcher = vi.fn(async () => ({ ok, json: async () => packument({ '2.1.322': days(10) }), text: async () => '' }));
    expect((await check(f)).clis[0]).toMatchObject({ reason: 'version lookup failed' });
    ok = true;
    expect((await check(f)).clis[0]).toMatchObject({ latest: '2.1.322' });
    const calls = vi.mocked(f).mock.calls.length;
    await check(f, runWith(), NOW + 59 * 60_000);
    expect(vi.mocked(f).mock.calls.length).toBe(calls);
    await check(f, runWith(), NOW + 61 * 60_000);
    expect(vi.mocked(f).mock.calls.length).toBeGreaterThan(calls);
  });

  it('makes no lookups for a CLI that is not installed', async () => {
    const f = fetcher({ '2.1.322': days(10) });
    const r = await check(f, async (_c, args) => ({ stdout: args[0] === 'image' ? 'sha256:1' : 'claude \ncodex \nagent \n' }));
    expect(f).not.toHaveBeenCalled();
    expect(formatCliVersions(r)).toEqual([]);
  });

  it('probes only a local image, never pulling, with no network, once per image ID', async () => {
    const calls: string[][] = [];
    let id = 'sha256:1';
    const run: DockerRunner = async (_c, args) => {
      calls.push(args);
      return { stdout: args[0] === 'image' ? id : 'claude 2.1.260\n' };
    };
    const f = fetcher({ '2.1.260': days(60) });
    await check(f, run);
    await check(f, run);
    const probes = (): string[][] => calls.filter((a) => a[0] === 'run');
    expect(probes()).toHaveLength(1);
    expect(probes()[0]).toEqual(expect.arrayContaining(['--rm', '--pull=never', '--network', 'none']));
    id = 'sha256:2';
    await check(f, run);
    expect(probes()).toHaveLength(2);

    const missing: string[][] = [];
    const r = await check(f, async (_c, args) => {
      missing.push(args);
      if (args[0] === 'image') throw new Error('No such image');
      return { stdout: 'claude 2.1.260\n' };
    });
    expect(missing.some((a) => a[0] === 'run')).toBe(false);
    expect(formatCliVersions(r)).toEqual([]);
  });

  it('caches lookups per fetcher', async () => {
    const f = fetcher({ '2.1.260': days(60) });
    await check(f);
    await check(f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('survives failed lookups and failed docker, with a reason', async () => {
    const bad: Fetcher = async () => {
      throw new Error('offline');
    };
    const r = await check(bad);
    expect(r.clis[0]).toMatchObject({ installed: '2.1.260', outdated: false, updatable: false, reason: 'version lookup failed' });
    const noDocker = await check(bad, async () => {
      throw new Error('no docker');
    });
    expect(formatCliVersions(noDocker)).toEqual([]);
  });

  it('makes no lookups when the setting is off', async () => {
    const f = fetcher({});
    const spy = vi.fn(runWith());
    const r = await checkCliVersions({ cwd: '/', image: 'img', run: spy, fetch: f, env: { VANGUARD_CLI_VERSION_CHECK: 'off' } });
    expect(r).toEqual({ enabled: false, clis: [] });
    expect(f).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('formatCliVersions', () => {
  it('prints the changelog and reason for an outdated CLI', () => {
    expect(
      formatCliVersions({ enabled: true, clis: [{ name: 'claude', installed: '1.0.0', latest: '1.0.1', changelog: 'https://c', outdated: true, updatable: false, reason: 'soaking' }] }),
    ).toEqual(['cli versions: claude installed 1.0.0, latest 1.0.1 — newer available (https://c); soaking']);
  });
});
