import { describe, expect, it } from 'vitest';
import { MAX_SKILLS_USED, parseSkillsUsed } from './skills-used.js';

const j = (o: object): string => JSON.stringify(o);
const claude = [
  j({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Skill', input: { skill: 'simplify' } }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
].join('\n');
const codex = j({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .vanguard/skills/code-review/SKILL.md' } });
const codexWrapped = j({ type: 'item.completed', item: { type: 'command_execution', command: `bash -lc "sed -n '1,80p' /workspace/.vanguard/skills/ponytail/SKILL.md"` } });
const cursor = j({ type: 'tool_call', tool_call: { readToolCall: { args: { path: '/workspace/.vanguard/skills/ponytail/SKILL.md' } } } });

describe('parseSkillsUsed', () => {
  it('finds Claude Skill calls', () => expect(parseSkillsUsed(claude)).toEqual(['simplify']));
  it('finds Codex and Cursor skill-file reads', () => {
    expect(parseSkillsUsed(codex)).toEqual(['code-review']);
    expect(parseSkillsUsed(codexWrapped)).toEqual(['ponytail']);
    expect(parseSkillsUsed(cursor)).toEqual(['ponytail']);
  });
  it('finds multiple, chained and piped Codex reads', () => {
    const multiple = j({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .vanguard/skills/a/SKILL.md .vanguard/skills/b/SKILL.md' } });
    const chained = j({ type: 'item.completed', item: { type: 'command_execution', command: 'cd /workspace && cat .vanguard/skills/c/SKILL.md | head -40' } });
    const quiet = j({ type: 'item.completed', item: { type: 'command_execution', command: "bash -lc 'cat .vanguard/skills/d/SKILL.md 2>/dev/null; head -5 .vanguard/skills/e/SKILL.md 2>&1 > /dev/null'" } });
    const copied = j({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .vanguard/skills/f/SKILL.md > copy.md' } });
    expect(parseSkillsUsed([multiple, chained, quiet, copied].join('\n'))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('returns [] for unknown or garbage input', () => {
    expect(parseSkillsUsed(undefined)).toEqual([]);
    expect(parseSkillsUsed('')).toEqual([]);
    expect(parseSkillsUsed('{"a":1}\n[1,2\nnot json')).toEqual([]);
  });
  it('ignores text that only mentions a skill path', () => {
    const find = j({ type: 'item.completed', item: { type: 'command_execution', command: 'find .vanguard/skills -name SKILL.md', aggregated_output: '.vanguard/skills/a/SKILL.md\n.vanguard/skills/b/SKILL.md' } });
    const result = j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'cat .vanguard/skills/code-review/SKILL.md' }] } });
    const forged = j({ type: 'user', message: { content: [{ type: 'tool_result', content: { type: 'tool_use', name: 'Skill', input: { skill: 'forged' } } }] } });
    expect(parseSkillsUsed([find, result, forged].join('\n'))).toEqual([]);
  });
  it('drops ids that are unbounded or carry control characters', () => {
    const bad = (skill: string): string => j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
    expect(parseSkillsUsed([bad('x'.repeat(300)), bad('a\u001b[31m\nb'), bad('simplify foo bar')].join('\n'))).toEqual([]);
  });
  it('intersects with the registry and caps the result', () => {
    const calls = Array.from({ length: MAX_SKILLS_USED + 10 }, (_, i) => j({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: `skill-${String(i).padStart(2, '0')}` } }] },
    })).join('\n');
    expect(parseSkillsUsed(calls)).toHaveLength(MAX_SKILLS_USED);
    expect(parseSkillsUsed(calls, ['skill-01', 'skill-70'])).toEqual(['skill-01', 'skill-70']);
  });
});
