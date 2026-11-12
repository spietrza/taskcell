// Stages the local hub for the installers: a Node runtime (Tauri `externalBin` "node") plus the built
// taskcell CLI with its production dependencies and the built UI (Tauri resource "taskcell"). See
// README "Local hub" for why this is a bundled Node rather than a single-executable build.
// Usage: node scripts/prepare-sidecar.mjs   (then: tauri build --config src-tauri/tauri.bundle.conf.json)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const root = join(desktop, '../..');
const tauri = join(desktop, 'src-tauri');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error('cannot read the host target triple from `rustc -vV`');

// 1. The Node runtime the hub runs on (the Node running this script: the CLI requires Node >= 24).
mkdirSync(join(tauri, 'binaries'), { recursive: true });
const ext = process.platform === 'win32' ? '.exe' : '';
const nodeDest = join(tauri, 'binaries', `node-${triple}${ext}`);
copyFileSync(process.execPath, nodeDest);
chmodSync(nodeDest, 0o755);

// 2. The CLI (dist + runtime assets), its production dependencies, and the UI the hub serves.
run('pnpm', ['build'], root);
run('pnpm', ['build'], desktop);
const stage = join(tauri, 'resources/taskcell');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of ['package.json', 'pnpm-lock.yaml', 'dist', 'templates', 'skills', 'docker']) {
  if (existsSync(join(root, entry))) cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
mkdirSync(join(stage, 'apps/desktop'), { recursive: true });
cpSync(join(desktop, 'dist'), join(stage, 'apps/desktop/dist'), { recursive: true });
run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], stage);
console.log(`staged ${stage} and ${nodeDest}`);
