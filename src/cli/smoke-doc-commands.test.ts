import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseCli } from './args.js';

/** The smoke-test doc's `taskcell …` lines must run as written: each must parse to the intended command. */
describe('docs/smoke-tests/codex-chatgpt-proxy.md', () => {
  it('its review-pr command parses to a Codex review under --llm-proxy', async () => {
    const doc = await readFile(new URL('../../docs/smoke-tests/codex-chatgpt-proxy.md', import.meta.url), 'utf8');
    const lines = doc.split('\n').filter((l) => l.startsWith('taskcell '));
    expect(lines).toHaveLength(1);
    const argv = lines[0]!.split(/\s+/).slice(1);
    expect(parseCli(argv, '/work')).toMatchObject({ kind: 'review-pr', prRef: 'OWNER/REPO#PR', provider: 'codex', llmProxy: true, repoPath: '/path/to/clone' });
  });
});
