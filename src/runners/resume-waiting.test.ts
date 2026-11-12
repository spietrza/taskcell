import { describe, expect, it, vi } from 'vitest';
import { resumeRateLimited } from './resume-rate-limited.js';
import type { GhRunner } from '../tasks/github.js';

const marker = '<!-- vanguard:waiting trigger="ready for agent" -->';
const bot = { author: { login: 'github-actions[bot]' }, authorAssociation: 'NONE', createdAt: '2030-01-01T00:00:00Z' };

function setup(opts: { labels?: string[]; comments?: object[]; blocker?: object; body?: string; recheckLabels?: string[] } = {}) {
  const calls: string[] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'view' && args.at(-1) === 'labels') return JSON.stringify({ labels: (opts.recheckLabels ?? opts.labels ?? ['vanguard:waiting']).map((name) => ({ name })) });
    if (args[0] === 'issue' && args[1] === 'list') return args.includes('vanguard:waiting') ? '[{"number":7}]' : '[]';
    if (args[0] === 'pr') return '[]';
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ title: 't', body: opts.body ?? 'Depends on #2', labels: (opts.labels ?? ['vanguard:waiting']).map((name) => ({ name })), comments: opts.comments ?? [{ ...bot, body: `waiting\n${marker}` }] });
    }
    if (args[0] === 'api') {
      if ((args[1] ?? '').includes('/dependencies/')) return '[]';
      return JSON.stringify(opts.blocker ?? { state: 'closed', state_reason: 'completed' });
    }
    return '';
  };
  return { gh, calls };
}
const run = (gh: GhRunner, extra = {}) => resumeRateLimited({ repoSlug: 'o/r', gh, log: vi.fn(), ...extra });

describe('resume of dependency-waiting issues', () => {
  it('re-applies the trigger once the blocker is closed', async () => {
    const { gh, calls } = setup();
    expect((await run(gh)).resumed).toEqual(['o/r#7']);
    expect(calls).toContain('issue edit 7 --repo o/r --remove-label vanguard:waiting');
    expect(calls).toContain('issue edit 7 --repo o/r --add-label ready for agent');
  });
  it('stays parked while the blocker is open', async () => {
    const { gh, calls } = setup({ blocker: { state: 'open' } });
    const report = await run(gh);
    expect(report.waiting).toEqual(['o/r#7']);
    expect(calls.some((c) => c.startsWith('issue edit'))).toBe(false);
  });
  it('ignores an untrusted marker', async () => {
    const { gh } = setup({ comments: [{ author: { login: 'mallory' }, authorAssociation: 'NONE', createdAt: '2030-01-01T00:00:00Z', body: marker }] });
    expect((await run(gh)).skipped).toEqual(['o/r#7']);
  });
  it('ignores a marker naming a disallowed trigger', async () => {
    const { gh } = setup({ comments: [{ ...bot, body: '<!-- vanguard:waiting trigger="evil" -->' }] });
    expect((await run(gh)).skipped).toEqual(['o/r#7']);
  });
  it('dry-run edits nothing', async () => {
    const { gh, calls } = setup();
    expect((await run(gh, { dryRun: true })).resumed).toEqual(['o/r#7']);
    expect(calls.some((c) => c.startsWith('issue edit'))).toBe(false);
  });
  it('re-triggers an invalid dependency so the run reports needs info', async () => {
    const { gh } = setup({ blocker: { state: 'closed', state_reason: 'not_planned' } });
    expect((await run(gh)).resumed).toEqual(['o/r#7']);
  });
  it('reports a failed lookup as failed', async () => {
    const { gh } = setup();
    const failing: GhRunner = async (args) => {
      if (args[0] === 'api') throw new Error('HTTP 403');
      return gh(args);
    };
    expect((await run(failing)).failed).toEqual(['o/r#7']);
  });
  it('honours custom started labels', async () => {
    const { gh, calls } = setup({ labels: ['vanguard:waiting', 'wip'] });
    expect((await run(gh, { startedLabels: ['wip'] })).skipped).toEqual(['o/r#7']);
    expect(calls.some((c) => c.includes('--add-label'))).toBe(false);
  });
  it('does not re-trigger when a claim landed during the dependency check', async () => {
    const { gh, calls } = setup({ recheckLabels: ['vanguard:waiting', 'vanguard:running'] });
    expect((await run(gh)).skipped).toEqual(['o/r#7']);
    expect(calls.some((c) => c.startsWith('issue edit'))).toBe(false);
  });
  it('only drops a stale waiting label on an issue that already started', async () => {
    const { gh, calls } = setup({ labels: ['vanguard:waiting', 'vanguard:needs-human-review'] });
    const report = await run(gh);
    expect(report.resumed).toEqual([]);
    expect(calls).toContain('issue edit 7 --repo o/r --remove-label vanguard:waiting');
    expect(calls.some((c) => c.includes('--add-label'))).toBe(false);
  });
});
