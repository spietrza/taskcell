#!/usr/bin/env tsx
// Tail of `pnpm verify:gate`: runs desktop/mobile verification only when the diff vs the merge base touches them.
import { execa } from 'execa';
import { gateScope } from '../src/core/gate-scope.js';

async function changedFiles(): Promise<string[] | undefined> {
  const refs = [process.env.TASKCELL_BASE_REF, 'origin/main', 'main'].filter((r): r is string => !!r);
  for (const ref of refs) {
    const base = await execa('git', ['merge-base', ref, 'HEAD'], { reject: false });
    if (base.exitCode !== 0) continue;
    // Committed, staged and unstaged changes against the merge base, plus untracked files.
    const diff = await execa('git', ['diff', '--name-only', base.stdout.trim()], { reject: false });
    const untracked = await execa('git', ['ls-files', '--others', '--exclude-standard'], { reject: false });
    if (diff.exitCode === 0 && untracked.exitCode === 0) return `${diff.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean);
  }
  return undefined;
}

async function main(): Promise<void> {
  const changed = await changedFiles();
  // No usable base: verify everything rather than skip silently.
  const scope = changed ? gateScope(changed) : { desktop: true, mobile: true };
  for (const [name, on] of [['verify:desktop', scope.desktop], ['verify:mobile', scope.mobile]] as const) {
    if (!on) { console.log(`verify:gate: skipping ${name} (not touched)`); continue; }
    await execa('pnpm', [name], { stdio: 'inherit' });
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
