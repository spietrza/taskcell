import { beforeEach, describe, it, expect } from 'vitest';
import { createGithubIssue, createGitlabIssue, createLinearIssue, setTaskSkills, MAX_BODY_BYTES, MAX_DEPENDS_ON, MAX_TITLE_BYTES } from './create.js';
import type { CliRunner } from './create.js';
import type { LinearGraphql } from './linear-cli.js';

describe('createGithubIssue', () => {
  it('sends the body on stdin, not argv, and returns a runnable ref + url', async () => {
    let seen: string[] = [];
    let stdin: string | undefined;
    const task = await createGithubIssue(
      '/repo',
      { title: 'Add a thing', body: '# Add a thing\n\nbody', labels: ['vanguard'] },
      async (bin, args, opts) => {
        expect(bin).toBe('gh');
        expect(opts.cwd).toBe('/repo'); // no --repo flag: gh infers from the cwd's remote
        seen = args;
        stdin = opts.stdin;
        return 'https://github.com/o/r/issues/42\n';
      },
    );
    // A doc-sized markdown body on the command line is an ARG_MAX gamble; gh lets us not take it.
    expect(seen).toContain('--body-file');
    expect(seen).toContain('-');
    expect(seen).not.toContain('# Add a thing\n\nbody'); // the body content is NOT an argv value
    expect(stdin).toBe('# Add a thing\n\nbody');
    expect(seen).toEqual(expect.arrayContaining(['--label', 'vanguard']));
    expect(task).toEqual({ id: 'o/r#42', url: 'https://github.com/o/r/issues/42' });
  });

  it('throws when gh prints no URL rather than reporting a success it cannot prove', async () => {
    await expect(
      createGithubIssue('/repo', { title: 't', body: 'b' }, async () => 'Creating issue...\n'),
    ).rejects.toThrow(/did not print an issue URL/);
  });
});

describe('createGithubIssue target-branch label', () => {
  it('creates the taskcell:base= label first, because gh issue create fails on a missing label', async () => {
    const calls: string[][] = [];
    await createGithubIssue('/repo', { title: 't', body: 'b', labels: ['ready', 'taskcell:base=dev'] }, async (_bin, args) => {
      calls.push(args);
      return 'https://github.com/o/r/issues/1\n';
    });
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['label create', 'issue create']);
    expect(calls[0]).toEqual(['label', 'create', 'taskcell:base=dev', '--force']);
    expect(calls[1]).toContain('taskcell:base=dev');
  });

  it('still files the issue when the label cannot be created (already exists, or no label permission)', async () => {
    const created = await createGithubIssue('/repo', { title: 't', body: 'b', labels: ['taskcell:base=dev'] }, async (_bin, args) => {
      if (args[0] === 'label') throw new Error('HTTP 403');
      return 'https://github.com/o/r/issues/1\n';
    });
    expect(created.id).toBe('o/r#1');
  });
});

describe('createGitlabIssue', () => {
  it('passes the description as argv (glab has no --body-file) and returns a ref + url', async () => {
    let seen: string[] = [];
    const task = await createGitlabIssue(
      '/repo',
      { title: 'T', body: 'B', labels: ['a', 'b'] },
      async (bin, args, opts) => {
        expect(bin).toBe('glab');
        expect(opts.cwd).toBe('/repo');
        seen = args;
        return 'https://gitlab.com/g/p/-/issues/7';
      },
    );
    expect(seen).not.toContain('--repo'); // inferred from cwd, not configured
    expect(seen).toEqual(expect.arrayContaining(['--description', 'B']));
    expect(seen).toEqual(expect.arrayContaining(['--label', 'a,b']));
    expect(task).toEqual({ id: 'g/p#7', url: 'https://gitlab.com/g/p/-/issues/7' });
  });
});

describe('createGitlabIssue quick actions', () => {
  it('keeps a line of the description from running as a quick action', async () => {
    let seen: string[] = [];
    await createGitlabIssue('/repo', { title: 'T', body: 'Plan\n/assign @me' }, async (_bin, args) => {
      seen = args;
      return 'https://gitlab.com/g/p/-/issues/7';
    });
    expect(seen[seen.indexOf('--description') + 1]).toBe('Plan\n\\/assign @me');
  });
});

