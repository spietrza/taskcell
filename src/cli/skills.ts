import { TaskcellError } from '../core/errors.js';
import { oneLine, skillsAdd, skillsCheck, skillsList, skillsRemove, skillsUpdate } from '../core/skills.js';
import type { Command } from './args.js';

export type SkillsCommand = Extract<Command, { kind: 'skills' }>;

export async function skillsCommand(cmd: SkillsCommand): Promise<number> {
  try {
    if (cmd.action === 'add') {
      const { action: _a, kind: _k, ...opts } = cmd;
      await skillsAdd(opts);
      return 0;
    }
    if (cmd.action === 'remove') {
      await skillsRemove(cmd.dir, cmd.name);
      return 0;
    }
    if (cmd.action === 'update') {
      const { action: _a, kind: _k, ...opts } = cmd;
      const { prUrl } = await skillsUpdate(opts);
      if (prUrl !== undefined) console.log(`opened ${prUrl}`);
      return 0;
    }
    if (cmd.action === 'check') return await skillsCheck(cmd.dir, cmd.strict);
    await skillsList(cmd.dir);
    return 0;
  } catch (error) {
    // A bad lock or directory is a user error: one line, no stack.
    if (!(error instanceof TaskcellError)) throw error;
    // The message can quote upstream text (a file name, git's stderr).
    console.error(`taskcell skills: ${oneLine(error.message)}`);
    return 1;
  }
}
