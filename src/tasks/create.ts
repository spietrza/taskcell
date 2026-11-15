import { execa } from 'execa';
import { BASE_LABEL_PREFIX } from '../core/base-branch.js';
import { TaskcellError } from '../core/errors.js';
import { parseSkillsLine, setSkillsLine } from '../context/named-skills.js';
import { resolveTaskRef } from './board.js';
import { linearGraphql } from './linear-cli.js';
import { neutralizeQuickActions } from './gitlab.js';
import type { LinearGraphql } from './linear-cli.js';

/** What a new task carries. `labels` are applied at creation; the transport decides what that means. */
export interface CreateTaskInput {
  title: string;
  body: string;
  labels?: string[];
  /**
   * Tasks this one depends on, as the ids `create*Issue` returns (`o/r#12`, `g/p#12`, `ENG-12`), at most
   * MAX_DEPENDS_ON. Written as a `Depends on` line, which the GitHub and GitLab dependency gates read, and,
   * best effort, as a native relation. Linear has no dependency gate yet: there the line and the "blocks"
   * relation are for people.
   */
  dependsOn?: string[];
}

// CreatedTask lives in src/wire.ts (the shared desktop contract — S7).
export type { CreatedTask } from '../wire.js';
import type { CreatedTask } from '../wire.js';

// MAX_BODY_BYTES / MAX_TITLE_BYTES live in src/wire.ts (S7) — enforced BEFORE any request here.
export { MAX_BODY_BYTES, MAX_TITLE_BYTES } from '../wire.js';
import { MAX_BODY_BYTES, MAX_TITLE_BYTES } from '../wire.js';


/**
 * Runs `gh`/`glab` **in the repo directory**, optionally piping stdin.
 *
 * No `--repo`/`--project` flag: both CLIs infer the repository from the cwd's git remote (their
 * `--repo` flag exists to select *another* one). That is how the desktop board already shells them, and
 * it means neither transport needs a slug from config — which matters, because `AppConfig` has no
 * project field and there is no GitLab slug detector anywhere in core. Inferring is not a shortcut here;
 * it is the only option that works for both.
 */
export type CliRunner = (bin: 'gh' | 'glab', args: string[], opts: { cwd: string; stdin?: string }) => Promise<string>;

/**
 * Bound on the CLI itself, so a dead network fails instead of wedging the caller forever.
 *
 * The sidecar deliberately does NOT kill this exchange (see `Bound::Untimed`) — a kill mid-response
 * cannot un-create an issue. But with no bound anywhere, a hung `gh` holds the query pipe until the app
 * is restarted. So the bound lives HERE, at the transport, and is generous: a create that has not
 * returned in two minutes is not coming back. It carries the same ambiguity as any other failure — the
 * issue may already exist — which is exactly what the UI now tells the user, so nothing new is hidden.
 */
const CLI_TIMEOUT_MS = 120_000;

const defaultCli: CliRunner = async (bin, args, opts) =>
  (
    await execa(bin, args, {
      cwd: opts.cwd,
      timeout: CLI_TIMEOUT_MS,
      ...(opts.stdin === undefined ? {} : { input: opts.stdin }),
    })
  ).stdout;

/** Each dependency costs up to two sequential CLI calls after the create. */
export const MAX_DEPENDS_ON = 20;

type Source = 'github' | 'gitlab' | 'linear';
// Path segments are name characters and never dot-only (`..`): the ref goes into an API path.
const SEGMENT = '(?!\\.+(?:[/#]|$))[\\w.-]+';
const DEP_REF_RE: Record<Source, RegExp> = {
  github: new RegExp(`^${SEGMENT}/${SEGMENT}#\\d+$`),
  gitlab: new RegExp(`^${SEGMENT}(?:/${SEGMENT})+#\\d+$`),
  linear: /^[A-Z][A-Z0-9]*-\d+$/,
};

/**
 * The body with a trailing `Depends on` line for `input.dependsOn`. The raw input is size-checked first; the
 * refs are shape-checked for the source, so a value cannot smuggle text into the body or a path into an API call.
 */
