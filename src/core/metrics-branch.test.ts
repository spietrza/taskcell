import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { execa } from 'execa';
import { pushMetrics, readBranchMetrics, appendBranchLines, readBranchFile, tipLockKey, METRICS_BRANCH_DEFAULT, METRICS_BRANCH_LEGACY } from './metrics-branch.js';

let root: string;
let origin: string;
let repo: string;

async function clone(name: string): Promise<string> {
  const path = join(root, name);
  await execa('git', ['clone', '--quiet', origin, path]);
  await execa('git', ['-C', path, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', path, 'config', 'user.name', 't']);
  return path;
}

async function writeMetrics(path: string, lines: string[]): Promise<void> {
  await mkdir(join(path, '.vanguard', 'runs'), { recursive: true });
  await writeFile(join(path, '.vanguard', 'runs', 'metrics.jsonl'), `${lines.join('\n')}\n`);
}

const line = (taskId: string, ts: string): string => JSON.stringify({ evt: 'run_complete', ts, taskId, stage: 'implementer', costUsd: 0.1 });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-metrics-'));
  origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  // A seeded main so the clone has a HEAD; the metrics branch must stay independent of it.
  const seed = join(root, 'seed');
  await execa('git', ['init', '--quiet', '-b', 'main', seed]);
  await execa('git', ['-C', seed, 'config', 'user.email', 't@t']);
  await execa('git', ['-C', seed, 'config', 'user.name', 't']);
  await writeFile(join(seed, 'README.md'), 'x\n');
  await execa('git', ['-C', seed, 'add', '.']);
  await execa('git', ['-C', seed, 'commit', '--quiet', '-m', 'seed']);
  await execa('git', ['-C', seed, 'push', '--quiet', origin, 'main']);
  repo = await clone('repo');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('pushMetrics / readBranchMetrics', () => {
  it('creates the orphan branch on first push, reads it back, and skips already-present lines on a re-run', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z'), 'not json', line('b', '2026-10-08T10:01:00.000Z')]);
    const first = await pushMetrics(repo);
    expect(first).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 2, total: 2 });

    const text = await readBranchMetrics(repo);
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).toContain('"taskId":"a"');

    // The metrics branch is an orphan: no README, only metrics.jsonl.
    const tree = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree.trim()).toBe('metrics.jsonl');

    const again = await pushMetrics(repo);
    expect(again).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 0, total: 2 });
  });

  it('appends new lines from a second checkout on top of the existing tip', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z')]);
    await pushMetrics(repo);
    const other = await clone('other');
    await writeMetrics(other, [line('a', '2026-10-08T10:00:00.000Z'), line('c', '2026-10-08T11:00:00.000Z')]);
    expect(await pushMetrics(other)).toMatchObject({ pushed: 1, total: 2 });
    const text = await readBranchMetrics(repo);
    expect(text.trim().split('\n').map((l) => (JSON.parse(l) as { taskId: string }).taskId)).toEqual(['a', 'c']);
    const commits = (await execa('git', ['-C', repo, 'rev-list', '--count', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(commits.trim()).toBe('2');
  });

  it('is a no-op without local metrics and reads an empty string when the branch does not exist', async () => {
    expect(await pushMetrics(repo)).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 0, total: 0 });
    expect(await readBranchMetrics(repo)).toBe('');
    expect(await readBranchMetrics(repo, { branch: 'other-metrics' })).toBe('');
  });

  it('honours a custom branch name', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z')]);
    expect(await pushMetrics(repo, { branch: 'team-metrics' })).toMatchObject({ branch: 'team-metrics', pushed: 1 });
    expect(await readBranchMetrics(repo, { branch: 'team-metrics' })).toContain('"taskId":"a"');
    expect(await readBranchMetrics(repo)).toBe('');
  });
});

describe('tipLockKey', () => {
  it('is the same for a symlinked or trailing-slash spelling of the repository, and differs per repo, remote and branch', async () => {
    const link = join(root, 'link');
    await symlink(repo, link);
    const key = tipLockKey(repo, 'origin', 'b');
    expect(tipLockKey(link, 'origin', 'b')).toBe(key);
    expect(tipLockKey(`${repo}/`, 'origin', 'b')).toBe(key);
    expect(tipLockKey(root, 'origin', 'b')).not.toBe(key);
    expect(tipLockKey(repo, 'origin', 'c')).not.toBe(key);
    expect(tipLockKey(join(root, 'missing'), 'origin', 'b')).toContain('missing');
  });
});

