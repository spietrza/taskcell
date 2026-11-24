import { describe, it, expect, vi, afterEach } from 'vitest';
import { lessonsCommand } from './lessons.js';
import * as store from '../core/lessons.js';
import type { GhRunner } from '../tasks/github.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import { LESSON_MARKER } from '../runners/pr-lesson.js';

const URL = 'https://gitlab.com/g/p/-/merge_requests/4';
const FACTORY = { source_branch: 'chore/vanguard-x-1', source_project_id: 7, target_project_id: 7 };
const glabWith = (notes: unknown[], mr: object = FACTORY): GlabRunner =>
  vi.fn(async (args: string[]) => {
    if (args[1] === 'user') return JSON.stringify({ username: 'bot' });
    if (args[0] === 'api') return JSON.stringify(notes);
    if (args[1] === 'view') return JSON.stringify({ iid: 4, web_url: URL, title: 't', state: 'merged', labels: [], ...mr });
    if (args[1] === 'diff') return 'diff --git a/a.ts b/a.ts\n+x\n';
    return '';
  });
const cmd = { kind: 'lessons', action: 'record', repoPath: '/r', repoSlug: 'g/p', prNumber: 4, gitlab: true, dryRun: false } as const;

afterEach(() => vi.restoreAllMocks());

describe('lessons record for GitLab', () => {
  it('a blocking review stores lessons and notes the MR', async () => {
    const append = vi.spyOn(store, 'appendLessonRecords').mockResolvedValue({ branch: 'm', pushed: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const glab = glabWith([{ id: 1, body: 'Verdict: BLOCKING\nRisk: high — x', author: { username: 'bot' } }]);
    const model = vi.fn(async () => `<lessons>{"lessons":[{"rule":"Do the thing","why":"w","evidence":"${URL}#note_1","paths":[],"stage":"implement"}]}</lessons>`);
    await lessonsCommand(cmd, { glab, model });
    expect(append).toHaveBeenCalledOnce();
    expect(glab).toHaveBeenCalledWith(expect.arrayContaining(['mr', 'note', '4', '--repo', 'g/p']));
  });

  it('a clean merge makes no model call and records nothing', async () => {
    const append = vi.spyOn(store, 'appendLessonRecords');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const model = vi.fn(async () => '');
    await lessonsCommand(cmd, { glab: glabWith([]), model });
    expect(model).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('a fork MR makes no model call and records nothing, even with a blocking review', async () => {
    const append = vi.spyOn(store, 'appendLessonRecords');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const model = vi.fn(async () => '');
    const glab = glabWith([{ id: 1, body: 'Verdict: BLOCKING\nRisk: high — x', author: { username: 'bot' } }], { ...FACTORY, source_project_id: 9 });
    await lessonsCommand(cmd, { glab, model });
    expect(model).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(glab).not.toHaveBeenCalledWith(expect.arrayContaining(['note']));
  });
});

describe('lessons record for GitHub with TASKCELL_APP_SLUG', () => {
  const PR_URL = 'https://github.com/o/r/pull/9';
  const ghCmd = { kind: 'lessons', action: 'record', repoPath: '/r', repoSlug: 'o/r', prNumber: 9, dryRun: false } as const;
  const review = { author: { login: 'github-actions' }, authorAssociation: 'NONE', state: 'COMMENTED', body: 'Verdict: BLOCKING\nRisk: high — x' };
  const body = `APP-TEXT\n${LESSON_MARKER}`;
  // `gh pr view` reports an App comment's author as the bare slug; REST reports it as `<slug>[bot]` / `Bot`.
  const viewComment = { author: { login: 'tc' }, authorAssociation: 'CONTRIBUTOR', url: `${PR_URL}#c`, body };
  const run = async (restUser: { login: string; type: string }): Promise<{ gh: GhRunner; prompt: string }> => {
    vi.stubEnv('TASKCELL_APP_SLUG', 'tc');
    vi.spyOn(store, 'appendLessonRecords').mockResolvedValue({ branch: 'm', pushed: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const gh: GhRunner = vi.fn(async (args: string[]) => {
      if (args[1] === 'view') {
        return JSON.stringify({ number: 9, url: PR_URL, title: 't', state: 'MERGED', labels: [], files: [], additions: 1, deletions: 0, reviews: [review], comments: [viewComment] });
      }
      return args[0] === 'api' ? JSON.stringify([[{ user: restUser, body }]]) : '';
    });
    let prompt = '';
    const model = vi.fn(async (req: { prompt: string }) => {
      prompt = req.prompt;
      return `<lessons>{"lessons":[{"rule":"Do the thing","why":"w","evidence":"${PR_URL}","paths":[],"stage":"implement"}]}</lessons>`;
    });
    await lessonsCommand(ghCmd, { gh, model });
    return { gh, prompt };
  };
  afterEach(() => vi.unstubAllEnvs());

  it('an App lesson comment (REST <slug>[bot] / Bot) dedupes but never becomes a lesson note', async () => {
    const { gh, prompt } = await run({ login: 'tc[bot]', type: 'Bot' });
    expect(gh).not.toHaveBeenCalledWith(expect.arrayContaining(['comment']));
    expect(prompt).not.toContain('APP-TEXT');
  });

  it('a bare <slug> User comment with a marker is neither trusted nor used for dedupe', async () => {
    const { gh, prompt } = await run({ login: 'tc', type: 'User' });
    expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['pr', 'comment', '9']));
    expect(prompt).not.toContain('APP-TEXT');
  });
});
