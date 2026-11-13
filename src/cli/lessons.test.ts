import { describe, it, expect, vi, afterEach } from 'vitest';
import { lessonsCommand } from './lessons.js';
import * as store from '../core/lessons.js';
import type { GlabRunner } from '../tasks/gitlab.js';

const URL = 'https://gitlab.com/g/p/-/merge_requests/4';
const glabWith = (notes: unknown[]): GlabRunner =>
  vi.fn(async (args: string[]) => {
    if (args[1] === 'user') return JSON.stringify({ username: 'bot' });
    if (args[0] === 'api') return JSON.stringify(notes);
    if (args[1] === 'view') return JSON.stringify({ iid: 4, web_url: URL, title: 't', state: 'merged', labels: [] });
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
    expect(glab).toHaveBeenCalledWith(expect.arrayContaining(['mr', 'note', 'create', '4', '--repo', 'g/p']));
  });

  it('a clean merge makes no model call and records nothing', async () => {
    const append = vi.spyOn(store, 'appendLessonRecords');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const model = vi.fn(async () => '');
    await lessonsCommand(cmd, { glab: glabWith([]), model });
    expect(model).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
