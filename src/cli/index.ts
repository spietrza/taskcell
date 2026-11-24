#!/usr/bin/env node
import { parseCli, USAGE } from './args.js';
import { commandUsage, findCommand } from './commands.js';
import { runGc } from './gc.js';
import { RUNNERS } from './registry.js';
import { CliUsageError } from '../core/errors.js';
import { takeAppKey } from '../core/push-token.js';

async function main(): Promise<void> {
  // Before anything spawns: the taskcell App private key must not be inherited by docker/git/gh children.
  takeAppKey();
  const command = parseCli(process.argv.slice(2), process.cwd());
  // The cap is read from the environment at stage start, so the flag and TASKCELL_USAGE_CAP_PCT share one path.
  if (command.usageCapPct !== undefined) process.env['TASKCELL_USAGE_CAP_PCT'] = command.usageCapPct;
  if (command.kind === 'help') {
    const decl = findCommand(command.command);
    console.log(decl === undefined ? USAGE : commandUsage(decl));
    return;
  }
  if (command.kind === 'error') {
    console.error(`taskcell: ${command.message}`);
    process.exitCode = 1;
    return;
  }
  const run = RUNNERS[command.kind];
  if (run !== undefined) {
    await run(command);
    return;
  }
  if (command.kind !== 'gc') return;
  const report = await runGc(command);
  const tag = command.dryRun ? ' (dry-run)' : '';
  const remote = command.remoteRepo !== undefined ? `, ${report.branches.length} merged remote branch(es)` : '';
  console.log(`Reaped ${report.containers.length} container(s), ${report.networks.length} egress network(s)${remote}${tag}.`);
  if (report.containers.length > 0) console.log(`  containers: ${report.containers.join(', ')}`);
  if (report.networks.length > 0) console.log(`  networks: ${report.networks.join(', ')}`);
  if (report.branches.length > 0) console.log(`  branches: ${report.branches.join(', ')}`);
}

main().catch((error: unknown) => {
  if (error instanceof CliUsageError) console.error(`Error: ${error.message}`);
  else console.error(error);
  process.exit(1);
});
