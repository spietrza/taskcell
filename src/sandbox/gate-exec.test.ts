import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { gateExec } from './gate-exec.js';
import type { ExecOptions, IsolatedSandboxProvider } from './provider.js';

describe('gateExec', () => {
  it('always passes loginShell: false, keeping the caller options', async () => {
    const seen: (ExecOptions | undefined)[] = [];
    const sandbox = { exec: async (_c: string, o?: ExecOptions) => { seen.push(o); return { stdout: '', stderr: '', exitCode: 0 }; } } as unknown as IsolatedSandboxProvider;
    await gateExec(sandbox)('x', { cwd: '/w' });
    await gateExec(sandbox)('y');
    expect(seen).toEqual([{ cwd: '/w', loginShell: false }, { loginShell: false }]);
  });

  it('gate modules never call the sandbox directly (#1187)', async () => {
    for (const file of ['../pipeline/verify.ts', '../pipeline/visual-proof.ts']) {
      const src = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(src, file).toContain('gateExec(');
      expect(src, file).not.toMatch(/sandbox\.exec(Stream)?\b|loginShell/);
    }
  });
});
