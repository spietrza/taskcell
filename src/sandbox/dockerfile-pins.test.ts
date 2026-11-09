import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

// Guards the "never `latest`" contract the Dockerfile's own comment states: every `npm install -g`
// package must carry an explicit version (literal or `${ARG}`), so a rebuild can't silently pull a
// new (or hijacked) release of a global CLI like pnpm/bun that nothing else in the repo pins.
const DOCKERFILE_PATH = new URL('../../docker/Dockerfile', import.meta.url);

/** Package specs passed to every `npm install -g` invocation in the Dockerfile, e.g. `pnpm@10.32.1`. */
function npmGlobalInstallArgs(dockerfile: string): string[] {
  const specs: string[] = [];
  const regex = /npm install -g((?:[ \t]*\\\r?\n|[^\n])*)/g;
  for (const match of dockerfile.matchAll(regex)) {
    const tokens = (match[1] ?? '')
      .split(/\\\r?\n|[ \t]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of tokens) {
      if (token === '&&' || /^[<>|]/.test(token)) break;
      specs.push(token);
    }
  }
  return specs;
}

/** Build-argument defaults declared as `ARG NAME=value` in the Dockerfile. */
function parseArgDefaults(dockerfile: string): Map<string, string> {
  return new Map([...dockerfile.matchAll(/^ARG (\w+)=(.*)$/gm)].map((match) => [match[1]!, match[2]!]));
}

/** Resolve build-argument defaults before checking for an exact release version. */
function isPinned(spec: string, argDefaults: Map<string, string>): boolean {
  const resolved = spec.replace(/\$\{(\w+)\}/g, (_, name: string) => argDefaults.get(name) ?? '');
  return /^(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(resolved);
}

/** The Dockerfile's contents and the npm-install specs parsed out of it. */
async function readDockerfileSpecs(): Promise<{ dockerfile: string; specs: string[] }> {
  const dockerfile = await readFile(DOCKERFILE_PATH, 'utf8');
  return { dockerfile, specs: npmGlobalInstallArgs(dockerfile) };
}

describe('docker/Dockerfile npm global installs', () => {
  it.each([
    ['pnpm@12.18.0', true],
    ['@scope/cli@1.2.3-rc.1', true],
    ['bun@${BUN_VERSION}', true],
    ['pnpm', false],
    ['@scope/cli', false],
    ['pnpm@', false],
    ['pnpm@latest', false],
    ['pnpm@^12.18.0', false],
    ['bun@${MISSING}', false],
    ['bun@${FLOATING}', false],
  ])('checks exact versions: %s', (spec, expected) => {
    const argDefaults = parseArgDefaults('ARG BUN_VERSION=1.4.4\nARG FLOATING=latest');
    expect(isPinned(spec, argDefaults)).toBe(expected);
  });

  it('pins every `npm install -g` package to an exact version', async () => {
    const { dockerfile, specs } = await readDockerfileSpecs();

    expect(specs.length).toBeGreaterThan(0);
    const argDefaults = parseArgDefaults(dockerfile);
    const unpinned = specs.filter((spec) => !isPinned(spec, argDefaults));
    expect(unpinned).toEqual([]);
  });

  it('pins pnpm and bun specifically (regression: both used to install unpinned)', async () => {
    const { specs } = await readDockerfileSpecs();

    const pnpm = specs.find((spec) => spec.startsWith('pnpm@'));
    const bun = specs.find((spec) => spec.startsWith('bun@'));
    expect(pnpm).toBeDefined();
    expect(bun).toBeDefined();
  });
});