describe('createLinearIssue', () => {
  const ok: LinearGraphql = async (body) => {
    if (body.query.includes('teams')) return { data: { teams: { nodes: [{ id: 'team-uuid' }] } } };
    return { data: { issueCreate: { success: true, issue: { identifier: 'DEV-9', url: 'https://linear.app/x/issue/DEV-9' } } } };
  };

  it('creates over GraphQL, resolving the team key to an id', async () => {
    const sent: string[] = [];
    const task = await createLinearIssue('DEV', { title: 'T', body: 'B' }, async (body) => {
      sent.push(body.query);
      return ok(body);
    });
    expect(sent[0]).toContain('teams'); // key -> uuid, because IssueCreateInput takes teamId
    expect(sent[1]).toContain('issueCreate');
    expect(task).toEqual({ id: 'DEV-9', url: 'https://linear.app/x/issue/DEV-9' });
  });

  it('refuses an unknown team key instead of creating in the wrong place', async () => {
    const graphql: LinearGraphql = async () => ({ data: { teams: { nodes: [] } } });
    await expect(createLinearIssue('NOPE', { title: 'T', body: 'B' }, graphql)).rejects.toThrow(/No Linear team/);
  });

  it('never reports a success it cannot prove', async () => {
    // The one action in the app that cannot be undone from inside it. `success: false`, or a missing
    // issue, must not surface to the user as "created" with no URL to check.
    const graphql: LinearGraphql = async (body) =>
      body.query.includes('teams')
        ? { data: { teams: { nodes: [{ id: 't' }] } } }
        : { data: { issueCreate: { success: false } } };
    await expect(createLinearIssue('DEV', { title: 'T', body: 'B' }, graphql)).rejects.toThrow(/did not confirm/i);
  });

  it('surfaces a GraphQL error', async () => {
    const graphql: LinearGraphql = async (body) =>
      body.query.includes('teams')
        ? { data: { teams: { nodes: [{ id: 't' }] } } }
        : { errors: [{ message: 'nope' }] };
    await expect(createLinearIssue('DEV', { title: 'T', body: 'B' }, graphql)).rejects.toThrow(/nope/);
  });
});

describe('input guards', () => {
  it('rejects an over-long body BEFORE calling out, so the user sees a real message not E2BIG', async () => {
    const body = 'x'.repeat(MAX_BODY_BYTES + 1);
    let called = false;
    await expect(
      createGitlabIssue('/repo', { title: 't', body }, async () => {
        called = true;
        return '';
      }),
    ).rejects.toThrow(/limit is/);
    expect(called).toBe(false); // never reached the transport
  });

  it('rejects an empty title', async () => {
    await expect(createGithubIssue('/repo', { title: '  ', body: 'b' }, async () => 'x')).rejects.toThrow(/needs a title/);
  });
});

describe('reading the issue URL out of CLI noise', () => {
  it('picks the ISSUE url, not the first url the CLI happens to print', async () => {
    // glab/gh emit project links, progress lines and warnings. Taking the first URL blindly would make a
    // SUCCESSFUL create look like a failure — and a reported failure invites the retry that files the
    // issue a SECOND time. Misreading a line must never manufacture a duplicate.
    const noisy = [
      'Warning: Multiple config files found.',
      'Creating issue in https://gitlab.com/g/p',
      '',
      'https://gitlab.com/g/p/-/issues/7',
    ].join('\n');
    const task = await createGitlabIssue('/repo', { title: 'T', body: 'B' }, async () => noisy);
    expect(task).toEqual({ id: 'g/p#7', url: 'https://gitlab.com/g/p/-/issues/7' });
  });

  it('still throws when no issue url is printed at all', async () => {
    await expect(
      createGithubIssue('/repo', { title: 't', body: 'b' }, async () => 'see https://github.com/o/r\n'),
    ).rejects.toThrow(/did not print an issue URL/);
  });
});

describe('title guard', () => {
  it('rejects an over-long title BEFORE calling out — it crosses as argv on both CLIs', async () => {
    let called = false;
    await expect(
      createGithubIssue('/repo', { title: 'x'.repeat(MAX_TITLE_BYTES + 1), body: 'b' }, async () => {
        called = true;
        return '';
      }),
    ).rejects.toThrow(/title is .* limit is/);
    expect(called).toBe(false); // a raw E2BIG on the irreversible path tells the user nothing
  });
});

