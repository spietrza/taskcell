import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCli, USAGE } from './args.js';
import { COMMANDS, commandUsage, findCommand } from './commands.js';

const ROOT = new URL('../../', import.meta.url).pathname;

describe('generated help', () => {
  it('lists every declared option of every command, in its usage and in --help', () => {
    for (const c of COMMANDS) {
      const usage = commandUsage(c);
      for (const [name, o] of Object.entries(c.options)) {
        expect(usage, `${c.name} --${name}`).toContain(`--${name}${o.arg !== undefined ? ` ${o.arg}` : ''}`);
        expect(usage, `${c.name} --${name} help`).toContain(o.help);
        expect(USAGE, `${c.name} --${name}`).toContain(`--${name}`);
      }
      expect(USAGE).toContain(usage);
    }
  });

  it('every option has a help line', () => {
    for (const c of COMMANDS) for (const [name, o] of Object.entries(c.options)) expect(o.help.trim(), `${c.name} --${name}`).not.toBe('');
  });

  it('documents the flags help used to miss', () => {
    const missing: [string, string][] = [['hub', 'host'], ['hub', 'port'], ['hub', 'ui-dir'], ['hub', 'no-open'], ['hub', 'allowed-host'], ['hub', 'admin-github-login'], ['run', 'pnpm-store'], ['watch', 'pnpm-store'], ['doctor', 'fix']];
    for (const [command, flag] of missing) expect(commandUsage(findCommand(command)!)).toContain(`--${flag}`);
  });

  it('`<command> --help` asks for that command\'s usage; a flag of another command names the command', () => {
    expect(parseCli(['gc', '--help'], '/w')).toEqual({ kind: 'help', command: 'gc' });
    expect(parseCli(['--help'], '/w')).toEqual({ kind: 'help' });
    expect(parseCli(['gc', '--fix'], '/w')).toEqual({ kind: 'error', message: 'gc does not accept --fix; see `taskcell gc --help`.' });
    expect(parseCli(['gc', '--no-such-flag'], '/w')).toEqual({ kind: 'help' });
  });
});

// --- Invocations the repo itself makes: workflows, templates, docs and the desktop/hub spawns must keep parsing. ---

const FLAG_COMMANDS = new Set(COMMANDS.map((c) => c.name));

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

