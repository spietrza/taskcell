#!/usr/bin/env node
// Compatibility alias: the pre-rename `vanguard` bin. A separate entry file because pnpm's global
// shims run `node …/index.js`, so argv[1] never carries the alias name.
process.stderr.write('vanguard: deprecated name, use `taskcell` instead.\n');
await import('./index.js');
