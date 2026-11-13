/**
 * Generate, from the sources the desktop app and the hub cannot import across:
 *  - the desktop copy of src/wire.ts (+ the inlined `Commands`/`COMMAND_NAMES` derived from the hub
 *    command modules in src/hub/commands/) and of src/hub-wire.ts — a separate pnpm install with no
 *    import path into core;
 *  - src/hub/commands/index.ts, the merged `Commands`, `COMMAND_NAMES` and dispatch table.
 * The drift guard (src/wire.test.ts) re-derives the same bytes and compares in root CI — the
 * gen-flow-b pattern.
 *
 * Usage: pnpm gen:wire
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { commandIndexSource, desktopCommandsSource, readCommandModules } from '../src/hub/command-codegen.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['wire.ts', 'hub-wire.ts'];
const commandsDir = join(root, 'src', 'hub', 'commands');
const modules = readCommandModules(commandsDir);

writeFileSync(join(commandsDir, 'index.ts'), commandIndexSource(modules));
console.log(`wrote ${join(commandsDir, 'index.ts')}`);

for (const file of FILES) {
  const header = `// GENERATED from src/${file} — do not edit; run pnpm gen:wire\n`;
  const target = join(root, 'apps', 'desktop', 'src', file);
  const tail = file === 'wire.ts' ? desktopCommandsSource(modules) : '';
  writeFileSync(target, header + readFileSync(join(root, 'src', file), 'utf8') + tail);
  console.log(`wrote ${target}`);
}