function bodyWithDependencies(input: CreateTaskInput, source: Source): string {
  assertCreatable(input);
  const deps = input.dependsOn ?? [];
  if (deps.length === 0) return input.body;
  if (deps.length > MAX_DEPENDS_ON) throw new TaskcellError(`A task can depend on at most ${MAX_DEPENDS_ON} tasks (got ${deps.length}).`);
  const bad = deps.find((d) => !DEP_REF_RE[source].test(d));
  if (bad !== undefined) throw new TaskcellError(`"${bad.slice(0, 80)}" is not a ${source} task reference (expected ${source === 'linear' ? 'TEAM-N' : source === 'gitlab' ? 'group/project#N' : 'owner/repo#N'}).`);
  const body = `${input.body.trimEnd()}\n\nDepends on ${deps.join(', ')}\n`;
  assertCreatable({ ...input, body });
  return body;
}

function assertCreatable(input: CreateTaskInput): void {
  if (input.title.trim() === '') throw new TaskcellError('A task needs a title.');
  const titleBytes = Buffer.byteLength(input.title, 'utf8');
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new TaskcellError(`Task title is ${titleBytes} bytes; the limit is ${MAX_TITLE_BYTES}. Shorten the heading.`);
  }
  const bytes = Buffer.byteLength(input.body, 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new TaskcellError(`Task body is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}. Shorten the document.`);
  }
}

/**
 * The new issue's URL in some CLI output.
 *
 * Matches the ISSUE-shaped URL, not merely the first URL of any kind: `gh`/`glab` also emit project
 * links, progress lines and warnings. Taking the first URL blindly would make a SUCCESSFUL create look
 * like a failure ("returned a URL this does not understand") — and a reported failure invites the retry
 * that files the issue a second time. Reading the wrong line must never manufacture a duplicate.
 */
function issueUrl(stdout: string, what: string): string {
  const match = stdout.match(/https?:\/\/\S*\/issues\/\d+/);
  if (match === null) throw new TaskcellError(`${what} did not print an issue URL: ${stdout.trim().slice(0, 200)}`);
  return match[0];
}

/** `https://github.com/o/r/issues/42` -> `o/r#42`; `https://gitlab.com/g/p/-/issues/7` -> `g/p#7`. */
function refFromIssueUrl(url: string, what: string): string {
  const m = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\/-)?\/issues\/(\d+)/);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new TaskcellError(`${what} returned a URL this does not understand: ${url}`);
  }
  return `${m[1]}#${m[2]}`;
}

