import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SANDBOX_HOME,
  ownerLabelArgs,
  pnpmStoreConfig,
  readOnlyTmpfsSizesMb,
  hostMemoryDefaultMb,
  READONLY_SANDBOX_MEMORY_MB,
  resolveSandboxProfile,
  sandboxResourceLimits,
  sandboxSecurityOpts,
  sidecarMemoryArgs,
} from './limits.js';

// Pin host RAM (default 8 GB ⇒ the 2048 MB floor) so memory-default assertions don't depend on the machine.
const host = vi.hoisted(() => ({ totalBytes: 8 * 1024 ** 3 }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), totalmem: (): number => host.totalBytes }));

describe('sandboxResourceLimits', () => {
  it('uses defaults when no env is set', () => {
    expect(sandboxResourceLimits({})).toEqual({ memoryMb: 2048, cpus: 2, pidsLimit: 512 });
  });

  it('omits cpus when TASKCELL_SANDBOX_CPUS=0 (kernel without CFS, e.g. Synology)', () => {
    const out = sandboxResourceLimits({ TASKCELL_SANDBOX_CPUS: '0' } as NodeJS.ProcessEnv);
    expect('cpus' in out).toBe(false);
    expect(out.memoryMb).toBe(2048);
    expect(out.pidsLimit).toBe(512);
  });

  it('overrides each limit with a positive value', () => {
    const out = sandboxResourceLimits({
      TASKCELL_SANDBOX_MEMORY_MB: '1536',
      TASKCELL_SANDBOX_CPUS: '1',
      TASKCELL_SANDBOX_PIDS: '256',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({ memoryMb: 1536, cpus: 1, pidsLimit: 256 });
  });

  it('omits a limit on an invalid or empty value', () => {
    expect('memoryMb' in sandboxResourceLimits({ TASKCELL_SANDBOX_MEMORY_MB: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect('pidsLimit' in sandboxResourceLimits({ TASKCELL_SANDBOX_PIDS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('raises the memory default only for a read-only rootfs, and an explicit value wins', () => {
    expect(sandboxResourceLimits({ TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv).memoryMb).toBe(
      READONLY_SANDBOX_MEMORY_MB,
    );
    expect(sandboxResourceLimits({ TASKCELL_SANDBOX_READONLY: '0' } as NodeJS.ProcessEnv).memoryMb).toBe(2048);
    const forced = { TASKCELL_SANDBOX_MEMORY_MB: '1536', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv;
    expect(sandboxResourceLimits(forced).memoryMb).toBe(1536);
  });
});

describe('sandboxSecurityOpts', () => {
  it('defaults to cap-drop ALL, the chown trio added back, no-new-privileges, readonly off', () => {
    expect(sandboxSecurityOpts({})).toEqual({
      capDrop: ['ALL'],
      capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
      noNewPrivileges: true,
      readOnlyRootfs: false,
      init: true,
    });
  });

  it('drops --init only when TASKCELL_SANDBOX_INIT is 0 or empty', () => {
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_INIT: '0' } as NodeJS.ProcessEnv).init).toBe(false);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_INIT: '' } as NodeJS.ProcessEnv).init).toBe(false);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_INIT: '1' } as NodeJS.ProcessEnv).init).toBe(true);
  });

  it('omits no-new-privileges when TASKCELL_SANDBOX_NO_NEW_PRIVILEGES=0', () => {
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_NO_NEW_PRIVILEGES: '0' } as NodeJS.ProcessEnv).noNewPrivileges).toBe(
      false,
    );
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_NO_NEW_PRIVILEGES: '' } as NodeJS.ProcessEnv).noNewPrivileges).toBe(
      false,
    );
  });

  it('omits cap-drop when TASKCELL_SANDBOX_CAP_DROP is empty', () => {
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_CAP_DROP: '' } as NodeJS.ProcessEnv).capDrop).toEqual([]);
  });

  it('respects a custom TASKCELL_SANDBOX_CAP_ADD list', () => {
    expect(
      sandboxSecurityOpts({ TASKCELL_SANDBOX_CAP_ADD: 'NET_BIND_SERVICE, SETGID' } as NodeJS.ProcessEnv).capAdd,
    ).toEqual(['NET_BIND_SERVICE', 'SETGID']);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_CAP_ADD: '' } as NodeJS.ProcessEnv).capAdd).toEqual([]);
  });

  it('enables readOnlyRootfs only when TASKCELL_SANDBOX_READONLY is set truthy', () => {
    expect(sandboxSecurityOpts({}).readOnlyRootfs).toBe(false);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(true);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_READONLY: 'true' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(true);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_READONLY: '0' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(false);
  });

  it('keeps readOnlyRootfs opt-in: only READONLY=1 turns it on, and an empty value counts as unset', () => {
    expect(sandboxSecurityOpts({}).readOnlyRootfs).toBe(false);
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_READONLY: '' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(false);
  });

  it('honours READONLY=1 whatever the memory limit, and ignores the limit when not opted in', () => {
    expect(sandboxSecurityOpts({ TASKCELL_SANDBOX_MEMORY_MB: '16384' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(false);
    const explicit = { TASKCELL_SANDBOX_MEMORY_MB: '0', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv;
    expect(sandboxSecurityOpts(explicit).readOnlyRootfs).toBe(true);
    const forced = { TASKCELL_SANDBOX_MEMORY_MB: '1536', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv;
    expect(sandboxSecurityOpts(forced).readOnlyRootfs).toBe(true);
  });
});

// The one resolution every runner (and the start-of-run note) goes through: one row per posture a
// real run can be in.
describe('resolveSandboxProfile', () => {
  const cases: {
    name: string;
    env: NodeJS.ProcessEnv;
    hardened: boolean;
    memoryMb: number | undefined;
    readOnlyRootfs: boolean;
    warn: boolean;
  }[] = [
    { name: 'default run', env: {}, hardened: false, memoryMb: 2048, readOnlyRootfs: false, warn: false },
    {
      name: 'egress or llm-proxy run keeps the plain default',
      env: {},
      hardened: true,
      memoryMb: 2048,
      readOnlyRootfs: false,
      warn: false,
    },
    {
      name: 'egress run with the read-only rootfs explicitly off',
      env: { TASKCELL_SANDBOX_READONLY: '0' } as NodeJS.ProcessEnv,
      hardened: true,
      memoryMb: 2048,
      readOnlyRootfs: false,
      warn: false,
    },
    {
      name: 'read-only opt-in',
      env: { TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv,
      hardened: false,
      memoryMb: READONLY_SANDBOX_MEMORY_MB,
      readOnlyRootfs: true,
      warn: false,
    },
    {
      name: 'explicit memory override',
      env: { TASKCELL_SANDBOX_MEMORY_MB: '1536' } as NodeJS.ProcessEnv,
      hardened: true,
      memoryMb: 1536,
      readOnlyRootfs: false,
      warn: false,
    },
    {
      name: 'read-only opt-in under an explicit memory override below the read-only default',
      env: { TASKCELL_SANDBOX_MEMORY_MB: '1536', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv,
      hardened: true,
      memoryMb: 1536,
      readOnlyRootfs: true,
      warn: true,
    },
    {
      name: 'read-only opt-in with the memory limit omitted',
      env: { TASKCELL_SANDBOX_MEMORY_MB: '0', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv,
      hardened: true,
      memoryMb: undefined,
      readOnlyRootfs: true,
      warn: true,
    },
  ];

  it.each(cases)('$name', ({ env, memoryMb, readOnlyRootfs, warn }) => {
    const profile = resolveSandboxProfile(env);
    expect(profile.memoryMb).toBe(memoryMb);
    expect(profile.cpus).toBe(2);
    expect(profile.pidsLimit).toBe(512);
    expect(profile.security).toEqual({ ...sandboxSecurityOpts(env), readOnlyRootfs });
    expect(profile.home).toBe(DEFAULT_SANDBOX_HOME);
    // The mounts are sized from the SAME memoryMb the profile reports, never re-derived.
    expect(profile.tmpfs).toEqual(readOnlyTmpfsSizesMb(memoryMb));
    expect(profile.note.warn).toBe(warn);
  });

  it('reports the rootfs off and how to opt in when TASKCELL_SANDBOX_READONLY is unset or empty, without warning', () => {
    for (const env of [{}, { TASKCELL_SANDBOX_READONLY: '' }, { TASKCELL_SANDBOX_MEMORY_MB: '1536' }] as NodeJS.ProcessEnv[]) {
      const note = resolveSandboxProfile(env).note;
      expect(note.warn).toBe(false);
      expect(note.message).toContain('read-only rootfs off (opt-in: TASKCELL_SANDBOX_READONLY=1');
      expect(note.message).toContain('8192');
    }
  });

  it('warns when the rootfs is forced on with no memory limit, or under less than the read-only default', () => {
    const unbounded = resolveSandboxProfile({ TASKCELL_SANDBOX_MEMORY_MB: '0', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv).note;
    expect(unbounded.warn).toBe(true);
    expect(unbounded.message).toContain('4096/2048/1024 MB');
    expect(unbounded.message).toContain('OOM');
    const small = resolveSandboxProfile({ TASKCELL_SANDBOX_MEMORY_MB: '1536', TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv).note;
    expect(small.warn).toBe(true);
    expect(small.message).toContain(`below ${READONLY_SANDBOX_MEMORY_MB}`);
    expect(small.message).toContain('ENOSPC');
    expect(small.message).toContain('OOM');
    // At the read-only default the mounts fit: on, no warning.
    const sized = resolveSandboxProfile({ TASKCELL_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv).note;
    expect(sized).toEqual({ warn: false, message: expect.stringContaining('read-only rootfs on') });
    const off = resolveSandboxProfile({ TASKCELL_SANDBOX_READONLY: '0' } as NodeJS.ProcessEnv).note;
    expect(off).toEqual({ warn: false, message: expect.stringContaining('read-only rootfs off') });
  });
});

describe('readOnlyTmpfsSizesMb', () => {
  it('sizes the three mounts 3:2:1 within three quarters of the memory limit (tmpfs is charged to it)', () => {
    expect(readOnlyTmpfsSizesMb(2048)).toEqual({ workspace: 768, home: 512, tmp: 256 });
    // The read-only default: 3 GB workspace, 2 GB $HOME (pnpm store), 1 GB /tmp, 2 GB left for processes.
    expect(readOnlyTmpfsSizesMb(READONLY_SANDBOX_MEMORY_MB)).toEqual({ workspace: 3072, home: 2048, tmp: 1024 });
  });

  it('scales with a raised TASKCELL_SANDBOX_MEMORY_MB and stays inside a lowered one', () => {
    for (const memoryMb of [1024, 1536, 2048, 4096, 8192]) {
      const sizes = readOnlyTmpfsSizesMb(memoryMb);
      expect(sizes.workspace + sizes.home + sizes.tmp).toBeLessThanOrEqual(memoryMb);
      expect(sizes.tmp).toBeGreaterThan(0);
    }
    expect(readOnlyTmpfsSizesMb(8192).workspace).toBe(3072);
  });

  it('never yields size=0 (which tmpfs reads as unlimited) on an absurdly small limit', () => {
    expect(readOnlyTmpfsSizesMb(1)).toEqual({ workspace: 3, home: 2, tmp: 1 });
  });

  it('falls back to fixed sizes with the memory limit omitted (TASKCELL_SANDBOX_MEMORY_MB=0)', () => {
    expect(readOnlyTmpfsSizesMb(undefined)).toEqual({ workspace: 4096, home: 2048, tmp: 1024 });
  });
});

describe('sidecarMemoryArgs', () => {
  it('defaults to 256m', () => {
    expect(sidecarMemoryArgs({})).toEqual(['--memory', '256m']);
  });
  it('overrides with TASKCELL_SIDECAR_MEMORY_MB', () => {
    expect(sidecarMemoryArgs({ TASKCELL_SIDECAR_MEMORY_MB: '128' } as NodeJS.ProcessEnv)).toEqual(['--memory', '128m']);
  });
  it('omits the cap on 0 / invalid', () => {
    expect(sidecarMemoryArgs({ TASKCELL_SIDECAR_MEMORY_MB: '0' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(sidecarMemoryArgs({ TASKCELL_SIDECAR_MEMORY_MB: 'off' } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('ownerLabelArgs', () => {
  it('returns nothing when TASKCELL_OWNER_LABEL is unset', () => {
    expect(ownerLabelArgs({})).toEqual([]);
  });

  it('returns nothing when TASKCELL_OWNER_LABEL is empty', () => {
    expect(ownerLabelArgs({ TASKCELL_OWNER_LABEL: '' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('returns the label flag when TASKCELL_OWNER_LABEL is set', () => {
    expect(ownerLabelArgs({ TASKCELL_OWNER_LABEL: 'ci-job-42' } as NodeJS.ProcessEnv)).toEqual([
      '--label',
      'vanguard.owner=ci-job-42',
    ]);
  });
});

describe('pnpmStoreConfig', () => {
  it('is off unless --pnpm-store or TASKCELL_PNPM_STORE opts in', () => {
    expect(pnpmStoreConfig('/repo', undefined, {})).toBeUndefined();
    expect(pnpmStoreConfig('/repo', undefined, { TASKCELL_PNPM_STORE: '0' })).toBeUndefined();
    expect(pnpmStoreConfig('/repo', undefined, { TASKCELL_PNPM_STORE: '' })).toBeUndefined();
    expect(pnpmStoreConfig('/repo', true, {})).toEqual({ repoKey: '/repo' });
    expect(pnpmStoreConfig('/repo', undefined, { TASKCELL_PNPM_STORE: '1' })).toEqual({ repoKey: '/repo' });
    expect(pnpmStoreConfig('/repo', undefined, { TASKCELL_PNPM_STORE: 'true' })).toEqual({ repoKey: '/repo' });
  });

  it('bind-mounts TASKCELL_PNPM_STORE_DIR when set, only once enabled', () => {
    expect(pnpmStoreConfig('/repo', true, { TASKCELL_PNPM_STORE_DIR: '/cache/pnpm' })).toEqual({ repoKey: '/repo', hostDir: '/cache/pnpm' });
    expect(pnpmStoreConfig('/repo', true, { TASKCELL_PNPM_STORE_DIR: '' })).toEqual({ repoKey: '/repo' });
    expect(pnpmStoreConfig('/repo', undefined, { TASKCELL_PNPM_STORE_DIR: '/cache/pnpm' })).toBeUndefined();
  });
});

describe('hostMemoryDefaultMb', () => {
  const GB = 1024 ** 3;
  it('clamps totalmem/4 to 2048..4096', () => {
    expect(hostMemoryDefaultMb(16 * GB)).toBe(4096);
    expect(hostMemoryDefaultMb(16_759_439_360)).toBe(4096); // a real "16 GB" runner reports a bit under 16 GiB
    expect(hostMemoryDefaultMb(8 * GB)).toBe(2048);
    expect(hostMemoryDefaultMb(4 * GB)).toBe(2048);
    expect(hostMemoryDefaultMb(64 * GB)).toBe(4096);
  });
  it('is what sandboxResourceLimits uses when unset, and an explicit value wins', () => {
    host.totalBytes = 16 * GB;
    try {
      expect(sandboxResourceLimits({}).memoryMb).toBe(4096);
      expect(sandboxResourceLimits({ TASKCELL_SANDBOX_MEMORY_MB: '1536' } as NodeJS.ProcessEnv).memoryMb).toBe(1536);
    } finally {
      host.totalBytes = 8 * GB;
    }
    expect(sandboxResourceLimits({}).memoryMb).toBe(2048);
  });
});
