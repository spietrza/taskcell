import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The setup skill ships in three places: .agents/skills (Codex and other agents), .claude/skills (Claude Code)
// and the website's /.well-known/agent-skills. .agents/skills is the source; the other two are copies.
const SOURCE = '.agents/skills/setup-taskcell/SKILL.md';
const COPIES = ['.claude/skills/setup-taskcell/SKILL.md', 'landing/src/.well-known/agent-skills/setup-taskcell/SKILL.md'];

describe('setup-taskcell skill', () => {
  const source = readFileSync(SOURCE, 'utf8');

  it.each(COPIES)('%s matches the source', (copy) => {
    expect(readFileSync(copy, 'utf8'), `copy ${SOURCE} over ${copy}`).toBe(source);
  });

  it('has the front matter agents need to discover it', () => {
    expect(source).toMatch(/^---\nname: setup-taskcell\ndescription: .{20,1024}\n---\n/);
  });
});
