import { join, resolve } from 'node:path';
import { fail } from './flags.js';
import type { ParseCtx } from './flags.js';
import type { Command } from './args.js';

/** Parse `skills`'s flags into its command; the generic checks (parseCli) have already run. */
export function parseSkillsCommand(ctx: ParseCtx): Command {
  const { values, positionals, repoPath } = ctx;
  const action = positionals[1];
  const usage =
    'skills expects a subcommand: taskcell skills list|check [--dir <skills dir>] [--strict] | add <git-url>[#ref] [--path <dir>] [--name <name>] [--dir <skills dir>] | remove <name> [--dir <skills dir>] | update [name] [--dir <skills dir>] [--dry-run] [--pr [--base <branch>]] [--force].';
  // add, remove and update write, and --pr needs the directory inside the repo: a relative --dir is
  // under --repo. list and check keep reading it as given.
  const writes = action === 'add' || action === 'remove' || action === 'update';
  const dir = typeof values.dir === 'string' ? (writes ? resolve(repoPath, values.dir) : values.dir) : join(repoPath, 'skills');
  if (action !== 'list' && action !== 'check' && action !== 'add' && action !== 'remove' && action !== 'update') return fail(usage);
  if (values.pr === true && action !== 'update') return fail('--pr is only supported with skills update.');
  if (values['dry-run'] === true && action !== 'update') return fail('--dry-run is only supported with skills update.');
  if (values.strict === true && action !== 'check') return fail('--strict only applies to skills check.');
  if ((values.path !== undefined || values.name !== undefined) && action !== 'add') return fail('--path and --name only apply to skills add.');
  if (values.force === true && action !== 'update') return fail('--force only applies to skills update.');
  if (values.base !== undefined && !(action === 'update' && values.pr === true)) return fail('--base only applies to skills update --pr.');
  if (action === 'list' || action === 'check') {
    return { kind: 'skills', action, dir, strict: values.strict === true };
  }
  if (action === 'add') {
    const target = positionals[2];
    if (target === undefined || positionals.length > 3) return fail('skills add expects one argument: <git-url>[#ref].');
    const hash = target.indexOf('#');
    const ref = hash === -1 ? '' : target.slice(hash + 1);
    if (hash !== -1 && ref === '') return fail('skills add: empty #ref.');
    return {
      kind: 'skills',
      action,
      dir,
      source: hash === -1 ? target : target.slice(0, hash),
      ...(ref !== '' ? { ref } : {}),
      ...(typeof values.path === 'string' ? { path: values.path } : {}),
      ...(typeof values.name === 'string' ? { name: values.name } : {}),
    };
  }
  if (action === 'remove') {
    const name = positionals[2];
    if (name === undefined || positionals.length > 3) return fail('skills remove expects one argument: <name>.');
    return { kind: 'skills', action, dir, name };
  }
  if (positionals.length > 3) return fail('skills update expects at most one argument: [name].');
  const name = positionals[2];
  return { kind: 'skills', action, dir, repo: repoPath, ...(name !== undefined ? { name } : {}), ...(typeof values.base === 'string' ? { baseBranch: values.base } : {}), dryRun: values['dry-run'] === true, pr: values.pr === true, force: values.force === true };
}