describe('appendBranchLines', () => {
  it('preserves sibling tree entries when appending a different file', async () => {
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z')]);
    await pushMetrics(repo);

    const decision = (pr: number, sha: string): string => JSON.stringify({ prNumber: pr, headSha: sha, verdict: 'APPROVE' });
    await appendBranchLines(repo, [decision(1, 'sha1')], {
      file: 'decisions.jsonl',
      key: (r) => `${r.prNumber}:${r.headSha}`,
    });

    const tree = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree.trim().split('\n').sort()).toEqual(['decisions.jsonl', 'metrics.jsonl']);
    expect(await readBranchMetrics(repo)).toContain('"taskId":"a"');
    expect(await readBranchFile(repo, { file: 'decisions.jsonl' })).toContain('"prNumber":1');

    // metrics push afterwards must not drop decisions.jsonl.
    await writeMetrics(repo, [line('a', '2026-10-08T10:00:00.000Z'), line('b', '2026-10-08T10:01:00.000Z')]);
    await pushMetrics(repo);
    const tree2 = (await execa('git', ['-C', repo, 'ls-tree', '--name-only', `origin/${METRICS_BRANCH_DEFAULT}`])).stdout;
    expect(tree2.trim().split('\n').sort()).toEqual(['decisions.jsonl', 'metrics.jsonl']);
    expect(await readBranchFile(repo, { file: 'decisions.jsonl' })).toContain('"prNumber":1');
  });

  it('dedupes by key, skipping a record with the same key but a different timestamp', async () => {
    const decision = (pr: number, sha: string, ts: string): string =>
      JSON.stringify({ prNumber: pr, headSha: sha, timestamp: ts });
    const opts = { file: 'decisions.jsonl', key: (r: Record<string, unknown>) => `${r.prNumber}:${r.headSha}` };
    await appendBranchLines(repo, [decision(1, 'sha1', 't0')], opts);
    const again = await appendBranchLines(repo, [decision(1, 'sha1', 't1')], opts);
    expect(again).toMatchObject({ pushed: 0, total: 1 });
    const text = await readBranchFile(repo, { file: 'decisions.jsonl' });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('"timestamp":"t0"');
  });

  it('dedupes by exact line when no key is given, same as the original metrics semantics', async () => {
    const opts = { file: 'other.jsonl' };
    await appendBranchLines(repo, [line('a', '2026-10-08T10:00:00.000Z')], opts);
    const again = await appendBranchLines(repo, [line('a', '2026-10-08T10:00:00.000Z')], opts);
    expect(again).toMatchObject({ pushed: 0, total: 1 });
    const fresh = await appendBranchLines(repo, [line('b', '2026-10-08T10:01:00.000Z')], opts);
    expect(fresh).toMatchObject({ pushed: 1, total: 2 });
  });
});

it('ignores non-object JSON input before invoking a record key', async () => {
  const result = await appendBranchLines(repo, ['null', '[]', '1', '"text"', '{"id":1}'], {
    file: 'decisions.jsonl',
    key: (record) => String(record.id),
  });
  expect(result).toMatchObject({ pushed: 1, total: 1 });
  expect((await readBranchFile(repo, { file: 'decisions.jsonl' })).trim()).toBe('{"id":1}');
});

describe('legacy metrics branch (pre-rename vanguard-metrics)', () => {
  it('reads the legacy branch until the new one exists, then continues its history on the first push', async () => {
    await writeMetrics(repo, [line('old', '2026-10-08T10:00:00.000Z')]);
    await pushMetrics(repo, { branch: METRICS_BRANCH_LEGACY });
    expect(await readBranchMetrics(repo)).toContain('"taskId":"old"');

    await writeMetrics(repo, [line('new', '2026-10-08T11:00:00.000Z')]);
    expect(await pushMetrics(repo)).toEqual({ branch: METRICS_BRANCH_DEFAULT, pushed: 1, total: 2 });
    const text = await readBranchMetrics(repo);
    expect(text).toContain('"taskId":"old"');
    expect(text).toContain('"taskId":"new"');
    // An explicit --branch never falls back.
    expect(await readBranchMetrics(repo, { branch: 'other' })).toBe('');
  });
});