describe('setTaskSkills', () => {
  const calls: { bin: string; args: string[]; stdin?: string }[] = [];
  const cli = (out: string): CliRunner => async (bin, args, opts) => {
    calls.push({ bin, args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    return out;
  };
  beforeEach(() => calls.splice(0));

  it('GitHub: reads the body and writes it back over stdin with only the Skills: line changed', async () => {
    await setTaskSkills('/repo', 'gh-7', ['db', 'release'], cli(JSON.stringify({ body: 'Fix it\n\nSkills: old' })));
    expect(calls).toEqual([
      { bin: 'gh', args: ['issue', 'view', '7', '--json', 'body'] },
      { bin: 'gh', args: ['issue', 'edit', '7', '--body-file', '-'], stdin: 'Fix it\n\nSkills: db, release' },
    ]);
  });

  it('GitLab: the description goes back as stored, with the line appended', async () => {
    await setTaskSkills('/repo', 'gl-3', ['db'], cli(JSON.stringify({ description: 'run /usr/bin/x\n/usr/bin/y' })));
    expect(calls[1]).toEqual({ bin: 'glab', args: ['issue', 'update', '3', '--description', 'run /usr/bin/x\n/usr/bin/y\n\nSkills: db\n'] });
  });

  it('GitLab: a description holding a quick-action line is refused before any write', async () => {
    await expect(setTaskSkills('/repo', 'gl-3', ['db'], cli(JSON.stringify({ description: 'text\n/close\n' })))).rejects.toThrow('quick action');
    expect(calls).toHaveLength(1);
  });

  it('GitLab: a quick action anywhere, fenced or not, is refused (fail closed)', async () => {
    for (const description of ['run:\n```sh\n/close\n```\n', '~~~\n```\n~~~\n/close\n```\nx\n```\n', '```\ncode\n ```\n/close\n```\nx\n```\n', '```\n/close\n``` \ntext\n']) {
      await expect(setTaskSkills('/repo', 'gl-3', ['db'], cli(JSON.stringify({ description })))).rejects.toThrow(/quick action|could not be written/);
    }
    expect(calls.every((c) => c.args[1] === 'view')).toBe(true);
  });

  it('refuses a body whose unclosed code block would swallow the line', async () => {
    await expect(setTaskSkills('/repo', 'gh-7', ['db'], cli(JSON.stringify({ body: 'text\n```\ncode' })))).rejects.toThrow('could not be written');
    expect(calls).toHaveLength(1);
  });

  it('writes nothing when the line already says so', async () => {
    await setTaskSkills('/repo', 'gh-7', ['db'], cli(JSON.stringify({ body: 'Skills: db' })));
    expect(calls).toHaveLength(1);
  });

  it('Linear: updates the description over GraphQL and needs the update confirmed', async () => {
    const sent: Record<string, unknown>[] = [];
    const graphql = async (body: { query: string; variables: Record<string, unknown> }): Promise<unknown> => {
      sent.push(body.variables);
      return body.query.startsWith('query') ? { data: { issue: { description: 'x\nSkills: a' } } } : { data: { issueUpdate: { success: sent.length === 2 } } };
    };
    await setTaskSkills('/repo', 'linear-dev-9', [], cli(''), graphql);
    expect(sent).toEqual([{ id: 'DEV-9' }, { id: 'DEV-9', d: 'x' }]);
    await expect(setTaskSkills('/repo', 'linear-dev-9', ['b'], cli(''), graphql)).rejects.toThrow('did not confirm');
  });

  it('refuses an id of no tracker', async () => {
    await expect(setTaskSkills('/repo', 'draft-1', ['a'], cli(''))).rejects.toThrow("Couldn't resolve a Task Source");
    expect(calls).toHaveLength(0);
  });
});

describe('dependsOn', () => {
  it('writes a Depends on line and a native GitHub relation', async () => {
    const calls: string[][] = [];
    let stdin: string | undefined;
    await createGithubIssue('/repo', { title: 't', body: 'b', dependsOn: ['o/r#3'] }, async (_bin, args, opts) => {
      calls.push(args);
      stdin = opts.stdin ?? stdin;
      return args[0] === 'issue' ? 'https://github.com/o/r/issues/9\n' : '555\n';
    });
    expect(stdin).toBe('b\n\nDepends on o/r#3\n');
    expect(calls.at(-1)).toEqual(['api', '-X', 'POST', 'repos/o/r/issues/9/dependencies/blocked_by', '-F', 'issue_id=555']);
  });

  it('keeps the issue when relations are unavailable, and rejects a malformed ref', async () => {
    const task = await createGithubIssue('/repo', { title: 't', body: 'b', dependsOn: ['o/r#3'] }, async (_bin, args) => {
      if (args[0] === 'api') throw new Error('HTTP 404');
      return 'https://github.com/o/r/issues/9\n';
    });
    expect(task.id).toBe('o/r#9');
    await expect(createGithubIssue('/repo', { title: 't', body: 'b', dependsOn: ['x\nDepends on #1'] }, async () => '')).rejects.toThrow(/is not a github task reference/);
  });

  it('puts the Depends on line in a GitLab description and links the blocker by its plain project path', async () => {
    let desc = '';
    const calls: string[][] = [];
    await createGitlabIssue('/repo', { title: 't', body: 'b', dependsOn: ['g/sub/p#2'] }, async (_bin, args) => {
      calls.push(args);
      if (args[0] === 'issue') desc = args[args.indexOf('--description') + 1]!;
      return 'https://gitlab.com/g/p/-/issues/7\n';
    });
    expect(desc).toContain('Depends on g/sub/p#2');
    // The project in the path is URL-encoded; the target project is a field, which glab encodes itself.
    expect(calls.at(-1)).toEqual(['api', '-X', 'POST', 'projects/g%2Fp/issues/7/links', '-f', 'target_project_id=g/sub/p', '-f', 'target_issue_iid=2', '-f', 'link_type=is_blocked_by']);
  });

  it('writes the line and a "blocks" relation on Linear, and keeps the issue when the relation fails', async () => {
    const sent: { query: string; variables?: Record<string, unknown> }[] = [];
    const task = await createLinearIssue('ENG', { title: 't', body: 'b  \n\n', dependsOn: ['ENG-3'] }, async (req) => {
      sent.push(req as (typeof sent)[number]);
      if (req.query.includes('teams(')) return { data: { teams: { nodes: [{ id: 'team-1' }] } } };
      if (req.query.includes('issueRelationCreate')) throw new Error('relation refused');
      return { data: { issueCreate: { success: true, issue: { identifier: 'ENG-9', url: 'https://linear.app/x/issue/ENG-9' } } } };
    });
    expect(task.id).toBe('ENG-9');
    expect(sent[1]!.variables).toMatchObject({ i: { description: 'b\n\nDepends on ENG-3\n' } });
    expect(sent[2]!.variables).toEqual({ i: { issueId: 'ENG-3', relatedIssueId: 'ENG-9', type: 'blocks' } });
  });

  it('rejects refs of another source, path tricks and too many dependencies before anything is created', async () => {
    let ran = false;
    const run = async (): Promise<string> => ((ran = true), '');
    for (const dep of ['o/../r#3', '../r#3', 'ENG-3', 'g/sub/p#3', '#3']) {
      await expect(createGithubIssue('/repo', { title: 't', body: 'b', dependsOn: [dep] }, run)).rejects.toThrow(/task reference/);
    }
    await expect(createGitlabIssue('/repo', { title: 't', body: 'b', dependsOn: ['g/../p#3'] }, run)).rejects.toThrow(/task reference/);
    await expect(createLinearIssue('ENG', { title: 't', body: 'b', dependsOn: ['o/r#3'] }, async () => ((ran = true), {}))).rejects.toThrow(/task reference/);
    await expect(createGithubIssue('/repo', { title: 't', body: 'b', dependsOn: Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => `o/r#${i + 1}`) }, run)).rejects.toThrow(/at most/);
    expect(ran).toBe(false);
  });

  it('does not pass a blocker id that is not a number to -F', async () => {
    const calls: string[][] = [];
    await createGithubIssue('/repo', { title: 't', body: 'b', dependsOn: ['o/r#3'] }, async (_bin, args) => {
      calls.push(args);
      return args[0] === 'issue' ? 'https://github.com/o/r/issues/9\n' : '@/etc/passwd\n';
    });
    expect(calls.some((a) => a.includes('-F'))).toBe(false);
  });
});
