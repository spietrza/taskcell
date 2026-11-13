import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import {
  appendAudit,
  AuditWriteError,
  branchAdapter,
  exportRecords,
  filterByTime,
  localAdapter,
  readAudit,
  redactDeep,
  retentionDays,
  STREAMS,
  verifyAudit,
  BOT_ACTOR,
  type AuditStream,
} from './audit.js';

const ctx = { actor: { kind: 'user' as const, id: 'u1', name: 'Ada' }, subject: { repo: 'o/r', pr: 7 } };
const audit: AuditStream = { name: 't', class: 'audit' };

async function setup(maxBytes?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-'));
  const file = join(dir, 'a.jsonl');
  return { dir, file, adapter: localAdapter({ file, ...(maxBytes !== undefined ? { maxBytes } : {}) }) };
}

describe('audit record module', () => {
  it('appends chained records with actor and subject and verifies them', async () => {
    const { adapter, file } = await setup();
    for (let i = 0; i < 3; i++) await appendAudit(audit, adapter, { n: i }, ctx);
    const records = await readAudit(adapter);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ n: 0, actor: ctx.actor, subject: ctx.subject });
    expect(records[1]!.prev).toBe(records[0]!.hash);
    expect(await verifyAudit(adapter)).toMatchObject({ ok: true, records: 3 });
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('detects an edited line', async () => {
    const { adapter, file } = await setup();
    for (let i = 0; i < 3; i++) await appendAudit(audit, adapter, { n: i }, ctx);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    lines[1] = lines[1]!.replace('"n":1', '"n":9');
    await writeFile(file, `${lines.join('\n')}\n`);
    const r = await verifyAudit(adapter);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ line: 2, reason: expect.stringContaining('hash mismatch') });
  });

  it('detects a deleted line', async () => {
    const { adapter, file } = await setup();
    for (let i = 0; i < 4; i++) await appendAudit(audit, adapter, { n: i }, ctx);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    lines.splice(1, 1);
    await writeFile(file, `${lines.join('\n')}\n`);
    const r = await verifyAudit(adapter);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ line: 2, reason: expect.stringContaining('chain broken') });
  });

  it('a torn final line does not break the chain: the next append starts a fresh line', async () => {
    const { adapter, file } = await setup();
    await appendAudit(audit, adapter, { n: 0 }, ctx);
    await writeFile(file, `${await readFile(file, 'utf8')}{"n":1,"pre`);
    expect(await verifyAudit(adapter)).toMatchObject({ ok: true, torn: 1 });
    await appendAudit(audit, adapter, { n: 2 }, ctx);
    await appendAudit(audit, adapter, { n: 3 }, ctx);
    expect(await verifyAudit(adapter)).toMatchObject({ ok: true, records: 3, torn: 1 });
    expect((await readAudit(adapter)).map((r) => r.n)).toEqual([0, 2, 3]);
  });

  it('a record garbled into an unparseable line is still caught by the chain', async () => {
    const { adapter, file } = await setup();
    for (let i = 0; i < 3; i++) await appendAudit(audit, adapter, { n: i }, ctx);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    lines[1] = '{"garbled';
    await writeFile(file, `${lines.join('\n')}\n`);
    const r = await verifyAudit(adapter);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ line: 3, reason: expect.stringContaining('chain broken') });
  });

  it('keeps a payload key that collides with the envelope', async () => {
    const { adapter } = await setup();
    await appendAudit(audit, adapter, { actor: 'payload-actor' }, ctx);
    expect((await readAudit(adapter))[0]).toMatchObject({ _actor: 'payload-actor', actor: ctx.actor });
  });

  it('bounds rotated files by count and readers can stop early', async () => {
    const { adapter, dir } = await setup(200);
    const small = localAdapter({ file: join(dir, 'a.jsonl'), maxBytes: 200, maxRotated: 2 });
    for (let i = 0; i < 12; i++) await appendAudit(audit, small, { n: i, pad: 'x'.repeat(100) }, ctx);
    expect((await readdir(dir)).filter((n) => n.startsWith('a.jsonl.'))).toHaveLength(2);
    const first = (await small.newestFirst()[Symbol.asyncIterator]().next()).value;
    expect(first.name).toBe(join(dir, 'a.jsonl'));
    void adapter;
  });

  it('serialises concurrent appends from separate adapter instances into one chain', async () => {
    const { file } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => appendAudit(audit, localAdapter({ file }), { n: i }, ctx)));
    expect(await verifyAudit(localAdapter({ file }))).toMatchObject({ ok: true, records: 10 });
  });

  it('carries the chain across a rotation and prunes rotated files past retention', async () => {
    const { adapter, dir } = await setup(300);
    for (let i = 0; i < 6; i++) await appendAudit(audit, adapter, { n: i, pad: 'x'.repeat(100) }, ctx);
    const rotated = (await readdir(dir)).filter((n) => n.startsWith('a.jsonl.'));
    expect(rotated.length).toBeGreaterThan(0);
    expect(await verifyAudit(adapter)).toMatchObject({ ok: true, records: 6 });
    expect(await readAudit(adapter)).toHaveLength(6);
    // age every rotated file past 90 days: the next rotation prunes them
    const old = new Date(Date.now() - 100 * 86_400_000);
    for (const n of rotated) await utimes(join(dir, n), old, old);
    for (let i = 6; i < 10; i++) await appendAudit(audit, adapter, { n: i, pad: 'x'.repeat(100) }, ctx);
    const after = await readAudit(adapter);
    expect(after.map((r) => r.n)).not.toContain(0);
    expect(after.at(-1)!.n).toBe(9);
    expect((await verifyAudit(adapter)).ok).toBe(true);
  });

  it('keeps the chain across a fresh adapter instance (restart)', async () => {
    const { adapter, file } = await setup();
    await appendAudit(audit, adapter, { n: 0 }, ctx);
    const again = localAdapter({ file });
    await appendAudit(audit, again, { n: 1 }, ctx);
    expect(await verifyAudit(again)).toMatchObject({ ok: true, records: 2 });
  });

  it('tolerates unchained lines written before the chain began', async () => {
    const { adapter, file } = await setup();
    await writeFile(file, '{"old":1}\n{"old":2}\n');
    await appendAudit(audit, adapter, { n: 0 }, ctx);
    expect(await verifyAudit(adapter)).toMatchObject({ ok: true, legacy: 2, records: 1 });
  });

  it('redacts secrets deeply, in the stored line', async () => {
    const { adapter, file } = await setup();
    const secret = 'ghp_' + 'a'.repeat(36);
    await appendAudit(audit, adapter, { nested: { list: [`token ${secret}`] }, plain: 'ok' }, ctx);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain('"plain":"ok"');
    expect(redactDeep({ a: [{ b: `x ${secret}` }] })).not.toEqual({ a: [{ b: `x ${secret}` }] });
    expect((await verifyAudit(adapter)).ok).toBe(true);
  });

  it('fails closed on an audit stream and stays best-effort on telemetry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'));
    await writeFile(join(dir, 'blocker'), 'a file, not a directory');
    const adapter = localAdapter({ file: join(dir, 'blocker', 'a.jsonl') });
    await expect(appendAudit(STREAMS.hub, adapter, { n: 1 }, ctx)).rejects.toBeInstanceOf(AuditWriteError);
    await expect(appendAudit(STREAMS.metrics, adapter, { n: 1 }, ctx)).resolves.toBe(0);
  });

  it('refuses a symlinked state dir leaf through the state-path guard', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'audit-repo-'));
    const state = join(repo, '.taskcell', 'runs');
    await mkdir(state, { recursive: true });
    await symlink(join(repo, 'elsewhere'), join(state, 'metrics.jsonl'));
    const adapter = localAdapter({ file: join(state, 'metrics.jsonl'), repoPath: repo });
    await expect(appendAudit(STREAMS.hub, adapter, { n: 1 }, ctx)).rejects.toBeInstanceOf(AuditWriteError);
  });

  it('keeps old legacy numeric-suffix files past the age prune', async () => {
    const { adapter, dir, file } = await setup();
    const old = new Date(Date.now() - 200 * 86_400_000);
    for (const n of [1, 2, 3, 4]) {
      await writeFile(`${file}.${n}`, '{"old":1}\n');
      await utimes(`${file}.${n}`, old, old);
    }
    await appendAudit(audit, adapter, { n: 0 }, ctx);
    expect((await readdir(dir)).filter((n) => /\.\d$/.test(n)).sort()).toEqual(['a.jsonl.1', 'a.jsonl.2', 'a.jsonl.3', 'a.jsonl.4']);
  });

  it('applies the count limit to legacy numeric files, oldest first', async () => {
    const { dir, file } = await setup();
    for (const n of [1, 2, 3]) await writeFile(`${file}.${n}`, '{"old":1}\n');
    await appendAudit(audit, localAdapter({ file, maxRotated: 2 }), { n: 0 }, ctx);
    expect((await readdir(dir)).filter((n) => /\.\d$/.test(n)).sort()).toEqual(['a.jsonl.1', 'a.jsonl.2']);
  });

  it('appends when the lock path is a directory', async () => {
    const { adapter, dir, file } = await setup();
    await mkdir(join(dir, 'a.jsonl.lock'));
    await writeFile(join(dir, 'a.jsonl.lock', 'x'), '');
    await expect(appendAudit(audit, adapter, { n: 0 }, ctx)).resolves.toBe(1);
    expect(await readFile(file, 'utf8')).toContain('"n":0');
  });

  it('skips a symlinked rotated sibling and keeps appending', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'audit-repo-'));
    const state = join(repo, '.taskcell', 'runs');
    await mkdir(state, { recursive: true });
    await writeFile(join(repo, 'elsewhere'), '{"hash":"evil"}\n');
    await symlink(join(repo, 'elsewhere'), join(state, 'metrics.jsonl.1'));
    const adapter = localAdapter({ file: join(state, 'metrics.jsonl'), repoPath: repo });
    await expect(appendAudit(STREAMS.hub, adapter, { n: 1 }, ctx)).resolves.toBe(1);
    await expect(appendAudit(STREAMS.hub, adapter, { n: 2 }, ctx)).resolves.toBe(1);
    // readers keep refusing the symlink rather than silently dropping its records
    await expect(verifyAudit(adapter)).rejects.toThrow(/symlink/);
  });

  it('skips a null or non-object line and keeps appending', async () => {
    const { adapter, file } = await setup();
    await writeFile(file, 'null\n[1]\n42\n');
    await expect(appendAudit(audit, adapter, { n: 0 }, ctx)).resolves.toBe(1);
    expect(await readAudit(adapter)).toHaveLength(1);
  });

  it('exports a time window as jsonl and csv', () => {
    const recs = [
      { ts: '2026-01-01T00:00:00Z', actor: BOT_ACTOR, v: '=cmd' },
      { ts: '2026-02-01T00:00:00Z', actor: BOT_ACTOR, v: 'b' },
    ];
    const win = filterByTime(recs, '2026-01-15', '2026-03-01');
    expect(win).toHaveLength(1);
    expect(exportRecords(win, 'jsonl')).toBe(`${JSON.stringify(recs[1])}\n`);
    const csv = exportRecords(recs, 'csv', 'hub');
    expect(csv.split('\n')[0]).toBe('ts,stream,actor,subject,record');
    expect(csv.split('\n')).toHaveLength(4);
    // a leading `=` in a cell is neutralised; no header when appending a later stream
    expect(exportRecords([{ ts: '=HYPERLINK(1)' }], 'csv', 'hub')).toContain("'=HYPERLINK(1)");
    expect(exportRecords(recs, 'csv', 'metrics', false)).not.toContain('ts,stream');
  });

  it('retention defaults to 90 days and is configurable', () => {
    expect(retentionDays(undefined, {})).toBe(90);
    expect(retentionDays(undefined, { TASKCELL_AUDIT_RETENTION_DAYS: '30' })).toBe(30);
    expect(retentionDays(7, {})).toBe(7);
  });
});