describe('tip fetch', () => {
  it('reads through a named ref, so a fetch that rewrites FETCH_HEAD cannot blank the read', async () => {
    await appendBranchLines(repo, ['{"id":1}'], { file: 'decisions.jsonl' });
    const reads = Promise.all([1, 2, 3, 4].map(() => readBranchFile(repo, { file: 'decisions.jsonl' })));
    await Promise.all([1, 2, 3, 4].map(() => execa('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main'])));
    for (const text of await reads) expect(text.trim()).toBe('{"id":1}');
    const ref = await execa('git', ['-C', repo, 'rev-parse', `refs/taskcell/tips/origin/${METRICS_BRANCH_DEFAULT}`]);
    expect(ref.stdout).toMatch(/^[0-9a-f]{40}$/);
  });

  it('retries a fetch whose ref lock another process holds, instead of reading as empty', async () => {
    await appendBranchLines(repo, ['{"id":0}'], { file: 'decisions.jsonl' });
    // The remote tip moves, so the next read must create (and lock) this repo's tip ref.
    await appendBranchLines(await clone('other'), ['{"id":1}'], { file: 'decisions.jsonl' });
    // The lock file another process's fetch of the same tip ref would hold; it lets go shortly after.
    const lockDir = join(repo, '.git', 'refs', 'taskcell', 'tips', 'origin');
    await mkdir(lockDir, { recursive: true });
    const lock = join(lockDir, `${METRICS_BRANCH_DEFAULT}.lock`);
    await writeFile(lock, '');
    setTimeout(() => void rm(lock, { force: true }), 300); // past git's own 100 ms lock wait
    expect((await readBranchFile(repo, { file: 'decisions.jsonl' })).trim().split('\n')).toEqual(['{"id":0}', '{"id":1}']);
  });

  it('reads the existing tip ref when the lock outlasts the retry, and throws when there is none', async () => {
    await appendBranchLines(repo, ['{"id":0}'], { file: 'decisions.jsonl' });
    await readBranchFile(repo, { file: 'decisions.jsonl' }); // creates the tip ref
    const lock = join(repo, '.git', 'refs', 'taskcell', 'tips', 'origin', `${METRICS_BRANCH_DEFAULT}.lock`);
    await appendBranchLines(await clone('other'), ['{"id":1}'], { file: 'decisions.jsonl' });
    await writeFile(lock, '');
    expect((await readBranchFile(repo, { file: 'decisions.jsonl' })).trim()).toBe('{"id":0}');
    await rm(lock, { force: true });
    // No tip ref and a held lock: not "branch absent".
    const fresh = await clone('fresh');
    const freshDir = join(fresh, '.git', 'refs', 'taskcell', 'tips', 'origin');
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(freshDir, `${METRICS_BRANCH_DEFAULT}.lock`), '');
    await expect(readBranchFile(fresh, { file: 'decisions.jsonl' })).rejects.toThrow();
  });

  it('a non-lock fetch error skips the retry wait', async () => {
    const t = Date.now();
    expect(await readBranchFile(repo, { file: 'decisions.jsonl', branch: 'nope' })).toBe('');
    expect(Date.now() - t).toBeLessThan(450);
  });

  it('concurrent reads never come back blank while the remote tip keeps moving', async () => {
    const other = await clone('other');
    await appendBranchLines(other, ['{"id":0}'], { file: 'decisions.jsonl' });
    for (let n = 1; n <= 8; n += 1) {
      await appendBranchLines(other, [`{"id":${n}}`], { file: 'decisions.jsonl' });
      const texts = await Promise.all([1, 2, 3].map(() => readBranchFile(repo, { file: 'decisions.jsonl' })));
      for (const text of texts) expect(text).toContain(`{"id":${n}}`);
    }
  });
});

describe('aborted tip fetch', () => {
  it('settles at once, kills the transport helper and frees the tip lock, against a remote that never answers', async () => {
    await appendBranchLines(repo, ['{"id":0}'], { file: 'decisions.jsonl' });
    vi.stubEnv('no_proxy', '127.0.0.1');
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    // Accepts the connection and never answers: `git fetch` hangs in its `git remote-http` helper.
    const sockets: Socket[] = [];
    const server = createServer((s) => sockets.push(s.resume()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      await execa('git', ['-C', repo, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/r.git`]);
      const controller = new AbortController();
      const read = readBranchFile(repo, { file: 'decisions.jsonl', signal: controller.signal });
      for (let i = 0; sockets.length === 0; i++) {
        if (i > 250) throw new Error('git never connected to the test server');
        await new Promise((r) => setTimeout(r, 20));
      }
      const closed = new Promise((r) => sockets[0]?.once('close', r));
      const t = Date.now();
      controller.abort(new Error('timed out'));
      await expect(read).rejects.toThrow('timed out');
      expect(Date.now() - t).toBeLessThan(1000);
      // The helper holding the connection died with git's process group.
      await closed;
      // The tip lock is free: a read of the same tip runs (and reads the real remote) instead of queueing forever.
      await execa('git', ['-C', repo, 'remote', 'set-url', 'origin', origin]);
      const next = readBranchFile(repo, { file: 'decisions.jsonl' });
      const stuck = new Promise<string>((r) => setTimeout(() => r('lock still held'), 3000));
      expect((await Promise.race([next, stuck])).trim()).toBe('{"id":0}');
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});
