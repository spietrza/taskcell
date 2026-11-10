import { describe, it, expect } from 'vitest';
import { GHCR_SANDBOX_REPO, dockerDirHash, pullOrBuildSandboxImage } from './image-sync.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function fakeDocker(tagExists: boolean): { run: (cmd: string, args: string[]) => Promise<{ stdout: string }>; calls: string[][] } {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
    calls.push(args);
    if (args[0] === 'pull' && !tagExists) throw new Error('manifest unknown');
    if (args[0] === 'image') return { stdout: `${DIGEST}\n` };
    return { stdout: '' };
  };
  return { run, calls };
}

describe('pullOrBuildSandboxImage', () => {
  it('pulls when the tag exists and never builds', async () => {
    const { run, calls } = fakeDocker(true);
    const result = await pullOrBuildSandboxImage('abc123', '/repo/docker', run);
    expect(result).toEqual({ image: `${GHCR_SANDBOX_REPO}:abc123`, digest: DIGEST, built: false });
    expect(calls.map((a) => a[0])).toEqual(['pull', 'image']);
  });

  it('builds from docker/ only when the pull fails', async () => {
    const { run, calls } = fakeDocker(false);
    const result = await pullOrBuildSandboxImage('abc123', '/repo/docker', run);
    expect(result).toEqual({ image: `${GHCR_SANDBOX_REPO}:abc123`, digest: DIGEST, built: true });
    expect(calls.map((a) => a[0])).toEqual(['pull', 'build', 'image']);
    expect(calls[1]).toEqual(['build', '-t', `${GHCR_SANDBOX_REPO}:abc123`, '/repo/docker']);
  });
});

describe('dockerDirHash', () => {
  it('reads the docker/ tree hash at the ref', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      return { stdout: 'deadbeef\n' };
    };
    expect(await dockerDirHash('/repo', 'HEAD', run)).toBe('deadbeef');
    expect(calls).toEqual([['rev-parse', 'HEAD:docker']]);
  });
});
