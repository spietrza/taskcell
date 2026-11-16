import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

// Guards the "never `latest`, always hash-checked" contract: every global CLI in the images comes from a
// committed docker/cli/<name>/package.json + package-lock.json installed with `npm ci`, never from a bare
// `npm install -g`, which resolves (and trusts) whatever the registry serves at build time.
const DOCKER_DIR = new URL('../../docker/', import.meta.url);
const DOCKERFILES = ['Dockerfile', 'hub.Dockerfile', 'runner.Dockerfile'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

const read = (file: string): Promise<string> => readFile(new URL(file, DOCKER_DIR), 'utf8');

/** True when `dockerfile` installs a package globally with npm (install/i/add, any flags, `--global`). */
function hasGlobalNpmInstall(dockerfile: string): boolean {
  const instructions = dockerfile.replace(/\\\r?\n/g, ' ').split('\n').filter((line) => !line.trimStart().startsWith('#'));
  return instructions.some((line) => /\bnpm\s+(?:install|i|add)\b[^&;|]*(?:\s-g\b|\s--global\b)/.test(line));
}

interface CliLock {
  packages: Record<string, { version?: string; integrity?: string }>;
}

describe('hasGlobalNpmInstall', () => {
  it.each([
    ['RUN npm install -g pnpm@10.32.1', true],
    ['RUN /tmp/retry.sh 5 15 -- npm install -g bun@${BUN_VERSION} && npm cache clean --force', true],
    ['RUN npm i -g pnpm', true],
    ['RUN npm install --global pnpm', true],
    ['RUN npm install --no-audit -g \\\n    pnpm', true],
    ['RUN npm ci --prefix /opt/cli/pnpm', false],
    ['# npm install -g pnpm (never do this)', false],
    ['RUN npm ci --prefix /opt/cli/x && ln -s /a/* /b/ # no -g here', false],
  ])('%s -> %s', (line, expected) => {
    expect(hasGlobalNpmInstall(line)).toBe(expected);
  });
});

describe('Dockerfile npm installs', () => {
  it.each(DOCKERFILES)('%s has no bare `npm install -g`', async (file) => {
    expect(hasGlobalNpmInstall(await read(file))).toBe(false);
  });

  it('installs each sandbox CLI with `npm ci` from its committed directory, one layer each', async () => {
    const dockerfile = await read('Dockerfile');
    const installs = [...dockerfile.matchAll(/npm ci --prefix \/opt\/cli\/(\w+)/g)].map((m) => m[1]);
    expect(installs).toEqual(['pnpm', 'bun', 'codex', 'linear', 'claude']);
    for (const name of installs) expect(dockerfile).toContain(`COPY cli/${name} /opt/cli/${name}`);
    // Version bumps must not invalidate earlier layers, and no npm cache may be committed into one.
    const layers = dockerfile.replace(/\\\r?\n/g, ' ').split('\n').filter((line) => /^RUN .*npm ci/.test(line) && !line.includes('linear'));
    expect(layers).toHaveLength(4);
    for (const layer of layers) expect(layer).toContain('npm cache clean --force && rm -rf /root/.npm');
  });

  it.each(['hub.Dockerfile', 'runner.Dockerfile'])('%s installs the same committed pnpm directory as the sandbox', async (file) => {
    expect(await read(file)).toContain('COPY docker/cli/pnpm /opt/cli/pnpm');
  });
});

describe('docker/cli lockfiles', () => {
  it('has a manifest pinning one exact version and a lockfile with integrity hashes for every CLI', async () => {
    const names = await readdir(new URL('cli/', DOCKER_DIR));
    expect([...names].sort()).toEqual(['bun', 'claude', 'codex', 'linear', 'pnpm']);
    for (const name of names) {
      const manifest = JSON.parse(await read(`cli/${name}/package.json`)) as { dependencies: Record<string, string> };
      const entries = Object.entries(manifest.dependencies);
      expect(entries, name).toHaveLength(1);
      const [pkg, version] = entries[0]!;
      expect(version, `${name}: ${pkg}`).toMatch(EXACT_VERSION);

      const lock = JSON.parse(await read(`cli/${name}/package-lock.json`)) as CliLock;
      expect(lock.packages[`node_modules/${pkg}`]?.version, `${name} lock`).toBe(version);
      const unhashed = Object.entries(lock.packages).filter(([path, p]) => path !== '' && p.integrity === undefined);
      expect(unhashed.map(([path]) => path), `${name} lock has unhashed packages`).toEqual([]);
    }
  });
});

describe('controller images install glab', () => {
  // The hub's Self-hosted (watch) checklist names vanguard-runner for GitLab workers, whose preflight and MR publish need glab.
  it('installs the same checksum-verified glab release in runner and hub images', async () => {
    const lines = async (f: string): Promise<string[]> => (await read(f)).split('\n').filter((l) => /GLAB_|glab/.test(l) && !l.startsWith('#'));
    const runner = await lines('runner.Dockerfile');
    expect(runner).toEqual(await lines('hub.Dockerfile'));
    expect(runner.join('\n')).toContain('sha256sum -c -');
    expect(runner.join('\n')).toContain('dpkg -i /tmp/glab.deb');
  });
});