/** Native "blocked by" relations for a new GitHub issue. Best effort: the `Depends on` line already in the body is the fallback where relations are unavailable. */
async function linkGithubBlockers(repoPath: string, id: string, deps: string[], run: CliRunner): Promise<void> {
  const [repo, number] = id.split('#') as [string, string];
  for (const dep of deps) {
    const [depRepo, depNumber] = dep.split('#') as [string, string];
    try {
      const blockerId = (await run('gh', ['api', `repos/${depRepo}/issues/${depNumber}`, '--jq', '.id'], { cwd: repoPath })).trim();
      // `-F` reads a file for a value starting with `@`.
      if (!/^\d+$/.test(blockerId)) continue;
      await run('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${number}/dependencies/blocked_by`, '-F', `issue_id=${blockerId}`], { cwd: repoPath });
    } catch {
      // Relations unavailable on this host/plan, or the blocker is in a repo this token cannot read.
    }
  }
}

/** Native "is blocked by" links for a new GitLab issue (Premium; on Free the `Depends on` line in the description carries it). Best effort. */
async function linkGitlabBlockers(repoPath: string, id: string, deps: string[], run: CliRunner): Promise<void> {
  const [project, iid] = id.split('#') as [string, string];
  for (const dep of deps) {
    const [depProject, depIid] = dep.split('#') as [string, string];
    try {
      // The target project goes as a field, which glab encodes itself: the plain path, not a pre-encoded one.
      await run('glab', ['api', '-X', 'POST', `projects/${encodeURIComponent(project)}/issues/${iid}/links`, '-f', `target_project_id=${depProject}`, '-f', `target_issue_iid=${depIid}`, '-f', 'link_type=is_blocked_by'], { cwd: repoPath });
    } catch {
      // Not supported on this tier.
    }
  }
}

/**
 * Create a GitHub issue. The body goes over **stdin** (`--body-file -`), not argv: a doc-sized markdown
 * body on the command line is an ARG_MAX gamble, and `gh` gives us a clean way not to take it.
 */
export async function createGithubIssue(
  repoPath: string,
  input: CreateTaskInput,
  run: CliRunner = defaultCli,
): Promise<CreatedTask> {
  const body = bodyWithDependencies(input, 'github');
  const args = ['issue', 'create', '--title', input.title, '--body-file', '-'];
  for (const label of input.labels ?? []) {
    // `gh issue create --label` fails on a label that does not exist; a card's target branch is a new one per branch.
    // Tolerant like addPrGateLabel: the label may already exist and the token may not manage labels;
    // `gh issue create` is the step that must succeed.
    if (label.startsWith(BASE_LABEL_PREFIX)) await run('gh', ['label', 'create', label, '--force'], { cwd: repoPath }).catch(() => undefined);
    args.push('--label', label);
  }
  const url = issueUrl(await run('gh', args, { cwd: repoPath, stdin: body }), 'gh issue create');
  const id = refFromIssueUrl(url, 'gh issue create');
  await linkGithubBlockers(repoPath, id, input.dependsOn ?? [], run);
  return { id, url };
}

/**
 * Create a GitLab issue. `glab` has **no** `--body-file`, so the description crosses as an argv value —
 * safe from injection (execa passes an array, never a shell) but bounded by ARG_MAX, which is why
 * MAX_BODY_BYTES exists.
 */
export async function createGitlabIssue(
  repoPath: string,
  input: CreateTaskInput,
  run: CliRunner = defaultCli,
): Promise<CreatedTask> {
  const body = bodyWithDependencies(input, 'gitlab');
  const args = ['issue', 'create', '--title', input.title, '--description', neutralizeQuickActions(body)];
  const labels = input.labels ?? [];
  if (labels.length > 0) args.push('--label', labels.join(','));
  const url = issueUrl(await run('glab', args, { cwd: repoPath }), 'glab issue create');
  const id = refFromIssueUrl(url, 'glab issue create');
  await linkGitlabBlockers(repoPath, id, input.dependsOn ?? [], run);
  return { id, url };
}

const CREATE_MUTATION = `mutation($i: IssueCreateInput!) {
  issueCreate(input: $i) { success issue { identifier url } }
}`;
const RELATION_MUTATION = `mutation($i: IssueRelationCreateInput!) {
  issueRelationCreate(input: $i) { success }
}`;
const TEAM_QUERY = `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`;

interface TeamResp {
  data?: { teams?: { nodes?: { id?: string }[] } };
}
interface CreateResp {
  data?: { issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } };
  errors?: { message?: string }[];
}

/**
 * Create a Linear issue over **GraphQL**, not the CLI.
 *
 * `linear issue create` exists but has **no `--json`** — its output is human prose, so recovering the new
 * issue's identifier and URL would mean scraping it. That is the same mistake that left
 * `LinearCliTaskFetcher.list()` shelling a command which does not exist (see its note). The API returns
 * `{ identifier, url }` structurally, and does not change shape between CLI versions.
 */
export async function createLinearIssue(
  team: string,
  input: CreateTaskInput,
  graphql?: LinearGraphql,
): Promise<CreatedTask> {
  const body = bodyWithDependencies(input, 'linear');
  const send = graphql ?? (await linearGraphql());

  // IssueCreateInput takes a teamId (a uuid), not the team key the user configures — so resolve it.
  const teams = (await send({ query: TEAM_QUERY, variables: { key: team } })) as TeamResp;
  const teamId = teams.data?.teams?.nodes?.[0]?.id;
  if (teamId === undefined) {
    throw new TaskcellError(`No Linear team with key \`${team}\` — check the team key in Settings.`);
  }

  // NOTE: `input.labels` is ignored here. IssueCreateInput takes `labelIds` (uuids), not the names
  // GitHub/GitLab accept, so honouring them needs a name->id round-trip this does not do. The sidecar
  // does not pass labels for Linear at all, so nothing is silently dropped on the way in — but if you
  // ever pass them here, they will NOT be applied. Resolve them to ids first.
  const created = (await send({
    query: CREATE_MUTATION,
    variables: { i: { teamId, title: input.title, description: body } },
  })) as CreateResp;
  const errors = created.errors;
  if (errors !== undefined && errors.length > 0) {
    throw new TaskcellError(`Linear API error: ${errors.map((e) => e.message ?? '').join('; ')}`);
  }
  const issue = created.data?.issueCreate?.issue;
  if (created.data?.issueCreate?.success !== true || issue?.identifier === undefined || issue.url === undefined) {
    // Never report success we cannot prove: the caller is about to tell a human "created", and this is
    // the one action in the app that cannot be undone from inside it.
    throw new TaskcellError('Linear did not confirm the issue was created.');
  }
  // Native relation: the dependency "blocks" the new issue. Best effort, like the other sources; the `Depends on` line stays in the description.
  for (const dep of input.dependsOn ?? []) {
    await send({ query: RELATION_MUTATION, variables: { i: { issueId: dep, relatedIssueId: issue.identifier, type: 'blocks' } } }).catch(() => undefined);
  }
  return { id: issue.identifier, url: issue.url };
}