/** Shell-ish split: quotes group, `$VAR`/`<placeholder>`/`...` values become `x`. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    out.push(raw.startsWith('--') && !raw.includes('=') ? raw : /[$<>]|^\.\.\.$/.test(raw) ? 'x' : raw);
  }
  return out;
}

function workflowInvocations(file: string): string[][] {
  const text = readFileSync(file, 'utf8');
  const found: string[][] = [];
  let current: string[] | undefined;
  // `args=(cmd ...)` starts an invocation (possibly over several lines), `args+=(...)` extends the latest one.
  for (const m of text.matchAll(/args(\+?)=\(([^)]*)\)|index\.js ((?:eval|resume-rate-limited|lessons|approve|migrate-labels|stats)\b[^\n>|]*)/g)) {
    if (m[3] !== undefined) found.push(tokenize(m[3]));
    else if (m[1] === '+') current?.push(...tokenize(m[2]!));
    else found.push((current = tokenize(m[2]!)));
  }
  return found.filter((argv) => FLAG_COMMANDS.has(argv[0] ?? ''));
}

function docInvocations(file: string): string[][] {
  const found: string[][] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /(?:^|[\s`(])taskcell ((?:[a-z][a-z-]*)(?: [^`|;&>]*)?)/.exec(line);
    if (!m || m[1]!.includes('[')) continue; // prose synopsis, not an invocation
    const words = tokenize(m[1]!.replace(/#.*$/, '').replace(/\s*\\$/, ''));
    if (words.length > 0 && FLAG_COMMANDS.has(words[0]!) && words.some((w) => w.startsWith('--'))) found.push(words);
  }
  return found;
}

const refused = (argv: string[]): string | undefined => {
  const r = parseCli(argv, '/work');
  return r.kind === 'error' && /does not accept|takes no value/.test(r.message) ? r.message : undefined;
};

describe('invocations the repo makes still parse', () => {
  const files = [
    ...walk(join(ROOT, '.github/workflows'), '.yml'),
    ...walk(join(ROOT, 'templates/github'), '.yml'),
  ];
  it.each(files.map((f) => [f.slice(ROOT.length), f]))('%s', (_name, file) => {
    for (const argv of workflowInvocations(file!)) expect(refused(argv), argv.join(' ')).toBeUndefined();
  });

  it('collects at least the known workflow invocations', () => {
    const all = files.flatMap(workflowInvocations);
    for (const command of ['watch', 'revise-pr', 'watch-prs', 'doctor', 'research', 'lessons', 'approve']) expect(all.some((a) => a[0] === command), command).toBe(true);
  });

  it('docs examples', () => {
    const all = walk(join(ROOT, 'docs'), '.md').flatMap((f) => docInvocations(f).map((a) => [f, a] as const));
    expect(all.length).toBeGreaterThan(10);
    for (const [f, argv] of all) expect(refused(argv), `${f}: ${argv.join(' ')}`).toBeUndefined();
  });

  // The hub's and the desktop app's spawns, plus every flag the workflows pass, as a fixed list with the parsed result.
  it.each([
    [['doctor', '--source', 'github', '--github-repo', 'o/r', '--label', 'ready for agent', '--provider', 'claude'], { kind: 'doctor', source: 'github', repoSlug: 'o/r', label: 'ready for agent', provider: 'claude' }],
    [['watch', '--source', 'github', '--github-repo', 'o/r', '--repo', '/w', '--once', '--feedback-authors', 'a,b', '--skills', 's', '--spec-model', 'm', '--provider', 'claude', '--provider-model', 'x', '--review-provider', 'codex', '--review-model', 'y', '--escalate-model', 'z', '--flow', 'plan', '--fallback-provider', 'cursor', '--fallback-model', 'q', '--conformance', '--conformance-model', 'c', '--max-tasks', '3', '--issue', '5', '--llm-proxy'], { kind: 'watch', source: 'github', skillsDir: 's', specModel: 'm', flow: 'plan', maxTasks: 3, issue: '5', once: true, llmProxy: true }],
    [['revise-pr', '7', '--github-repo', 'o/r', '--repo', '/w', '--max-rounds', '3', '--skills', 's', '--provider', 'claude', '--provider-model', 'x', '--llm-proxy'], { kind: 'revise-pr', prRef: '7', maxRounds: 3, skillsDir: 's', providerModel: 'x', llmProxy: true }],
    [['watch-prs', '--once', '--github-repo', 'o/r', '--label', 'l', '--pr', '9', '--skills', 's', '--concurrency', '4', '--author', 'me', '--feedback-authors', 'a', '--provider', 'claude', '--review-model', 'm', '--llm-proxy'], { kind: 'watch-prs', pr: 9, concurrency: 4, author: 'me', reviewModel: 'm', llmProxy: true }],
    [['doctor-prs', '--github-repo', 'o/r', '--label', 'l', '--repo', '/w', '--provider', 'claude', '--llm-proxy'], { kind: 'doctor-prs', llmProxy: true }],
    [['research', '7', '--github-repo', 'o/r', '--repo', '/w', '--provider', 'claude', '--research-model', 'm'], { kind: 'research', researchModel: 'm' }],
    [['metrics', 'push', '--repo', '/w', '--branch', 'b'], { kind: 'metrics', branch: 'b' }],
    [['resume-rate-limited', '--github-repo', 'o/r'], { kind: 'resume-rate-limited', repoSlug: 'o/r' }],
    [['lessons', 'record', '--pr', '5', '--github-repo', 'o/r', '--feedback-authors', 'a,b'], { kind: 'lessons', action: 'record', prNumber: 5 }],
    [['approve', '--pr', '5', '--github-repo', 'o/r', '--mode', 'shadow'], { kind: 'approve', prNumber: 5, mode: 'shadow' }],
    [['eval', '--suggest', '--github-repo', 'o/r', '--since', '2026-01-01', '--out', 'd.md'], { kind: 'eval', suggest: true, out: 'd.md' }],
    [['eval', '--baseline', 'main'], { kind: 'eval', baseline: 'main' }],
    [['eval', '--json'], { kind: 'eval', json: true }],
    [['run', '--github', 'o/r#1', '--provider', 'zai', '--max-turns', '30', '--flow', 'plan', '--usage-cap', '80'], { kind: 'run', source: 'github', maxTurns: 30, flow: 'plan' }],
    [['watch', '--github-repo', 'o/r', '--concurrency', '2', '--loop-v1', '--provider', 'claude', '--max-turns', '30'], { kind: 'watch', concurrency: 2, maxTurns: 30 }],
    [['hub', '--host', '0.0.0.0', '--port', '8000', '--ui-dir', 'u', '--no-open', '--allowed-host', 'a', '--admin-github-login', 'me'], { kind: 'hub', host: '0.0.0.0', port: 8000, uiDir: 'u', open: false, allowedHosts: ['a'], adminGithubLogins: ['me'] }],
    [['doctor', '--source', 'github', '--github-repo', 'o/r', '--fix'], { kind: 'doctor', fix: true }],
    [['run', '--github', 'o/r#1', '--pnpm-store'], { kind: 'run', pnpmStore: true }],
  ])('parses %j', (argv, expected) => {
    expect(parseCli(argv, '/work')).toMatchObject(expected);
  });
});