describe('metrics-branch adapter', () => {
  async function repoWithRemote(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'audit-git-'));
    await execa('git', ['init', '--bare', '-q', join(root, 'remote.git')]);
    const work = join(root, 'work');
    await execa('git', ['init', '-q', work]);
    await execa('git', ['remote', 'add', 'origin', join(root, 'remote.git')], { cwd: work });
    return work;
  }

  it('chains across appends, dedupes, and detects a tampered branch file', async () => {
    const work = await repoWithRemote();
    const adapter = branchAdapter(work, { file: 'decisions.jsonl', key: (r) => (typeof r.k === 'string' ? r.k : undefined) });
    await appendAudit(audit, adapter, { k: 'a' }, ctx);
    await appendAudit(audit, adapter, [{ k: 'b' }, { k: 'a' }, { k: 'c' }], ctx);
    expect(await appendAudit(audit, adapter, { k: 'c' }, ctx)).toBe(0);
    const records = await readAudit(adapter);
    expect(records.map((r) => r.k)).toEqual(['a', 'b', 'c']);
    expect(records[2]!.prev).toBe(records[1]!.hash);
    expect(await verifyAudit(adapter)).toMatchObject({ ok: true, records: 3 });
  });

  it('detects a tampered branch file', async () => {
    const work = await repoWithRemote();
    const adapter = branchAdapter(work, { file: 'decisions.jsonl' });
    for (let i = 0; i < 3; i++) await appendAudit(audit, adapter, { n: i }, ctx);
    const [f] = await adapter.files();
    const lines = f!.text.trim().split('\n');
    lines.splice(1, 1);
    const blob = (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: `${lines.join('\n')}\n` })).stdout;
    const tree = (await execa('git', ['mktree'], { cwd: work, input: `100644 blob ${blob}\tdecisions.jsonl\n` })).stdout;
    const commit = (await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'tamper'], { cwd: work })).stdout;
    await execa('git', ['push', '--force', '--quiet', 'origin', `${commit}:refs/heads/taskcell-metrics`], { cwd: work });
    expect((await verifyAudit(adapter)).ok).toBe(false);
  });
});
