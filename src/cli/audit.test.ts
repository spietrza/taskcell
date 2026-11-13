import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendAudit, localAdapter, STREAMS } from '../core/audit.js';
import { auditCommand } from './audit.js';
import { parseCli } from './args.js';

const ctx = { actor: { kind: 'local' as const, name: 'me' } };

afterEach(() => vi.restoreAllMocks());

async function hubDir(n: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'audit-cli-'));
  const a = localAdapter({ file: join(dir, 'audit.jsonl') });
  for (let i = 0; i < n; i++) await appendAudit(STREAMS.hub, a, { time: `2026-01-0${i + 1}T00:00:00Z`, n: i }, ctx);
  return dir;
}

function cmd(argv: string[]) {
  const c = parseCli(['audit', ...argv], '/nonexistent-repo');
  if (c.kind !== 'audit') throw new Error('not an audit command');
  return c;
}

describe('taskcell audit', () => {
  it('verify passes on an intact stream and fails (exit 1) on a tampered one', async () => {
    const dir = await hubDir(3);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await auditCommand(cmd(['verify', '--stream', 'hub', '--config-dir', dir]))).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('ok');
    await appendFile(join(dir, 'audit.jsonl'), `${JSON.stringify({ time: 'x', forged: true, hash: 'f'.repeat(64), prev: '0' })}\n`);
    expect(await auditCommand(cmd(['verify', '--stream', 'hub', '--config-dir', dir]))).toBe(1);
  });

  it('export honours --since/--until and the format', async () => {
    const dir = await hubDir(3);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    await auditCommand(cmd(['export', '--stream', 'hub', '--config-dir', dir, '--since', '2026-01-02', '--until', '2026-01-02T12:00:00Z']));
    const rows = out.join('').trim().split('\n').map((l) => JSON.parse(l) as { n: number });
    expect(rows.map((r) => r.n)).toEqual([1]);
    out.length = 0;
    await auditCommand(cmd(['export', '--stream', 'hub', '--config-dir', dir, '--format', 'csv']));
    expect(out.join('').split('\n')[0]).toBe('ts,stream,actor,subject,record');
  });

  it('refuses an unknown stream at parse time', () => {
    expect(parseCli(['audit', 'verify', '--stream', 'nope'], '/w')).toMatchObject({ kind: 'error' });
  });
});