const DESCRIPTION_QUERY = `query($id: String!) { issue(id: $id) { description } }`;
const DESCRIPTION_MUTATION = `mutation($id: String!, $d: String!) { issueUpdate(id: $id, input: { description: $d }) { success } }`;

/**
 * Write a card's hand-picked skills to its task as the body's `Skills:` line (an empty list removes
 * it), in whichever tracker the board id names. The body is read first and only that line changes.
 * A GitLab description holding a quick-action line is refused: saved as the hub's identity it would run with
 * the hub's rights, and neutralising it would rewrite the author's text.
 */
export async function setTaskSkills(
  repoPath: string,
  taskId: string,
  skills: readonly string[],
  run: CliRunner = defaultCli,
  graphql?: LinearGraphql,
): Promise<{ skills: string[] }> {
  const resolved = resolveTaskRef(taskId);
  if (resolved === undefined) throw new TaskcellError(`Couldn't resolve a Task Source from task id \`${taskId}\`.`);
  const { source, reference } = resolved;
  const next = (body: string): string | undefined => {
    // The stored body is the tracker's (untrusted): size first, setSkillsLine rescans it per Skills: line.
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new TaskcellError(`Task body is over the ${MAX_BODY_BYTES}-byte limit; edit its Skills: line on the tracker.`);
    const out = setSkillsLine(body, skills);
    if (out === body) return undefined;
    const bytes = Buffer.byteLength(out, 'utf8');
    if (bytes > MAX_BODY_BYTES) throw new TaskcellError(`Task body would be ${bytes} bytes; the limit is ${MAX_BODY_BYTES}.`);
    // An unclosed code fence swallows the appended line: the run would not read what the card shows.
    if (parseSkillsLine(out).skills.join() !== skills.join()) throw new TaskcellError('The Skills: line could not be written where a run reads it (unclosed code block?); edit it on the tracker.');
    return out;
  };
  if (source === 'linear') {
    if (!/^[A-Z0-9]+-\d+$/.test(reference)) throw new TaskcellError(`Invalid Linear id in task \`${taskId}\`.`);
    const send = graphql ?? (await linearGraphql());
    const read = (await send({ query: DESCRIPTION_QUERY, variables: { id: reference } })) as { data?: { issue?: { description?: string | null } | null } };
    if (read.data?.issue == null) throw new TaskcellError(`Linear issue ${reference} was not found.`);
    const body = next(read.data.issue.description ?? '');
    if (body !== undefined) {
      const done = (await send({ query: DESCRIPTION_MUTATION, variables: { id: reference, d: body } })) as { data?: { issueUpdate?: { success?: boolean } } };
      if (done.data?.issueUpdate?.success !== true) throw new TaskcellError('Linear did not confirm the issue was updated.');
    }
  } else if (source === 'gitlab') {
    const issue = JSON.parse(await run('glab', ['issue', 'view', reference, '--output', 'json'], { cwd: repoPath })) as { description?: string | null };
    const body = next(issue.description ?? '');
    // shortcut: fenced lines are refused too (fail closed); track fences if that turns out to bother users.
    if (body !== undefined && /^[ \t]*\/[a-z_]+([ \t]|$)/im.test(body)) {
      throw new TaskcellError('This GitLab issue has a line starting with `/` (a quick action); edit its Skills: line on GitLab instead.');
    }
    if (body !== undefined) await run('glab', ['issue', 'update', reference, '--description', body], { cwd: repoPath });
  } else {
    const issue = JSON.parse(await run('gh', ['issue', 'view', reference, '--json', 'body'], { cwd: repoPath })) as { body?: string | null };
    const body = next(issue.body ?? '');
    if (body !== undefined) await run('gh', ['issue', 'edit', reference, '--body-file', '-'], { cwd: repoPath, stdin: body });
  }
  return { skills: [...skills] };
}
