// Hub commands: the per-PR lessons of a repository (src/core/lessons.ts), read from its metrics branch. One module per feature —
// contract, validation and handler live here; `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { BadRequestError } from '../../sidecar/sidecar.js';
import { assertMutationsAllowed } from '../allowlist.js';
import { appendLessonRecords, LESSONS_FILE, parseLessons, selectLessons } from '../../core/lessons.js';
import { readBranchFile } from '../../core/metrics-branch.js';
import type { RepoLesson } from '../../wire.js';
import { defineCommands, optionalString, requireString, repoItemTarget } from '../command-kit.js';

export interface LessonsCommands {
  /** HUB_ONLY, read-only: the live lessons of a repo, newest first. With `taskText`, only those a task with that text would receive.
   *  `branchFound` is false when the repo has no metrics branch (or no lessons file on it) yet. */
  list_lessons: { args: { repoPath: string; taskText?: string }; result: { lessons: RepoLesson[]; branchFound: boolean } };
  /** HUB_ONLY: dismiss a lesson (same effect as `taskcell lessons dismiss <id>`): later runs no longer receive it. */
  dismiss_lesson: { args: { repoPath: string; id: string }; result: void };
}

export const commands = defineCommands<LessonsCommands>({
  list_lessons: async ({ args, allow }) => {
    const real = await allow(requireString(args, 'repoPath'));
    const text = await readBranchFile(real, { file: LESSONS_FILE });
    const live = parseLessons(text);
    const taskText = optionalString(args, 'taskText');
    const chosen = taskText === undefined ? live : selectLessons(live, taskText);
    const lessons = chosen.map(({ kind: _kind, repo: _repo, ...l }): RepoLesson => l);
    return { lessons, branchFound: text.trim() !== '' };
  },
  dismiss_lesson: async ({ ctx, args, allow }) => {
    // Writes (and pushes) the metrics branch — a remote mutation, behind the same guard as the other hub writes.
    assertMutationsAllowed(ctx.bind);
    const real = await allow(requireString(args, 'repoPath'));
    const id = requireString(args, 'id');
    const known = parseLessons(await readBranchFile(real, { file: LESSONS_FILE }));
    if (!known.some((l) => l.id === id)) throw new BadRequestError(`No live lesson with id ${id}`);
    await appendLessonRecords(real, [{ kind: 'dismiss', id, timestamp: new Date().toISOString() }]);
    return null;
  },
}, {
  dismiss_lesson: { action: 'settings-change', target: repoItemTarget('id') },
});
